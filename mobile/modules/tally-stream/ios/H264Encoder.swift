//
//  H264Encoder.swift
//  TallyStream
//
//  Hardware H.264 via VideoToolbox: real-time, no B-frames, ~CBR, fixed GOP, selectable profile.
//  Scales/crops any input size to the target size with VTPixelTransferSession (GPU).
//  Output is Annex-B access units; SPS/PPS are repeated before every IDR so a receiver
//  (MediaMTX -> WebRTC, or OBS after a reconnect) can start decoding at any keyframe.
//

import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

/// H.264 profile, independent of the Nitro-generated enum so the core is testable on macOS.
enum StreamProfile: String {
  case baseline, main, high
}

final class H264Encoder {
  typealias Output = (_ accessUnit: Data, _ pts: CMTime, _ isKeyframe: Bool, _ profile: StreamProfile?) -> Void

  let width: Int32
  let height: Int32
  let profile: StreamProfile
  private var session: VTCompressionSession?
  private var transfer: VTPixelTransferSession?
  private var pool: CVPixelBufferPool?
  private var fps: Double
  private var bitrateKbps: Double
  private let keyframeIntervalSec: Double
  private var forceKeyframe = true
  private var lowLatency = true
  private var consecutiveFailures = 0
  private var appliedProfile: StreamProfile?
  private let onOutput: Output

  private static let startCode: [UInt8] = [0x00, 0x00, 0x00, 0x01]
  private static let accessUnitDelimiter: [UInt8] = [0x00, 0x00, 0x00, 0x01, 0x09, 0xF0]

  init(width: Int32, height: Int32, fps: Double, bitrateKbps: Double, keyframeIntervalSec: Double,
       profile: StreamProfile, onOutput: @escaping Output) throws {
    self.width = width
    self.height = height
    self.fps = fps
    self.bitrateKbps = bitrateKbps
    self.keyframeIntervalSec = max(0.5, keyframeIntervalSec)
    self.profile = profile
    self.onOutput = onOutput
    try createSession(lowLatency: true)
  }

  deinit {
    invalidate()
  }

  func invalidate() {
    if let session {
      VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
      VTCompressionSessionInvalidate(session)
    }
    session = nil
    if let transfer {
      VTPixelTransferSessionInvalidate(transfer)
    }
    transfer = nil
    pool = nil
  }

  func requestKeyframe() {
    forceKeyframe = true
  }

  func setBitrate(kbps: Double) {
    bitrateKbps = kbps
    guard let session else { return }
    applyBitrate(session)
  }

