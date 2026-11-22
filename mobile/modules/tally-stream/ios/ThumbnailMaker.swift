//
//  ThumbnailMaker.swift
//  TallyStream
//
//  Low-rate JPEG thumbnails from capture frames for the hub's framing grid, up to 15 fps.
//  Throttled to an interval, one in flight at a time (frames are dropped while busy),
//  GPU downscale via VTPixelTransferSession, then the hardware JPEG encoder
//  (VideoToolbox 'jpeg'), with ImageIO as the fallback. Never blocks the capture queue.
//

import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import ImageIO
import VideoToolbox

final class ThumbnailMaker {
  struct Options {
    var intervalMs: Double
    var maxWidth: Int
    var quality: Double
  }

  static let maxFps = 15.0
  static let minIntervalMs = 1000.0 / maxFps

  /// (jpeg, width, height), called on an internal background queue.
  var onThumbnail: ((Data, Int, Int) -> Void)?
  /// Test hook: set false to force the ImageIO path.
  var preferHardwareJPEG = true
  /// Which encoder produced the last thumbnail.
  private(set) var usingHardwareJPEG = false

  private let queue = DispatchQueue(label: "com.tally.stream.thumbnail", qos: .utility)
  private let lock = NSLock()
  private var options: Options?
  private var busy = false
  private var nextDue: CFAbsoluteTime = 0

  // queue only
  private var transfer: VTPixelTransferSession?
  private var pool: CVPixelBufferPool?
  private var poolSize = (width: 0, height: 0)
  private var jpegSession: VTCompressionSession?
  private var jpegSessionSize = (width: 0, height: 0)
  private var jpegSessionQuality = -1.0
  private var jpegFrameCount: Int64 = 0
  private var hardwareJPEGFailed = false

  deinit {
    if let jpegSession { VTCompressionSessionInvalidate(jpegSession) }
    if let transfer { VTPixelTransferSessionInvalidate(transfer) }
  }

  var isEnabled: Bool {
    lock.lock()
    defer { lock.unlock() }
    return options != nil
  }

  func start(_ newOptions: Options) {
    lock.lock()
    options = Options(
      intervalMs: max(ThumbnailMaker.minIntervalMs, newOptions.intervalMs),
      maxWidth: max(64, min(1920, newOptions.maxWidth)),
      quality: min(1, max(0.1, newOptions.quality)))
    nextDue = 0
    lock.unlock()
  }

  func stop() {
    lock.lock()
    options = nil
    lock.unlock()
  }

  /// Takes effect on the next frame.
  func setInterval(_ ms: Double) {
    lock.lock()
    options?.intervalMs = max(ThumbnailMaker.minIntervalMs, ms)
    lock.unlock()
  }

  /// Cheap check + hand-off; called on the capture queue for every frame.
  func offer(_ pixelBuffer: CVPixelBuffer) {
    lock.lock()
    guard let options, !busy else {
      lock.unlock()
      return
    }
    let now = CFAbsoluteTimeGetCurrent()
    if now < nextDue {
      lock.unlock()
      return
    }
    // Fixed schedule (not "interval after the last one"), so the average rate matches the
    // requested interval instead of rounding up to whole camera frames; re-anchor after a stall.
    let interval = options.intervalMs / 1000
    nextDue = now - nextDue > interval ? now + interval : nextDue + interval
    busy = true
    lock.unlock()

    queue.async { [weak self] in
      guard let self else { return }
      defer {
        self.lock.lock()
        self.busy = false
        self.lock.unlock()
      }
      if let (jpeg, width, height) = self.makeJPEG(pixelBuffer, options: options) {
        self.onThumbnail?(jpeg, width, height)
      }
    }
  }

  private func makeJPEG(_ input: CVPixelBuffer, options: Options) -> (Data, Int, Int)? {
    let inW = CVPixelBufferGetWidth(input)
    let inH = CVPixelBufferGetHeight(input)
    guard inW > 0, inH > 0 else { return nil }
    let scale = min(1.0, Double(options.maxWidth) / Double(max(inW, inH)))
    let outW = max(2, Int(Double(inW) * scale) & ~1)
    let outH = max(2, Int(Double(inH) * scale) & ~1)
    guard let scaled = downscale(input, to: outW, height: outH) else { return nil }

    if preferHardwareJPEG, !hardwareJPEGFailed, let data = hardwareJPEG(scaled, quality: options.quality) {
      usingHardwareJPEG = true
      return (data, outW, outH)
    }
    hardwareJPEGFailed = hardwareJPEGFailed || preferHardwareJPEG
    usingHardwareJPEG = false
    guard let data = softwareJPEG(scaled, quality: options.quality) else { return nil }
    return (data, outW, outH)
  }

