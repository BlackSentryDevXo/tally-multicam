package com.margelo.nitro.camera.tallystream

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import androidx.camera.core.ImageProxy
import java.nio.ByteBuffer
import java.util.concurrent.ArrayBlockingQueue

/**
 * Hardware H.264 (MediaCodec, async mode): real-time priority, CBR where supported,
 * no B-frames, fixed GOP. Input is copied from CameraX YUV frames (ImageAnalysis).
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
  private val freeInputs = ArrayBlockingQueue<Int>(32)
  private val codec: MediaCodec = MediaCodec.createEncoderByType(MIME)
  private val yuv = YuvPlanes()
  @Volatile private var released = false

  init {
    val format = MediaFormat.createVideoFormat(MIME, width, height).apply {
      setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible)
      setInteger(MediaFormat.KEY_BIT_RATE, bitrateKbps * 1000)
      setInteger(MediaFormat.KEY_FRAME_RATE, fps)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N_MR1) {
        setFloat(MediaFormat.KEY_I_FRAME_INTERVAL, keyframeIntervalSec.toFloat())
      } else {
        setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, maxOf(1, keyframeIntervalSec.toInt()))
      }
      setInteger(MediaFormat.KEY_PRIORITY, 0) // real-time
      pickProfileLevel(profile)?.let { (p, level) ->
        setInteger(MediaFormat.KEY_PROFILE, p)
        setInteger(MediaFormat.KEY_LEVEL, level)
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
      val caps = codec.codecInfo.getCapabilitiesForType(MIME).encoderCapabilities
      if (caps?.isBitrateModeSupported(MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR) == true) {
        setInteger(MediaFormat.KEY_BITRATE_MODE, MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR)
      }
    }
    val callback = object : MediaCodec.Callback() {
      override fun onInputBufferAvailable(codec: MediaCodec, index: Int) {
        freeInputs.offer(index)
      }

      override fun onOutputBufferAvailable(codec: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
        if (released) return
        try {
          val buffer = codec.getOutputBuffer(index)
          if (buffer != null && info.size > 0 && (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) {
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
      // Some encoders reject High/4.2 or KEY_LOW_LATENCY; retry with the encoder's defaults.
      codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
    } catch (e: Exception) {
      Log.w(TAG, "configure() with tuned format failed, retrying with defaults", e)
      format.removeKey(MediaFormat.KEY_PROFILE)
      format.removeKey(MediaFormat.KEY_LEVEL)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) format.removeKey(MediaFormat.KEY_LOW_LATENCY)
      codec.reset()
      codec.setCallback(callback, handler)
      codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
    }
    codec.start()
  }

  /** Copies one frame into the encoder. Returns false (frame dropped) if no input buffer is free. */
  fun encode(image: ImageProxy, rotation: Int, ptsUs: Long): Boolean {
    if (released) return false
    val index = freeInputs.poll() ?: return false
    return try {
      val dst = codec.getInputImage(index)
      if (dst == null) {
        codec.queueInputBuffer(index, 0, 0, ptsUs, 0)
        false
      } else {
        yuv.copy(image, dst, rotation)
        codec.queueInputBuffer(index, 0, width * height * 3 / 2, ptsUs, 0)
        true
      }
    } catch (e: Throwable) {
      if (!released) listener.onEncoderError(e)
      false
    }
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
    thread.quitSafely()
  }

  companion object {
    private const val TAG = "TallyAvcEncoder"
    private const val MIME = MediaFormat.MIMETYPE_VIDEO_AVC

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
