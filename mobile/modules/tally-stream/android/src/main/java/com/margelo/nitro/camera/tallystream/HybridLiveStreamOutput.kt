package com.margelo.nitro.camera.tallystream

import android.util.Size
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import com.margelo.nitro.camera.CameraOrientation
import com.margelo.nitro.camera.HybridCameraOutputSpec
import com.margelo.nitro.camera.MediaType
import com.margelo.nitro.camera.MirrorMode
import com.margelo.nitro.camera.extensions.converters.toSize
import com.margelo.nitro.camera.extensions.surfaceRotation
import com.margelo.nitro.camera.public.NativeCameraOutput
import java.util.concurrent.Executors

/**
 * VisionCamera v5 custom CameraOutput backed by a CameraX ImageAnalysis (YUV_420_888) use case.
 * CameraX binds at most one use case of each type and VisionCamera already uses Preview +
 * VideoCapture, so ImageAnalysis is the slot left; CameraX stream-sharing handles devices that
 * can't run three streams natively.
 */
class HybridLiveStreamOutput(
  private val streamer: HybridLiveStreamer,
  targetWidth: Double,
  targetHeight: Double,
) : HybridCameraOutputSpec(),
  NativeCameraOutput,
  ImageAnalysis.Analyzer {
  override val mediaType: MediaType = MediaType.VIDEO
  override var outputOrientation: CameraOrientation = CameraOrientation.UP
    set(value) {
      field = value
      imageAnalysis?.targetRotation = value.surfaceRotation
    }
  override val currentResolution: com.margelo.nitro.camera.Size?
    get() = imageAnalysis?.resolutionInfo?.resolution?.toSize()
  override val mirrorMode: MirrorMode = MirrorMode.AUTO

  private var imageAnalysis: ImageAnalysis? = null
  private val executor = Executors.newSingleThreadExecutor()
  // Analysis resolutions are sensor-oriented (landscape).
  private val target = Size(maxOf(targetWidth, targetHeight).toInt(), minOf(targetWidth, targetHeight).toInt())

  override fun createUseCase(
    mirrorMode: MirrorMode,
    config: NativeCameraOutput.Config,
  ): NativeCameraOutput.PreparedUseCase {
    val selector = ResolutionSelector.Builder()
      .setResolutionStrategy(ResolutionStrategy(target, ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER))
      .build()
    val analysis = ImageAnalysis.Builder()
      .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_YUV_420_888)
      .setOutputImageRotationEnabled(false) // we rotate while copying (cheaper than CameraX's extra pass)
      .setResolutionSelector(selector)
      .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
      .setTargetRotation(outputOrientation.surfaceRotation)
      .build()
    return NativeCameraOutput.PreparedUseCase(analysis) {
      imageAnalysis = analysis
      analysis.setAnalyzer(executor, this)
    }
  }

  override fun analyze(image: ImageProxy) {
    try {
      if (streamer.wantsFrames) streamer.process(image, image.imageInfo.rotationDegrees)
    } catch (_: Throwable) {
      // Never let a streaming/thumbnail problem propagate into the camera pipeline.
    } finally {
      image.close()
    }
  }

  override fun dispose() {
    super.dispose()
    imageAnalysis?.clearAnalyzer()
    executor.shutdown()
  }
}
