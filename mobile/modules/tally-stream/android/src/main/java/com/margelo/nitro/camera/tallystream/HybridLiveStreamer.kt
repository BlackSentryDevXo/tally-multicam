package com.margelo.nitro.camera.tallystream

import androidx.camera.core.ImageProxy
import com.margelo.nitro.core.ArrayBuffer

/** Nitro facade: live SRT feed (LiveEngine) + hub thumbnails (Thumbnailer), fed by HybridLiveStreamOutput. */
class HybridLiveStreamer : HybridLiveStreamerSpec() {
  @Volatile private var stateListener: ((LiveStreamStats) -> Unit)? = null
  @Volatile private var thumbnailListener: ((ArrayBuffer, Double, Double) -> Unit)? = null

  private val engine = LiveEngine { stats -> stateListener?.invoke(stats) }
  private val thumbnailer = Thumbnailer { jpeg, w, h ->
    thumbnailListener?.invoke(ArrayBuffer.copy(jpeg), w.toDouble(), h.toDouble())
  }

  internal val wantsFrames: Boolean get() = engine.isActive || thumbnailer.isEnabled

  /** Analyzer thread; the caller closes the image afterwards. */
  internal fun process(image: ImageProxy, rotation: Int) {
    thumbnailer.offer(image, rotation)
    engine.process(image, rotation)
  }

  override fun start(config: LiveStreamConfig) {
    require(config.width >= 16 && config.height >= 16 && config.fps >= 1 && config.bitrateKbps >= 100) {
      "Invalid live stream config: ${config.width}x${config.height}@${config.fps} ${config.bitrateKbps}kbps"
    }
    engine.start(if (config.keyframeIntervalSec > 0) config else config.copy(keyframeIntervalSec = 1.0))
  }

  override fun stop() = engine.stop()

  override fun setBitrate(kbps: Double) = engine.setBitrate(kbps)

  override fun setFps(fps: Double) = engine.setFps(fps)

  override fun getStats(): LiveStreamStats = engine.stats()

  override fun setStateListener(listener: ((stats: LiveStreamStats) -> Unit)?) {
    stateListener = listener
  }

  override fun startThumbnails(options: ThumbnailOptions) {
    thumbnailer.start(options.intervalMs, options.maxWidth, options.quality)
  }

  override fun stopThumbnails() = thumbnailer.stop()

  override fun setThumbnailInterval(intervalMs: Double) = thumbnailer.setInterval(intervalMs)

  override fun setThumbnailListener(listener: ((jpeg: ArrayBuffer, width: Double, height: Double) -> Unit)?) {
    thumbnailListener = listener
  }

  override fun dispose() {
    super.dispose()
    engine.stop()
    thumbnailer.release()
  }
}
