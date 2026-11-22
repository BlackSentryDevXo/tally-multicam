//
//  HybridLiveStreamOutput.swift
//  TallyStream
//
//  A VisionCamera v5 custom CameraOutput: an AVCaptureVideoDataOutput that feeds the
//  LiveStreamer (SRT feed + thumbnails). It does not influence format selection
//  (`.any`), so the local recording keeps driving resolution/fps. It asks AVFoundation
//  for buffers already downsized to the stream target (the ISP scales them), so a 720p
//  monitor stream never scales 4K frames itself.
//

import AVFoundation
import Foundation
import NitroModules
import VisionCamera

final class HybridLiveStreamOutput: HybridCameraOutputSpec, NativeCameraOutput {
  let output: AVCaptureVideoDataOutput
  let requiresAudioInput: Bool = false
  let requiresDepthFormat: Bool = false
  let mediaType: MediaType = .video
  let streamType: StreamType = .video
  var targetResolution: ResolutionRule { .any }

  private let streamer: HybridLiveStreamer
  private let queue = DispatchQueue(label: "com.tally.stream.capture", qos: .userInitiated)
  private let delegate: SampleDelegate
  private let targetLongestEdge: Int
  private static let pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarFullRange

  var outputOrientation: CameraOrientation = .up {
    didSet {
      applyConnectionSettings()
      applyBufferDimensions()
    }
  }

  var currentResolution: Size? {
    return output.connection(with: .video)?.inputStreamResolution
  }

  init(streamer: HybridLiveStreamer, targetWidth: Double, targetHeight: Double) {
    self.streamer = streamer
    self.output = AVCaptureVideoDataOutput()
    self.delegate = SampleDelegate()
    self.targetLongestEdge = Int(max(targetWidth, targetHeight))
    super.init()

    // NV12 full range: what VideoToolbox (H.264 and JPEG) encodes natively, no conversion.
    output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: HybridLiveStreamOutput.pixelFormat]
    output.alwaysDiscardsLateVideoFrames = true

    delegate.onSample = { [weak streamer] sampleBuffer in
      guard let streamer, let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
      streamer.process(pixelBuffer, pts: CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
    }
    output.setSampleBufferDelegate(delegate, queue: queue)

    streamer.onDemandChanged = { [weak self] needed in
      self?.setConnectionEnabled(needed)
    }
  }

  /// Called by VisionCamera inside beginConfiguration/commitConfiguration once connected.
  func configure(config: OutputConfiguration) {
    applyConnectionSettings()
    applyBufferDimensions()
  }

  private func applyConnectionSettings() {
    guard let connection = output.connection(with: .video) else { return }
    // Upright frames for OBS/thumbnails, matching how the operator holds the phone.
    if connection.isVideoOrientationSupported {
      connection.videoOrientation = HybridLiveStreamOutput.avOrientation(outputOrientation)
    }
    // Never mirror the program feed.
    if connection.isVideoMirroringSupported {
      connection.automaticallyAdjustsVideoMirroring = false
      connection.isVideoMirrored = false
    }
    if connection.isVideoStabilizationSupported {
      connection.preferredVideoStabilizationMode = .off  // lowest latency
    }
    connection.isEnabled = streamer.wantsFrames
  }

  /// Requests output buffers downsized to the target (exact source aspect ratio, orientation-aware).
  /// AVFoundation throws NSInvalidArgumentException for anything it dislikes, so this runs under
  /// an ObjC try/catch and falls back to preview-sized buffers, then to full-size ones.
  private func applyBufferDimensions() {
    guard let connection = output.connection(with: .video),
          let device = (connection.inputPorts.first?.input as? AVCaptureDeviceInput)?.device
    else { return }
    let dims = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
    var sourceW = Int(dims.width)
    var sourceH = Int(dims.height)
    guard sourceW > 0, sourceH > 0 else { return }
    let portrait = connection.isVideoOrientationSupported
      && (connection.videoOrientation == .portrait || connection.videoOrientation == .portraitUpsideDown)
    if portrait { swap(&sourceW, &sourceH) }

    var requested: (width: Int, height: Int)?
    if targetLongestEdge < max(sourceW, sourceH) {
      // Largest size <= target with exactly the source aspect ratio and even dimensions.
      let g = HybridLiveStreamOutput.gcd(sourceW, sourceH)
      let unitW = sourceW / g
      let unitH = sourceH / g
      var k = targetLongestEdge / max(unitW, unitH)
      while k > 0 && ((unitW * k) % 2 != 0 || (unitH * k) % 2 != 0) { k -= 1 }
      if k > 0, unitW * k >= 160, unitH * k >= 160 {
        requested = (unitW * k, unitH * k)
      }
    }

    let formatOnly: [String: Any] = [kCVPixelBufferPixelFormatTypeKey as String: HybridLiveStreamOutput.pixelFormat]
    if let requested {
      let settings: [String: Any] = [
        kCVPixelBufferPixelFormatTypeKey as String: HybridLiveStreamOutput.pixelFormat,
        kCVPixelBufferWidthKey as String: requested.width,
        kCVPixelBufferHeightKey as String: requested.height,
      ]
      let error = TallyTryCatch {
        self.output.automaticallyConfiguresOutputBufferDimensions = false
        self.output.deliversPreviewSizedOutputBuffers = false
        self.output.videoSettings = settings
      }
      if error == nil { return }
      NSLog("[TallyStream] exact buffer size %dx%d refused (%@); using preview-sized buffers",
            requested.width, requested.height, error!)
    }
    // Preview-sized (roughly screen-sized) buffers: still far cheaper than full 4K.
    let error = TallyTryCatch {
      self.output.videoSettings = formatOnly
      self.output.automaticallyConfiguresOutputBufferDimensions = false
      self.output.deliversPreviewSizedOutputBuffers = true
    }
    if let error {
      NSLog("[TallyStream] preview-sized buffers refused (%@); using full-size buffers", error)
      _ = TallyTryCatch {
        self.output.videoSettings = formatOnly
        self.output.automaticallyConfiguresOutputBufferDimensions = true
      }
    }
  }

  private func setConnectionEnabled(_ enabled: Bool) {
    // When neither the stream nor thumbnails need frames, stop delivery entirely (saves power/heat).
    queue.async { [weak self] in
      guard let connection = self?.output.connection(with: .video) else { return }
      if connection.isEnabled != enabled {
        connection.isEnabled = enabled
      }
    }
  }

  /// Mirrors VisionCamera's internal mapping (AV+CameraOrientation.swift).
  private static func avOrientation(_ orientation: CameraOrientation) -> AVCaptureVideoOrientation {
    switch orientation {
    case .up: return .portrait
    case .down: return .portraitUpsideDown
    case .left: return .landscapeRight
    case .right: return .landscapeLeft
    }
  }

  private static func gcd(_ a: Int, _ b: Int) -> Int {
    var x = a
    var y = b
    while y != 0 { (x, y) = (y, x % y) }
    return max(1, x)
  }
}

private final class SampleDelegate: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
  var onSample: ((CMSampleBuffer) -> Void)?

  func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer,
                     from connection: AVCaptureConnection) {
    onSample?(sampleBuffer)
  }
}