  func setExpectedFps(_ value: Double) {
    fps = value
    guard let session else { return }
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: NSNumber(value: fps))
  }

  /// Encodes one frame. Must be called serially (one queue).
  func encode(_ input: CVPixelBuffer, pts: CMTime) {
    guard let session else { return }
    guard let buffer = scaledIfNeeded(input) else { return }
    var properties: CFDictionary?
    if forceKeyframe {
      properties = [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue] as CFDictionary
      forceKeyframe = false
    }
    let status = VTCompressionSessionEncodeFrame(
      session,
      imageBuffer: buffer,
      presentationTimeStamp: pts,
      duration: .invalid,
      frameProperties: properties,
      infoFlagsOut: nil
    ) { [weak self] status, _, sampleBuffer in
      guard let self, status == noErr, let sampleBuffer else { return }
      self.handle(sampleBuffer)
    }
    if status != noErr {
      // A failed frame is skipped; ask for a keyframe so the stream recovers cleanly.
      forceKeyframe = true
      consecutiveFailures += 1
      if consecutiveFailures >= 3, lowLatency {
        // The low-latency encoder rejected this profile/size: fall back to the standard encoder once.
        invalidate()
        try? createSession(lowLatency: false)
      }
    } else {
      consecutiveFailures = 0
    }
  }

  // MARK: - Setup

  private func createSession(lowLatency wantLowLatency: Bool) throws {
    var created: VTCompressionSession?
    var status: OSStatus = noErr
    var usingLowLatency = false
    if wantLowLatency {
      // Apple's low-latency rate control: no frame reordering, tight CBR-like output.
      let spec: [CFString: Any] = [kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true]
      status = VTCompressionSessionCreate(
        allocator: kCFAllocatorDefault, width: width, height: height, codecType: kCMVideoCodecType_H264,
        encoderSpecification: spec as CFDictionary, imageBufferAttributes: nil, compressedDataAllocator: nil,
        outputCallback: nil, refcon: nil, compressionSessionOut: &created)
      usingLowLatency = status == noErr
    }
    if created == nil {
      status = VTCompressionSessionCreate(
        allocator: kCFAllocatorDefault, width: width, height: height, codecType: kCMVideoCodecType_H264,
        encoderSpecification: nil, imageBufferAttributes: nil, compressedDataAllocator: nil,
        outputCallback: nil, refcon: nil, compressionSessionOut: &created)
    }
    guard status == noErr, let session = created else {
      throw NSError(domain: "TallyStream", code: Int(status),
                    userInfo: [NSLocalizedDescriptionKey: "VTCompressionSessionCreate failed (\(status))"])
    }
    lowLatency = usingLowLatency
    consecutiveFailures = 0
    forceKeyframe = true

    func set(_ key: CFString, _ value: Any) {
      VTSessionSetProperty(session, key: key, value: value as CFTypeRef)
    }
    set(kVTCompressionPropertyKey_RealTime, kCFBooleanTrue as Any)
    set(kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse as Any)  // no B-frames
    applyProfile(session, lowLatency: usingLowLatency)
    set(kVTCompressionPropertyKey_ExpectedFrameRate, NSNumber(value: fps))
    set(kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, NSNumber(value: keyframeIntervalSec))
    set(kVTCompressionPropertyKey_MaxKeyFrameInterval, NSNumber(value: Int(max(1, (fps * keyframeIntervalSec).rounded()))))
    applyBitrate(session)
    VTCompressionSessionPrepareToEncodeFrames(session)
    self.session = session
  }

  /// Tries the requested profile first, then the closest alternatives the encoder accepts.
  /// The SPS of the first keyframe reports what was really applied (see `appliedProfile`).
  private func applyProfile(_ session: VTCompressionSession, lowLatency: Bool) {
    let candidates: [CFString]
    switch profile {
    case .baseline:
      candidates = [kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel, kVTProfileLevel_H264_Baseline_AutoLevel,
                    kVTProfileLevel_H264_Main_AutoLevel]
    case .main:
      candidates = [kVTProfileLevel_H264_Main_AutoLevel, kVTProfileLevel_H264_High_AutoLevel]
    case .high:
      candidates = lowLatency
        ? [kVTProfileLevel_H264_ConstrainedHigh_AutoLevel, kVTProfileLevel_H264_High_AutoLevel]
        : [kVTProfileLevel_H264_High_AutoLevel, kVTProfileLevel_H264_Main_AutoLevel]
    }
    for candidate in candidates
    where VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel, value: candidate) == noErr {
      break
    }
    // Baseline forbids CABAC.
    let entropy = profile == .baseline ? kVTH264EntropyMode_CAVLC : kVTH264EntropyMode_CABAC
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_H264EntropyMode, value: entropy)
  }

  private func applyBitrate(_ session: VTCompressionSession) {
    let bps = max(500_000, bitrateKbps * 1000)
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: NSNumber(value: Int(bps)))
    // Hard ceiling: 1.5x average per second, in bytes - keeps Wi-Fi bursts in check.
    let limits: [NSNumber] = [NSNumber(value: Int(bps * 1.5 / 8)), NSNumber(value: 1)]
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_DataRateLimits, value: limits as CFArray)
  }

  private func scaledIfNeeded(_ input: CVPixelBuffer) -> CVPixelBuffer? {
    let inW = CVPixelBufferGetWidth(input)
    let inH = CVPixelBufferGetHeight(input)
    if inW == Int(width) && inH == Int(height) {
      return input
    }
    if transfer == nil {
      var created: VTPixelTransferSession?
      guard VTPixelTransferSessionCreate(allocator: kCFAllocatorDefault, pixelTransferSessionOut: &created) == noErr,
            let created
      else { return nil }
      // Fill the target frame, cropping the excess (e.g. 4:3 sensor format -> 16:9 stream).
      VTSessionSetProperty(created, key: kVTPixelTransferPropertyKey_ScalingMode, value: kVTScalingMode_Trim)
      VTSessionSetProperty(created, key: kVTPixelTransferPropertyKey_RealTime, value: kCFBooleanTrue)
      transfer = created
    }
    if pool == nil {
      let attributes: [CFString: Any] = [
        kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
        kCVPixelBufferWidthKey: Int(width),
        kCVPixelBufferHeightKey: Int(height),
        kCVPixelBufferIOSurfacePropertiesKey: [:] as [CFString: Any],
      ]
      var created: CVPixelBufferPool?
      CVPixelBufferPoolCreate(kCFAllocatorDefault,
                              [kCVPixelBufferPoolMinimumBufferCountKey: 4] as CFDictionary,
                              attributes as CFDictionary, &created)
      pool = created
    }
    guard let pool, let transfer else { return nil }
    var output: CVPixelBuffer?
    guard CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &output) == kCVReturnSuccess,
          let output
    else { return nil }
    guard VTPixelTransferSessionTransferImage(transfer, from: input, to: output) == noErr else { return nil }
    return output
  }

  // MARK: - Output: AVCC -> Annex-B

  private func handle(_ sampleBuffer: CMSampleBuffer) {
    guard let dataBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
    let isKeyframe = H264Encoder.isKeyframe(sampleBuffer)

    var accessUnit = Data()
    accessUnit.append(contentsOf: H264Encoder.accessUnitDelimiter)
    if isKeyframe, let format = CMSampleBufferGetFormatDescription(sampleBuffer) {
      // SPS + PPS before every IDR.
      let sets = H264Encoder.parameterSets(format)
      if appliedProfile == nil, let sps = sets.first {
        appliedProfile = H264Encoder.profile(fromSPS: sps)
      }
      for parameterSet in sets {
        accessUnit.append(contentsOf: H264Encoder.startCode)
        accessUnit.append(parameterSet)
      }
    }

    // VideoToolbox emits 4-byte big-endian length prefixes (AVCC); the block buffer may be non-contiguous.
    let total = CMBlockBufferGetDataLength(dataBuffer)
    guard total > 4 else { return }
    var avcc = Data(count: total)
    let copied = avcc.withUnsafeMutableBytes { raw -> Bool in
      guard let base = raw.baseAddress else { return false }
      return CMBlockBufferCopyDataBytes(dataBuffer, atOffset: 0, dataLength: total, destination: base) == kCMBlockBufferNoErr
    }
    guard copied else { return }
    avcc.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
      let bytes = raw.bindMemory(to: UInt8.self)
      var offset = 0
      while offset + 4 <= total {
        let length = Int(bytes[offset]) << 24 | Int(bytes[offset + 1]) << 16
          | Int(bytes[offset + 2]) << 8 | Int(bytes[offset + 3])
        offset += 4
        guard length > 0, offset + length <= total else { break }
        accessUnit.append(contentsOf: H264Encoder.startCode)
        accessUnit.append(bytes.baseAddress! + offset, count: length)
        offset += length
      }
    }
    onOutput(accessUnit, CMSampleBufferGetPresentationTimeStamp(sampleBuffer), isKeyframe, appliedProfile)
  }

  private static func isKeyframe(_ sampleBuffer: CMSampleBuffer) -> Bool {
    guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
            as? [[CFString: Any]],
          let first = attachments.first
    else { return true }
    return (first[kCMSampleAttachmentKey_NotSync] as? Bool) != true
  }

  private static func parameterSets(_ format: CMFormatDescription) -> [Data] {
    var count = 0
    guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
      format, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil,
      parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil) == noErr
    else { return [] }
    var sets: [Data] = []
    for index in 0..<count {
      var pointer: UnsafePointer<UInt8>?
      var size = 0
      if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
        format, parameterSetIndex: index, parameterSetPointerOut: &pointer, parameterSetSizeOut: &size,
        parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr, let pointer {
        sets.append(Data(bytes: pointer, count: size))
      }
    }
    return sets
  }

  /// profile_idc is the byte after the SPS NAL header (66 baseline, 77 main, 100+ high family).
  static func profile(fromSPS sps: Data) -> StreamProfile? {
    guard sps.count >= 2 else { return nil }
    switch sps[sps.startIndex + 1] {
    case 66: return .baseline
    case 77: return .main
    case 100, 110, 122, 244: return .high
    default: return nil
    }
  }
}
