//
//  StreamEngine.swift
//  TallyStream
//
//  Platform-pure core of the live feed (no Nitro/VisionCamera types, so it is
//  testable on macOS): frame decimation -> VideoToolbox H.264 -> MPEG-TS -> SRT caller,
//  with automatic reconnect and backlog control. Never touches the local recording.
//

import CoreMedia
import CoreVideo
import Foundation

final class StreamEngine {
  struct Config: Equatable {
    var url: String
    var width: Int
    var height: Int
    var fps: Double
    var bitrateKbps: Double
    var keyframeIntervalSec: Double
    var profile: StreamProfile
  }

  enum State: String {
    case off, connecting, live, error
  }

  struct Snapshot {
    var state: State
    var width: Double
    var height: Double
    var fps: Double
    var kbps: Double
    var sentFrames: Double
    var droppedFrames: Double
    var rttMs: Double
    /// Profile in the SPS actually produced by the encoder (nil until the first keyframe).
    var profile: StreamProfile?
    /// This app's CPU use as a share of all cores, 0...100 (-1 until sampled).
    var cpuPct: Double
    var error: String?
  }

  /// Called on an internal queue whenever the state (or error) changes.
  var onStateChange: ((Snapshot) -> Void)?

  private let encodeQueue = DispatchQueue(label: "com.tally.stream.encode", qos: .userInitiated)
  private let netQueue = DispatchQueue(label: "com.tally.stream.net", qos: .userInitiated)
  private let lock = NSLock()

  // MARK: Guarded by `lock`
  private var state: State = .off
  private var config: Config?
  private var lastError: String?
  private var generation = 0
  private var socket: Int32 = -1
  private var needsKeyframe = true
  private var lastAcceptedPts: CMTime?
  private var framesInEncoder = 0
  private var pendingBytes = 0
  private var sentFrames = 0
  private var droppedFrames = 0
  private var kbps = 0.0
  private var rttMs = -1.0
  private var encodedSize = (width: 0, height: 0)
  private var appliedProfile: StreamProfile?
  private var cpu = CPUSampler()

  // MARK: encodeQueue only
  private var encoder: H264Encoder?

  // MARK: netQueue only
  private let muxer = TSMuxer()
  private var basePts: CMTime?
  private var windowStart = CFAbsoluteTimeGetCurrent()
  private var windowBytes = 0

  deinit {
    let s = socket
    if s >= 0 { tally_srt_close(s) }
  }

  // MARK: - Control

  func start(_ newConfig: Config) {
    lock.lock()
    generation += 1
    let gen = generation
    let oldSocket = socket
    socket = -1
    config = newConfig
    state = .connecting
    lastError = nil
    needsKeyframe = true
    lastAcceptedPts = nil
    pendingBytes = 0
    sentFrames = 0
    droppedFrames = 0
    kbps = 0
    appliedProfile = nil
    lock.unlock()

    encodeQueue.async { [weak self] in
      self?.encoder?.invalidate()
      self?.encoder = nil
    }
    netQueue.async { [weak self] in
      if oldSocket >= 0 { tally_srt_close(oldSocket) }
      self?.resetMuxing()
    }
    notify()
    connect(generation: gen, attempt: 0)
  }

  func stop() {
    lock.lock()
    generation += 1
    let oldSocket = socket
    socket = -1
    state = .off
    lastError = nil
    lock.unlock()
    netQueue.async { [weak self] in
      if oldSocket >= 0 { tally_srt_close(oldSocket) }
      self?.resetMuxing()
    }
    encodeQueue.async { [weak self] in
      self?.encoder?.invalidate()
      self?.encoder = nil
    }
    notify()
  }

  func setBitrate(kbps newKbps: Double) {
    lock.lock()
    config?.bitrateKbps = newKbps
    lock.unlock()
    encodeQueue.async { [weak self] in self?.encoder?.setBitrate(kbps: newKbps) }
  }

  func setFps(_ fps: Double) {
    lock.lock()
    config?.fps = max(1, fps)
    lock.unlock()
    encodeQueue.async { [weak self] in self?.encoder?.setExpectedFps(fps) }
  }

  /// Whether frames are currently wanted (lets the capture output idle when off).
  var isActive: Bool {
    lock.lock()
    defer { lock.unlock() }
    return state == .connecting || state == .live
  }

  func snapshot() -> Snapshot {
    lock.lock()
    defer { lock.unlock() }
    return makeSnapshot()
  }

  // MARK: - Frames (called from the capture queue)

