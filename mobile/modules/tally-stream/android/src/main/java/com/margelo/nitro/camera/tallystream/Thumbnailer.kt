package com.margelo.nitro.camera.tallystream

import android.graphics.Bitmap
import android.os.SystemClock
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Low-rate JPEG thumbnails (up to 15 fps). GlRenderer asks [due] once per camera frame; when one is due it
 * draws a small upright frame, reads it back (glReadPixels, RGBA) and hands it to [submit]. JPEG compression
 * runs on its own thread. One in flight at a time - frames are skipped while busy.
 */
internal class Thumbnailer(private val onJpeg: (ByteArray, Int, Int) -> Unit) {
  data class Opts(val intervalMs: Double, val maxWidth: Int, val quality: Int)

  @Volatile private var opts: Opts? = null
  @Volatile private var nextDueMs = 0.0
  private val busy = AtomicBoolean(false)
  private val executor = Executors.newSingleThreadExecutor()

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

  /** GL thread: the options to render a thumbnail with now, or null. A non-null result must be [submit]ted or [cancel]led. */
  fun due(): Opts? {
    val o = opts ?: return null
    val now = SystemClock.elapsedRealtime().toDouble()
    if (now < nextDueMs) return null
    if (!busy.compareAndSet(false, true)) return null
    // Fixed schedule so the average rate matches the interval; re-anchor after a stall.
    nextDueMs = if (now - nextDueMs > o.intervalMs) now + o.intervalMs else nextDueMs + o.intervalMs
    return o
  }

  fun cancel() {
    busy.set(false)
  }

  /** GL thread: `rgba` is top-down RGBA_8888, w*h*4 bytes, owned by this call from now on. */
  fun submit(rgba: ByteBuffer, w: Int, h: Int, quality: Int) {
    try {
      executor.execute {
        try {
          val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
          bmp.copyPixelsFromBuffer(rgba)
          val out = ByteArrayOutputStream(w * h / 4)
          bmp.compress(Bitmap.CompressFormat.JPEG, quality, out)
          bmp.recycle()
          onJpeg(out.toByteArray(), w, h)
        } catch (_: Throwable) {
        } finally {
          busy.set(false)
        }
      }
    } catch (_: Throwable) {
      busy.set(false) // executor shut down
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
