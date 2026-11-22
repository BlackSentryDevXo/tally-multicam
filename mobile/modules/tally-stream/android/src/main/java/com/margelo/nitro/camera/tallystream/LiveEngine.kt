package com.margelo.nitro.camera.tallystream

import android.media.MediaCodec
import android.os.Process
import android.os.SystemClock
import android.util.Log
import androidx.camera.core.ImageProxy
import com.pedro.common.ConnectChecker
import com.pedro.common.VideoCodec
import com.pedro.srt.srt.SrtClient
import java.nio.ByteBuffer

/**
 * Live feed core: decimation -> MediaCodec H.264 -> RootEncoder SrtClient (caller, MPEG-TS).
 * Reconnects with backoff; errors never touch the local recording.
 */
internal class LiveEngine(private val onState: (LiveStreamStats) -> Unit) : AvcEncoder.Listener {
  private val lock = Any()

  // Guarded by `lock`
  private var state = LiveStreamState.OFF
  private var config: LiveStreamConfig? = null
  private var lastError: String? = null
  private var generation = 0
  private var srt: SrtClient? = null
  private var encoder: AvcEncoder? = null
  private var needsKeyframe = true
  private var lastAcceptedNs = -1L
  private var baseNs = -1L
  private var sentFrames = 0L
  private var droppedFrames = 0L
  private var kbps = 0.0
  private var attempt = 0
  private var sps: ByteBuffer? = null
  private var pps: ByteBuffer? = null
  private var appliedProfile: H264Profile? = null
  private val cpu = CpuSampler()

  val isActive: Boolean
    get() = synchronized(lock) { state == LiveStreamState.CONNECTING || state == LiveStreamState.LIVE }

  fun start(newConfig: LiveStreamConfig) {
    val old: SrtClient?
    val oldEncoder: AvcEncoder?
    val client: SrtClient
    synchronized(lock) {
      generation++
      old = srt
      oldEncoder = encoder
      encoder = null
      config = newConfig
      state = LiveStreamState.CONNECTING
      lastError = null
      needsKeyframe = true
      lastAcceptedNs = -1L
      baseNs = -1L
      sentFrames = 0
      droppedFrames = 0
      kbps = 0.0
      attempt = 0
      sps = null
      pps = null
      appliedProfile = null
      client = SrtClient(Session(generation)).apply {
        setOnlyVideo(true)
        setVideoCodec(VideoCodec.H264)
        setReTries(Int.MAX_VALUE / 2)
        setCheckServerAlive(true)
      }
      srt = client
    }
    old?.disconnect()
    oldEncoder?.release()
    notifyState()
    client.connect(newConfig.url)
  }

  fun stop() {
    val old: SrtClient?
    val oldEncoder: AvcEncoder?
    synchronized(lock) {
      generation++
      old = srt
      oldEncoder = encoder
      srt = null
      encoder = null
      state = LiveStreamState.OFF
      lastError = null
    }
    old?.disconnect()
    oldEncoder?.release()
    notifyState()
  }

  fun setBitrate(kbps: Double) {
    val enc = synchronized(lock) {
      config = config?.copy(bitrateKbps = kbps)
      encoder
    }
    enc?.setBitrate(kbps.toInt())
  }

  fun setFps(fps: Double) {
    synchronized(lock) { config = config?.copy(fps = maxOf(1.0, fps)) }
  }

  fun stats(): LiveStreamStats = synchronized(lock) { snapshot() }

  /** Analyzer thread. */
  fun process(image: ImageProxy, rotation: Int) {
    val ts = image.imageInfo.timestamp
    val cfg: LiveStreamConfig
    var enc: AvcEncoder?
    val wantKeyframe: Boolean
    synchronized(lock) {
      if (state != LiveStreamState.LIVE) return
      cfg = config ?: return
      val minIntervalNs = (1_000_000_000.0 / cfg.fps * 0.85).toLong()
      if (lastAcceptedNs >= 0 && ts - lastAcceptedNs in 0 until minIntervalNs) return
      lastAcceptedNs = ts
      if (baseNs < 0) baseNs = ts
      enc = encoder
      wantKeyframe = needsKeyframe
      needsKeyframe = false
    }

    val swap = rotation == 90 || rotation == 270
    val rw = if (swap) image.height else image.width
    val rh = if (swap) image.width else image.height
    val w = rw and 1.inv()
    val h = rh and 1.inv()
    if (enc == null || enc!!.width != w || enc!!.height != h) {
      enc?.release()
      enc = try {
        AvcEncoder(w, h, cfg.fps.toInt(), cfg.bitrateKbps.toInt(), cfg.keyframeIntervalSec, cfg.profile, this)
      } catch (e: Throwable) {
        fail("Encoder: ${e.message}")
        return
      }
      synchronized(lock) { encoder = enc }
    }
    if (wantKeyframe) enc!!.requestKeyframe()
    val ptsUs = (ts - synchronized(lock) { baseNs }) / 1000
    if (!enc!!.encode(image, rotation, ptsUs)) {
      synchronized(lock) {
        droppedFrames++
        needsKeyframe = true
      }
    }
  }