  // MARK: - GPU downscale (NV12 -> NV12)

  private func downscale(_ input: CVPixelBuffer, to width: Int, height: Int) -> CVPixelBuffer? {
    if transfer == nil {
      var created: VTPixelTransferSession?
      guard VTPixelTransferSessionCreate(allocator: kCFAllocatorDefault, pixelTransferSessionOut: &created) == noErr,
            let created
      else { return nil }
      VTSessionSetProperty(created, key: kVTPixelTransferPropertyKey_ScalingMode, value: kVTScalingMode_Normal)
      VTSessionSetProperty(created, key: kVTPixelTransferPropertyKey_RealTime, value: kCFBooleanTrue)
      transfer = created
    }
    if pool == nil || poolSize.width != width || poolSize.height != height {
      let attributes: [CFString: Any] = [
        kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
        kCVPixelBufferWidthKey: width,
        kCVPixelBufferHeightKey: height,
        kCVPixelBufferIOSurfacePropertiesKey: [:] as [CFString: Any],
      ]
      var created: CVPixelBufferPool?
      CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attributes as CFDictionary, &created)
      pool = created
      poolSize = (width, height)
    }
    guard let transfer, let pool else { return nil }
    var scaled: CVPixelBuffer?
    guard CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &scaled) == kCVReturnSuccess,
          let scaled,
          VTPixelTransferSessionTransferImage(transfer, from: input, to: scaled) == noErr
    else { return nil }
    return scaled
  }

  // MARK: - JPEG: VideoToolbox hardware encoder

  private final class DataBox {
    var data: Data?
  }

  private func hardwareJPEG(_ buffer: CVPixelBuffer, quality: Double) -> Data? {
    let width = CVPixelBufferGetWidth(buffer)
    let height = CVPixelBufferGetHeight(buffer)
    if jpegSession == nil || jpegSessionSize.width != width || jpegSessionSize.height != height {
      if let jpegSession { VTCompressionSessionInvalidate(jpegSession) }
      jpegSession = nil
      var created: VTCompressionSession?
      let status = VTCompressionSessionCreate(
        allocator: kCFAllocatorDefault, width: Int32(width), height: Int32(height), codecType: kCMVideoCodecType_JPEG,
        encoderSpecification: nil, imageBufferAttributes: nil, compressedDataAllocator: nil,
        outputCallback: nil, refcon: nil, compressionSessionOut: &created)
      guard status == noErr, let created else { return nil }
      VTSessionSetProperty(created, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
      jpegSession = created
      jpegSessionSize = (width, height)
      jpegSessionQuality = -1
    }
    guard let session = jpegSession else { return nil }
    if jpegSessionQuality != quality {
      VTSessionSetProperty(session, key: kVTCompressionPropertyKey_Quality, value: NSNumber(value: quality))
      jpegSessionQuality = quality
    }

    let box = DataBox()
    jpegFrameCount += 1
    let status = VTCompressionSessionEncodeFrame(
      session, imageBuffer: buffer, presentationTimeStamp: CMTime(value: jpegFrameCount, timescale: 30),
      duration: .invalid, frameProperties: nil, infoFlagsOut: nil
    ) { status, _, sampleBuffer in
      guard status == noErr, let sampleBuffer, let block = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
      let total = CMBlockBufferGetDataLength(block)
      guard total > 0 else { return }
      var data = Data(count: total)
      let ok = data.withUnsafeMutableBytes { raw -> Bool in
        guard let base = raw.baseAddress else { return false }
        return CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: total, destination: base) == kCMBlockBufferNoErr
      }
      if ok { box.data = data }
    }
    guard status == noErr else { return nil }
    // Synchronous flush: the output handler has run by the time this returns.
    VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
    return box.data
  }

  // MARK: - JPEG: ImageIO fallback

  private func softwareJPEG(_ buffer: CVPixelBuffer, quality: Double) -> Data? {
    var image: CGImage?
    guard VTCreateCGImageFromCVPixelBuffer(buffer, options: nil, imageOut: &image) == noErr, let image else {
      return nil
    }
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, "public.jpeg" as CFString, 1, nil) else {
      return nil
    }
    CGImageDestinationAddImage(
      destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { return nil }
    return data as Data
  }
}