  func append(_ pixelBuffer: CVPixelBuffer, pts: CMTime) {
    lock.lock()
    guard state == .live, let config else {
      lock.unlock()
      return
    }
    // Decimate to the target fps (camera may run faster, e.g. 60 -> 30).
    if let last = lastAcceptedPts, pts.isValid, last.isValid {
      let delta = CMTimeGetSeconds(CMTimeSubtract(pts, last))
      if delta >= 0 && delta < (1.0 / config.fps) * 0.85 {
        lock.unlock()
        return
      }
    }
    // Backpressure: never let encoding or the network queue pile up (keeps latency low,
    // and never starves the camera's buffer pool that the local recording shares).
    let maxBacklog = Int(config.bitrateKbps * 1000 / 8)  // ~1 s of video
    if framesInEncoder >= 3 || pendingBytes > maxBacklog {
      droppedFrames += 1
      needsKeyframe = true
      lock.unlock()
      return
    }
    lastAcceptedPts = pts
    framesInEncoder += 1
    let gen = generation
    lock.unlock()

    encodeQueue.async { [weak self] in
      guard let self else { return }
      self.encode(pixelBuffer, pts: pts, generation: gen, config: config)
      self.lock.lock()
      self.framesInEncoder -= 1
      self.lock.unlock()
    }
  }

  // MARK: - Encoding (encodeQueue)

  private func encode(_ pixelBuffer: CVPixelBuffer, pts: CMTime, generation gen: Int, config: Config) {
    // Match the target orientation to the buffer (portrait-mounted phones send portrait).
    let bufferPortrait = CVPixelBufferGetHeight(pixelBuffer) > CVPixelBufferGetWidth(pixelBuffer)
    let targetPortrait = config.height > config.width
    var width = config.width
    var height = config.height
    if bufferPortrait != targetPortrait { swap(&width, &height) }
    width &= ~1
    height &= ~1

    if encoder == nil || encoder!.width != Int32(width) || encoder!.height != Int32(height) {
      encoder?.invalidate()
      do {
        encoder = try H264Encoder(
          width: Int32(width), height: Int32(height), fps: config.fps, bitrateKbps: config.bitrateKbps,
          keyframeIntervalSec: config.keyframeIntervalSec, profile: config.profile
        ) { [weak self] accessUnit, pts, isKeyframe, profile in
          guard let self else { return }
          if let profile {
            self.lock.lock()
            if self.appliedProfile != profile { self.appliedProfile = profile }
            self.lock.unlock()
          }
          self.enqueueSend(accessUnit, pts: pts, isKeyframe: isKeyframe, generation: gen)
        }
        lock.lock()
        encodedSize = (width, height)
        lock.unlock()
      } catch {
        fail("Encoder: \(error.localizedDescription)", generation: gen)
        return
      }
    }
    lock.lock()
    let wantsKeyframe = needsKeyframe
    needsKeyframe = false
    lock.unlock()
    if wantsKeyframe { encoder?.requestKeyframe() }
    encoder?.encode(pixelBuffer, pts: pts)
  }

  // MARK: - Network (netQueue)

