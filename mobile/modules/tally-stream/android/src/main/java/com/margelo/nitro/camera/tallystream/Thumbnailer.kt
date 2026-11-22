package com.margelo.nitro.camera.tallystream

import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.os.SystemClock
import androidx.camera.core.ImageProxy
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.ceil

/**
 * Low-rate JPEG thumbnails (up to 15 fps) from the analysis frames. The subsampled NV21 copy
 * happens on the analyzer thread (the ImageProxy closes right after; bulk row reads only);
 * JPEG compression (libjpeg-turbo via YuvImage) runs on its own thread. One in flight at a
 * time - frames are skipped while busy.
 */
internal class Thumbnailer(private val onJpeg: (ByteArray, Int, Int) -> Unit) {
  private data class Opts(val intervalMs: Double, val maxWidth: Int, val quality: Int)

  @Volatile private var opts: Opts? = null
  @Volatile private var nextDueMs = 0.0
  private val busy = AtomicBoolean(false)
  private val executor = Executors.newSingleThreadExecutor()
  private val yuv = YuvPlanes()

  val isEnabled: Boolean get() = opts != null

  fun start(intervalMs: Double, maxWidth: Double, quality: Double) {
    opts = Opts(
      intervalMs = maxOf(MIN_INTERVAL_MS, intervalMs),
      maxWidth = maxWidth.toInt().coerceIn(64, 1920),
      quality = (quality.coerceIn(0.1, 1.0) * 100).toInt(),
    )
    nextDueMs = 0.0
  }

  fun stop() {
    opts = null
  }

  /** Takes effect on the next frame. */
  fun setInterval(ms: Double) {
    opts = opts?.copy(intervalMs = maxOf(MIN_INTERVAL_MS, ms))
  }

  /** Analyzer thread. */
  fun offer(image: ImageProxy, rotation: Int) {
    val o = opts ?: return
    val now = SystemClock.elapsedRealtime().toDouble()
    if (now < nextDueMs) return
    if (!busy.compareAndSet(false, true)) return
    // Fixed schedule so the average rate matches the interval; re-anchor after a stall.
    nextDueMs = if (now - nextDueMs > o.intervalMs) now + o.intervalMs else nextDueMs + o.intervalMs
    val (nv21, w, h) = try {
      val step = maxOf(1, ceil(maxOf(image.width, image.height).toDouble() / o.maxWidth).toInt())
      yuv.thumbnailNv21(image, rotation, step)
    } catch (_: Throwable) {
      busy.set(false)
      return
    }
    executor.execute {
      try {
        val out = ByteArrayOutputStream(w * h / 4)
        YuvImage(nv21, ImageFormat.NV21, w, h, null).compressToJpeg(Rect(0, 0, w, h), o.quality, out)
        onJpeg(out.toByteArray(), w, h)
      } catch (_: Throwable) {
      } finally {
        busy.set(false)
      }
    }
  }

  fun release() {
    opts = null
    executor.shutdown()
  }

  companion object {
    const val MAX_FPS = 15.0
    const val MIN_INTERVAL_MS = 1000.0 / MAX_FPS
  }
}
