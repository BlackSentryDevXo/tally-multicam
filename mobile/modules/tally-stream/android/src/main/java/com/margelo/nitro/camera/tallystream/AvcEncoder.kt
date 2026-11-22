package com.margelo.nitro.camera.tallystream

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.view.Surface
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicInteger

/**
 * Hardware H.264 (MediaCodec, async mode): real-time priority, VBR with a peak cap where supported
 * (CBR, then the encoder default, as fallbacks), no B-frames, fixed GOP. High profile when asked for
 * 'high', Main otherwise. Input is a Surface that GlRenderer draws camera frames into.
 */
internal class AvcEncoder(
  val width: Int,
  val height: Int,
  fps: Int,
  bitrateKbps: Int,
  keyframeIntervalSec: Double,
  private val profile: H264Profile,
  private val listener: Listener,
) {
  interface Listener {
    /** `profile` is parsed from the SPS, i.e. what the encoder really produces. */
    fun onParameterSets(sps: ByteBuffer, pps: ByteBuffer, profile: H264Profile?)
    fun onEncodedFrame(buffer: ByteBuffer, info: MediaCodec.BufferInfo)
    fun onEncoderError(error: Throwable)
  }

  private val thread = HandlerThread("tally-avc").apply { start() }
  private val codec: MediaCodec = MediaCodec.createEncoderByType(MIME)
  private val pending = AtomicInteger(0)
  @Volatile private var released = false

  /** GlRenderer draws frames here. */
  val inputSurface: Surface

  @Volatile private var lastOutputMs = 0L

  /**
   * Frames drawn but not yet encoded: the backpressure signal (a Surface encoder has no free-buffer count).
   * Self-heals if the encoder silently swallowed frames (no output for 1 s).
   */
  val inFlight: Int
    get() {
      val n = pending.get()
      if (n > 0 && lastOutputMs > 0 && android.os.SystemClock.elapsedRealtime() - lastOutputMs > 1000) {
        pending.set(0)
        return 0
      }
      return n
    }

  init {
    val format = MediaFormat.createVideoFormat(MIME, width, height).apply {
      setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
      setInteger(MediaFormat.KEY_BIT_RATE, bitrateKbps * 1000)
      setInteger(MediaFormat.KEY_FRAME_RATE, fps)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N_MR1) {
        setFloat(MediaFormat.KEY_I_FRAME_INTERVAL, keyframeIntervalSec.toFloat())
      } else {
        setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, maxOf(1, keyframeIntervalSec.toInt()))
      }
      setInteger(MediaFormat.KEY_PRIORITY, 0) // real-time
      pickProfileLevel(if (profile == H264Profile.HIGH) H264Profile.HIGH else H264Profile.MAIN)?.let { (p, level) ->
        setInteger(MediaFormat.KEY_PROFILE, p)
        setInteger(MediaFormat.KEY_LEVEL, level)
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
      // BT.709 limited range, tagged, so the hub/OBS decode the colours the camera produced.
      setInteger(MediaFormat.KEY_COLOR_STANDARD, MediaFormat.COLOR_STANDARD_BT709)
      setInteger(MediaFormat.KEY_COLOR_RANGE, MediaFormat.COLOR_RANGE_LIMITED)
      setInteger(MediaFormat.KEY_COLOR_TRANSFER, MediaFormat.COLOR_TRANSFER_SDR_VIDEO)
      val caps = codec.codecInfo.getCapabilitiesForType(MIME).encoderCapabilities
      when {
        caps?.isBitrateModeSupported(MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR) == true -> {
          // VBR spends bits where the picture needs them; the peak cap keeps bursts inside what Wi-Fi/SRT carry.
          setInteger(MediaFormat.KEY_BITRATE_MODE, MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR)
          setInteger(KEY_MAX_BITRATE, bitrateKbps * 1000 * PEAK_PCT / 100)
        }
        caps?.isBitrateModeSupported(MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR) == true ->
          setInteger(MediaFormat.KEY_BITRATE_MODE, MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR)
      }
    }
    val callback = object : MediaCodec.Callback() {
      override fun onInputBufferAvailable(codec: MediaCodec, index: Int) {} // Surface input

      override fun onOutputBufferAvailable(codec: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
        if (released) return
        try {
          val buffer = codec.getOutputBuffer(index)
          if (buffer != null && info.size > 0 && (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) {
            pending.updateAndGet { maxOf(0, it - 1) }
            lastOutputMs = android.os.SystemClock.elapsedRealtime()
            buffer.position(info.offset).limit(info.offset + info.size)
            listener.onEncodedFrame(buffer, info)
          }
          codec.releaseOutputBuffer(index, false)
        } catch (e: Throwable) {
          if (!released) listener.onEncoderError(e)
        }
      }

      override fun onOutputFormatChanged(codec: MediaCodec, format: MediaFormat) {
        val sps = format.getByteBuffer("csd-0")
        val pps = format.getByteBuffer("csd-1")
        if (sps != null && pps != null) listener.onParameterSets(sps.duplicate(), pps.duplicate(), parseSpsProfile(sps))
      }

      override fun onError(codec: MediaCodec, e: MediaCodec.CodecException) {
        if (!released) listener.onEncoderError(e)
      }
    }
    val handler = Handler(thread.looper)
    codec.setCallback(callback, handler)
    try {
      // Some encoders reject High/4.2, KEY_LOW_LATENCY or the colour/peak keys; retry with the encoder's defaults.
      codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
    } catch (e: Exception) {
      Log.w(TAG, "configure() with tuned format failed, retrying with defaults", e)
      format.removeKey(MediaFormat.KEY_PROFILE)
      format.removeKey(MediaFormat.KEY_LEVEL)
      format.removeKey(KEY_MAX_BITRATE)
      format.removeKey(MediaFormat.KEY_COLOR_STANDARD)
      format.removeKey(MediaFormat.KEY_COLOR_RANGE)
      format.removeKey(MediaFormat.KEY_COLOR_TRANSFER)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) format.removeKey(MediaFormat.KEY_LOW_LATENCY)
      codec.reset()
      codec.setCallback(callback, handler)
      codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
    }
    inputSurface = codec.createInputSurface()
    codec.start()
  }

  /** GL thread, after a frame was swapped into [inputSurface]. */
  fun frameQueued() {
    if (pending.incrementAndGet() == 1 && lastOutputMs == 0L) lastOutputMs = android.os.SystemClock.elapsedRealtime()
  }

  /**
   * Requested profile -> (MediaCodec profile, level) from the encoder's advertised profileLevels,
   * or null to leave the encoder on its defaults. Level is the highest the profile supports, capped
   * at 5.1 (1080p60 needs 4.2). Constrained Baseline/High constants exist from API 27.
   */
  private fun pickProfileLevel(requested: H264Profile): Pair<Int, Int>? {
    val caps = try { codec.codecInfo.getCapabilitiesForType(MIME) } catch (_: Throwable) { return null }
    val levels = caps.profileLevels ?: return null
    val candidates = when (requested) {
      H264Profile.BASELINE -> listOfNotNull(
        if (Build.VERSION.SDK_INT >= 27) MediaCodecInfo.CodecProfileLevel.AVCProfileConstrainedBaseline else null,
        MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline,
      )
      H264Profile.MAIN -> listOf(MediaCodecInfo.CodecProfileLevel.AVCProfileMain)
      H264Profile.HIGH -> listOfNotNull(
        MediaCodecInfo.CodecProfileLevel.AVCProfileHigh,
        if (Build.VERSION.SDK_INT >= 27) MediaCodecInfo.CodecProfileLevel.AVCProfileConstrainedHigh else null,
      )
    }
    for (p in candidates) {
      val supported = levels.filter { it.profile == p }.map { it.level }
      if (supported.isNotEmpty()) {
        return Pair(p, minOf(supported.max(), MediaCodecInfo.CodecProfileLevel.AVCLevel51))
      }
    }
    return null
  }

  fun requestKeyframe() = setParam { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) }

  fun setBitrate(kbps: Int) = setParam { putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, kbps * 1000) }

  private inline fun setParam(fill: Bundle.() -> Unit) {
    if (released) return
    try {
      codec.setParameters(Bundle().apply(fill))
    } catch (e: Throwable) {
      Log.w(TAG, "setParameters failed", e)
    }
  }

  fun release() {
    if (released) return
    released = true
    try { codec.stop() } catch (_: Throwable) {}
    try { codec.release() } catch (_: Throwable) {}
    try { inputSurface.release() } catch (_: Throwable) {}
    thread.quitSafely()
  }

  companion object {
    private const val TAG = "TallyAvcEncoder"
    private const val MIME = MediaFormat.MIMETYPE_VIDEO_AVC
    // Not public SDK API: honoured by Codec2 encoders as the VBR peak, ignored elsewhere.
    private const val KEY_MAX_BITRATE = "max-bitrate"
    private const val PEAK_PCT = 150

    /** csd-0 is an Annex-B SPS: start code, NAL header (0x67), then profile_idc. */
    fun parseSpsProfile(sps: ByteBuffer): H264Profile? {
      val b = sps.duplicate().apply { rewind() }
      var i = 0
      val n = b.remaining()
      while (i < n && b.get(i).toInt() == 0) i++ // leading zeros of the start code
      if (i < n && b.get(i).toInt() == 1) i++ // 0x01
      if (i + 1 >= n) return null
      return when (b.get(i + 1).toInt() and 0xFF) { // i = NAL header, i+1 = profile_idc
        66 -> H264Profile.BASELINE
        77 -> H264Profile.MAIN
        100, 110, 122, 244 -> H264Profile.HIGH
        else -> null
      }
    }
  }
}
