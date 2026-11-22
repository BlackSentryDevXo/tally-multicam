//
//  HybridLiveStreamer.swift
//  TallyStream
//
//  Nitro facade over StreamEngine (live SRT feed) + ThumbnailMaker (hub previews).
//  Frames arrive from HybridLiveStreamOutput on the capture queue.
//

import CoreMedia
import CoreVideo
import Foundation
import NitroModules

final class HybridLiveStreamer: HybridLiveStreamerSpec {
  private let engine = StreamEngine()
  private let thumbnails = ThumbnailMaker()
  private let lock = NSLock()
  private var stateListener: ((LiveStreamStats) -> Void)?
  private var thumbnailListener: ((ArrayBuffer, Double, Double) -> Void)?

  /// Set by the output: called whenever frames start/stop being needed, so the capture
  /// connection can be disabled entirely when neither the stream nor thumbnails are on.
  var onDemandChanged: ((Bool) -> Void)?

  override init() {
    super.init()
    engine.onStateChange = { [weak self] snapshot in
      guard let self else { return }
      self.lock.lock()
      let listener = self.stateListener
      self.lock.unlock()
      listener?(HybridLiveStreamer.stats(from: snapshot))
    }
    thumbnails.onThumbnail = { [weak self] jpeg, width, height in
      guard let self else { return }
      self.lock.lock()
      let listener = self.thumbnailListener
      self.lock.unlock()
      guard let listener, let buffer = try? ArrayBuffer.copy(data: jpeg) else { return }
      listener(buffer, Double(width), Double(height))
    }
  }

  var wantsFrames: Bool {
    return engine.isActive || thumbnails.isEnabled
  }

  /// Capture queue. Keep this cheap.
  func process(_ pixelBuffer: CVPixelBuffer, pts: CMTime) {
    thumbnails.offer(pixelBuffer)
    engine.append(pixelBuffer, pts: pts)
  }

  // MARK: - LiveStreamer

  func start(config: LiveStreamConfig) throws {
    guard config.width >= 16, config.height >= 16, config.fps >= 1, config.bitrateKbps >= 100 else {
      throw RuntimeError.error(withMessage: "Invalid live stream config: \(config.width)x\(config.height)@\(config.fps) \(config.bitrateKbps)kbps")
    }
    engine.start(StreamEngine.Config(
      url: config.url,
      width: Int(config.width),
      height: Int(config.height),
      fps: config.fps,
      bitrateKbps: config.bitrateKbps,
      keyframeIntervalSec: config.keyframeIntervalSec > 0 ? config.keyframeIntervalSec : 1,
      profile: HybridLiveStreamer.streamProfile(config.profile)))
    onDemandChanged?(wantsFrames)
  }

  func stop() throws {
    engine.stop()
    onDemandChanged?(wantsFrames)
  }

  func setBitrate(kbps: Double) throws {
    engine.setBitrate(kbps: kbps)
  }

  func setFps(fps: Double) throws {
    engine.setFps(fps)
  }

  func getStats() throws -> LiveStreamStats {
    return HybridLiveStreamer.stats(from: engine.snapshot())
  }

  func setStateListener(listener: ((_ stats: LiveStreamStats) -> Void)?) throws {
    lock.lock()
    stateListener = listener
    lock.unlock()
  }

  func startThumbnails(options: ThumbnailOptions) throws {
    thumbnails.start(ThumbnailMaker.Options(
      intervalMs: options.intervalMs, maxWidth: Int(options.maxWidth), quality: options.quality))
    onDemandChanged?(wantsFrames)
  }

  func stopThumbnails() throws {
    thumbnails.stop()
    onDemandChanged?(wantsFrames)
  }

  func setThumbnailInterval(intervalMs: Double) throws {
    thumbnails.setInterval(intervalMs)
  }

  func setThumbnailListener(listener: ((_ jpeg: ArrayBuffer, _ width: Double, _ height: Double) -> Void)?) throws {
    lock.lock()
    thumbnailListener = listener
    lock.unlock()
  }

  func dispose() {
    engine.stop()
    thumbnails.stop()
  }

  private static func stats(from s: StreamEngine.Snapshot) -> LiveStreamStats {
    let state: LiveStreamState
    switch s.state {
    case .off: state = .off
    case .connecting: state = .connecting
    case .live: state = .live
    case .error: state = .error
    }
    return LiveStreamStats(
      state: state, width: s.width, height: s.height, fps: s.fps, kbps: s.kbps,
      sentFrames: s.sentFrames, droppedFrames: s.droppedFrames, rttMs: s.rttMs,
      profile: s.profile.map(HybridLiveStreamer.h264Profile), cpuPct: s.cpuPct, error: s.error)
  }

  private static func streamProfile(_ profile: H264Profile) -> StreamProfile {
    switch profile {
    case .baseline: return .baseline
    case .main: return .main
    case .high: return .high
    }
  }

  private static func h264Profile(_ profile: StreamProfile) -> H264Profile {
    switch profile {
    case .baseline: return .baseline
    case .main: return .main
    case .high: return .high
    }
  }
}