  private func enqueueSend(_ accessUnit: Data, pts: CMTime, isKeyframe: Bool, generation gen: Int) {
    lock.lock()
    pendingBytes += accessUnit.count
    lock.unlock()
    netQueue.async { [weak self] in
      guard let self else { return }
      defer {
        self.lock.lock()
        self.pendingBytes -= accessUnit.count
        self.lock.unlock()
      }
      self.lock.lock()
      let s = self.socket
      let current = gen == self.generation
      self.lock.unlock()
      guard current, s >= 0 else { return }

      if self.basePts == nil {
        // A fresh connection must start on a keyframe so the decoder can lock on immediately.
        guard isKeyframe else {
          self.lock.lock()
          self.needsKeyframe = true
          self.lock.unlock()
          return
        }
        self.basePts = pts
      }
      let elapsed = max(0, CMTimeGetSeconds(CMTimeSubtract(pts, self.basePts!)))
      let ts = self.muxer.mux(accessUnit: accessUnit, pts90k: UInt64(elapsed * 90_000), isKeyframe: isKeyframe)

      let chunk = 7 * TSMuxer.packetSize  // 1316 bytes, one SRT live payload
      let ok = ts.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> Bool in
        let base = raw.bindMemory(to: UInt8.self).baseAddress!
        var offset = 0
        while offset < ts.count {
          let length = min(chunk, ts.count - offset)
          if tally_srt_send(s, base + offset, Int32(length)) < 0 { return false }
          offset += length
        }
        return true
      }
      if !ok {
        let reason = String(cString: tally_srt_last_error())
        self.connectionLost(socket: s, reason: reason, generation: gen)
        return
      }

      self.windowBytes += ts.count
      self.lock.lock()
      self.sentFrames += 1
      self.lock.unlock()
      let now = CFAbsoluteTimeGetCurrent()
      if now - self.windowStart >= 1 {
        let rate = Double(self.windowBytes * 8) / (now - self.windowStart) / 1000
        let rtt = tally_srt_rtt_ms(s)
        let dropped = Int(tally_srt_take_dropped(s))
        self.lock.lock()
        self.kbps = rate
        self.rttMs = rtt
        self.droppedFrames += dropped
        self.lock.unlock()
        self.windowStart = now
        self.windowBytes = 0
      }
    }
  }

  private func connect(generation gen: Int, attempt: Int) {
    netQueue.async { [weak self] in
      guard let self else { return }
      self.lock.lock()
      let config = self.config
      let current = gen == self.generation && self.state != .off
      self.lock.unlock()
      guard current, let config else { return }

      guard let target = StreamEngine.parse(config.url) else {
        self.fail("Invalid stream URL: \(config.url)", generation: gen)
        return
      }
      var errorBuffer = [CChar](repeating: 0, count: 256)
      let s = tally_srt_connect(target.host, target.port, target.streamId, target.latencyMs, &errorBuffer, 256)
      if s >= 0 {
        self.lock.lock()
        guard gen == self.generation, self.state != .off else {
          self.lock.unlock()
          tally_srt_close(s)
          return
        }
        self.socket = s
        self.state = .live
        self.lastError = nil
        self.needsKeyframe = true
        self.lock.unlock()
        self.resetMuxing()
        self.notify()
      } else {
        let message = String(cString: errorBuffer)
        self.lock.lock()
        let stillWanted = gen == self.generation && self.state != .off
        if stillWanted {
          self.state = .connecting
          self.lastError = message
        }
        self.lock.unlock()
        guard stillWanted else { return }
        self.notify()
        // Exponential backoff, capped: 0.5, 1, 2, 4, 5, 5, ... seconds.
        let delay = min(5.0, 0.5 * pow(2.0, Double(min(attempt, 4))))
        self.netQueue.asyncAfter(deadline: .now() + delay) { [weak self] in
          self?.connect(generation: gen, attempt: attempt + 1)
        }
      }
    }
  }

  private func connectionLost(socket s: Int32, reason: String, generation gen: Int) {
    lock.lock()
    guard gen == generation, socket == s else {
      lock.unlock()
      return
    }
    socket = -1
    state = .connecting
    lastError = "Connection lost: \(reason)"
    lock.unlock()
    tally_srt_close(s)
    resetMuxing()
    notify()
    connect(generation: gen, attempt: 0)
  }

  private func fail(_ message: String, generation gen: Int) {
    lock.lock()
    guard gen == generation else {
      lock.unlock()
      return
    }
    state = .error
    lastError = message
    lock.unlock()
    notify()
  }

  private func resetMuxing() {
    muxer.reset()
    basePts = nil
    windowStart = CFAbsoluteTimeGetCurrent()
    windowBytes = 0
  }

  private func notify() {
    let snap = snapshot()
    onStateChange?(snap)
  }

  private func makeSnapshot() -> Snapshot {
    return Snapshot(
      state: state,
      width: Double(encodedSize.width),
      height: Double(encodedSize.height),
      fps: config?.fps ?? 0,
      kbps: kbps,
      sentFrames: Double(sentFrames),
      droppedFrames: Double(droppedFrames),
      rttMs: rttMs,
      profile: appliedProfile,
      cpuPct: cpu.sample(),
      error: lastError)
  }

  // MARK: - URL

  struct Target {
    let host: String
    let port: Int32
    let streamId: String
    let latencyMs: Int32
  }

  /// `srt://host:port?streamid=publish:cam-a&latency=120` (latency in ms, like RootEncoder/ffmpeg-style apps).
  static func parse(_ url: String) -> Target? {
    guard let components = URLComponents(string: url),
          components.scheme?.lowercased() == "srt",
          let host = components.host, !host.isEmpty
    else { return nil }
    let query = components.queryItems ?? []
    let streamId = query.first { $0.name == "streamid" }?.value ?? ""
    let latency = query.first { $0.name == "latency" }?.value.flatMap { Int32($0) } ?? 120
    return Target(host: host, port: Int32(components.port ?? 8890), streamId: streamId, latencyMs: latency)
  }
}

/// Process CPU time (user + system) over wall time, normalised to all cores. Re-samples at most every 0.5 s.
struct CPUSampler {
  private var lastCPU = 0.0
  private var lastWall = 0.0
  private var value = -1.0

  mutating func sample() -> Double {
    let now = CFAbsoluteTimeGetCurrent()
    var usage = rusage()
    guard getrusage(RUSAGE_SELF, &usage) == 0 else { return value }
    let cpuTime = Double(usage.ru_utime.tv_sec) + Double(usage.ru_utime.tv_usec) / 1e6
      + Double(usage.ru_stime.tv_sec) + Double(usage.ru_stime.tv_usec) / 1e6
    if lastWall == 0 {
      lastCPU = cpuTime
      lastWall = now
      return value
    }
    let wall = now - lastWall
    if wall >= 0.5 {
      let cores = Double(max(1, ProcessInfo.processInfo.activeProcessorCount))
      value = min(100, max(0, (cpuTime - lastCPU) / wall / cores * 100))
      lastCPU = cpuTime
      lastWall = now
    }
    return value
  }
}
