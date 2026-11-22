package com.margelo.nitro.camera.tallystream

import com.margelo.nitro.camera.HybridCameraOutputSpec

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
