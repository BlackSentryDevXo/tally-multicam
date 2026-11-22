package com.margelo.nitro.camera.tallystream

import androidx.annotation.Keep
import com.facebook.proguard.annotations.DoNotStrip

import android.util.Log
import androidx.camera.core.CameraEffect
import androidx.core.util.Consumer
import com.margelo.nitro.camera.CameraOrientation
import com.margelo.nitro.camera.HybridCameraOutputSpec
import com.margelo.nitro.camera.MediaType
import com.margelo.nitro.camera.MirrorMode
import com.margelo.nitro.camera.TargetColorSpace
import com.margelo.nitro.camera.TargetDynamicRangeBitDepth
import com.margelo.nitro.camera.public.NativeCameraOutput

/**
 * VisionCamera v5 custom CameraOutput that adds no stream of its own: it contributes a CameraX [CameraEffect]
 * on the Preview stream only (never VideoCapture, so a GL problem can't reach a recording). Its [GlRenderer]
 * passes preview frames through and also draws them into the live encoder and the thumbnail reader.
 * (The patched VisionCamera session adds output effects to the SessionConfig.)
 */
// Looked up by name from C++ (JNI): R8 must not rename or strip it in release builds.
@Keep
@DoNotStrip
class HybridLiveStreamOutput(
  private val streamer: HybridLiveStreamer,
  @Suppress("UNUSED_PARAMETER") targetWidth: Double,
  @Suppress("UNUSED_PARAMETER") targetHeight: Double,
) : HybridCameraOutputSpec(),
  NativeCameraOutput {
  private val renderer = GlRenderer(streamer)
  private val effect: CameraEffect = PreviewEffect(renderer)

  override val mediaType: MediaType = MediaType.VIDEO
  override var outputOrientation: CameraOrientation = CameraOrientation.UP
    set(value) {
      if (value != field) Log.i("TallyLiveStream", "Output orientation: $value")
      field = value
      renderer.orientation = value
    }
  override val currentResolution: com.margelo.nitro.camera.Size?
    get() = renderer.feedSize?.let { com.margelo.nitro.camera.Size(it.width.toDouble(), it.height.toDouble()) }
  override val mirrorMode: MirrorMode = MirrorMode.AUTO

  override fun createUseCase(
    mirrorMode: MirrorMode,
    config: NativeCameraOutput.Config,
  ): NativeCameraOutput.PreparedUseCase {
    // A 10-bit HDR preview can't go through this 8-bit GL path; leave the session untouched instead.
    val range = config.videoDynamicRange
    val hdr = range != null && (
      range.bitDepth == TargetDynamicRangeBitDepth.HDR_10_BIT ||
        range.colorSpace == TargetColorSpace.HLG_BT2020 ||
        range.colorSpace == TargetColorSpace.DOLBY_VISION
      )
    return NativeCameraOutput.PreparedUseCase(null, if (hdr) null else effect) {
      streamer.engine.setSourceIssue(if (hdr) "Live feed and previews are off while recording HDR on Android" else null)
    }
  }

  override fun dispose() {
    super.dispose()
    renderer.release()
  }

  private class PreviewEffect(renderer: GlRenderer) :
    CameraEffect(CameraEffect.PREVIEW, renderer.executor, renderer, Consumer { e -> Log.e("TallyLiveStream", "Preview effect error", e) })
}
