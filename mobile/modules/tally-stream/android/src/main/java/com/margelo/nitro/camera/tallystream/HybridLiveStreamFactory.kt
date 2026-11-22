package com.margelo.nitro.camera.tallystream

import androidx.annotation.Keep
import com.facebook.proguard.annotations.DoNotStrip

import com.margelo.nitro.camera.HybridCameraOutputSpec

// Looked up by name from C++ (JNI): R8 must not rename or strip it in release builds.
@Keep
@DoNotStrip
class HybridLiveStreamFactory : HybridLiveStreamFactorySpec() {
  override fun createStreamer(): HybridLiveStreamerSpec = HybridLiveStreamer()

  override fun createStreamOutput(
    streamer: HybridLiveStreamerSpec,
    targetWidth: Double,
    targetHeight: Double,
  ): HybridCameraOutputSpec {
    val s = streamer as? HybridLiveStreamer
      ?: throw IllegalArgumentException("createStreamOutput: `streamer` must come from createStreamer()")
    return HybridLiveStreamOutput(s, targetWidth, targetHeight)
  }
}