  // MARK: AvcEncoder.Listener (codec thread)

  override fun onParameterSets(sps: ByteBuffer, pps: ByteBuffer, profile: H264Profile?) {
    val client = synchronized(lock) {
      this.sps = clone(sps)
      this.pps = clone(pps)
      if (profile != null) appliedProfile = profile
      srt
    }
    client?.setVideoInfo(clone(sps), clone(pps), null)
  }

  override fun onEncodedFrame(buffer: ByteBuffer, info: MediaCodec.BufferInfo) {
    val client = synchronized(lock) {
      if (state != LiveStreamState.LIVE) return
      srt
    } ?: return
    client.sendVideo(buffer, info)
    synchronized(lock) { sentFrames++ }
    if (client.hasCongestion()) {
      // Wi-Fi can't keep up: ask for a keyframe so the receiver recovers fast once it drains.
      synchronized(lock) { needsKeyframe = true }
    }
  }

  override fun onEncoderError(error: Throwable) {
    Log.e(TAG, "Encoder error", error)
    val enc = synchronized(lock) {
      lastError = "Encoder: ${error.message}"
      needsKeyframe = true
      encoder.also { encoder = null }
    }
    enc?.release() // recreated on the next frame
  }

  private fun fail(message: String) {
    synchronized(lock) {
      state = LiveStreamState.ERROR
      lastError = message
    }
    notifyState()
  }

  private fun notifyState() {
    onState(stats())
  }

  private fun snapshot(): LiveStreamStats {
    val enc = encoder
    return LiveStreamStats(
      state = state,
      width = (enc?.width ?: 0).toDouble(),
      height = (enc?.height ?: 0).toDouble(),
      fps = config?.fps ?: 0.0,
      kbps = kbps,
      sentFrames = sentFrames.toDouble(),
      droppedFrames = droppedFrames.toDouble(),
      rttMs = -1.0,
      profile = appliedProfile,
      cpuPct = cpu.sample(),
      error = lastError,
    )
  }

  /** Process CPU time over wall time, normalised to all cores (0..100). Re-samples at most every 0.5 s. */
  private class CpuSampler {
    private var lastCpuMs = 0L
    private var lastWallMs = 0L
    private var value = -1.0

    fun sample(): Double {
      val now = SystemClock.elapsedRealtime()
      val cpuMs = try { Process.getElapsedCpuTime() } catch (_: Throwable) { return value }
      if (lastWallMs == 0L) {
        lastCpuMs = cpuMs
        lastWallMs = now
        return value
      }
      val wall = now - lastWallMs
      if (wall >= 500) {
        val cores = maxOf(1, Runtime.getRuntime().availableProcessors())
        value = ((cpuMs - lastCpuMs).toDouble() / wall / cores * 100).coerceIn(0.0, 100.0)
        lastCpuMs = cpuMs
        lastWallMs = now
      }
      return value
    }
  }

  /** Per-connection checker, so callbacks from a replaced SrtClient are ignored. */
  private inner class Session(private val gen: Int) : ConnectChecker {
    private fun current(): SrtClient? = synchronized(lock) { if (gen == generation) srt else null }

    override fun onConnectionStarted(url: String) {}

    override fun onConnectionSuccess() {
      val client = current() ?: return
      val (s, p) = synchronized(lock) {
        state = LiveStreamState.LIVE
        lastError = null
        attempt = 0
        needsKeyframe = true
        Pair(sps, pps)
      }
      if (s != null && p != null) client.setVideoInfo(clone(s), clone(p), null)
      notifyState()
    }

    override fun onConnectionFailed(reason: String) {
      val client = current() ?: return
      val delayMs: Long
      synchronized(lock) {
        lastError = reason
        if (state == LiveStreamState.OFF) return
        state = LiveStreamState.CONNECTING
        // 0.5, 1, 2, 4, 5, 5 ... seconds
        delayMs = minOf(5000L, 500L shl minOf(attempt, 4))
        attempt++
      }
      notifyState()
      if (client.shouldRetry(reason)) {
        client.reConnect(delayMs)
      } else {
        fail(reason)
      }
    }

    override fun onDisconnect() {}

    override fun onAuthError() {
      if (current() != null) fail("SRT authentication failed")
    }

    override fun onAuthSuccess() {}

    override fun onNewBitrate(bitrate: Long) {
      synchronized(lock) { if (gen == generation) kbps = bitrate / 1000.0 }
    }
  }

  companion object {
    private const val TAG = "TallyLiveEngine"

    private fun clone(src: ByteBuffer): ByteBuffer {
      val d = src.duplicate().apply { rewind() }
      val out = ByteBuffer.allocate(d.remaining())
      out.put(d)
      out.flip()
      return out
    }
  }
}
