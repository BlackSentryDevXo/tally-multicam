package com.margelo.nitro.camera.tallystream

import android.media.Image
import androidx.camera.core.ImageProxy
import java.nio.ByteBuffer
import kotlin.math.min

/**
 * YUV_420_888 helpers: copy camera frames into MediaCodec input images (with 0/90/180/270
 * rotation, any pixel/row strides) and build small NV21 thumbnails. All ByteBuffer traffic is
 * bulk row reads/writes into byte arrays, because per-element ByteBuffer access is slow on ART.
 */
internal class YuvPlanes {
  private var scratch = ByteArray(0)
  private var rowIn = ByteArray(0)
  private var rowOut = ByteArray(0)
  private var subY = ByteArray(0)
  private var subU = ByteArray(0)
  private var subV = ByteArray(0)

  /** Rotated output size for a source of `w x h`. */
  fun rotatedSize(w: Int, h: Int, rotation: Int): Pair<Int, Int> =
    if (rotation == 90 || rotation == 270) Pair(h, w) else Pair(w, h)

  /** Copies + rotates `src` into the codec input `dst` (whose size is the rotated size). */
  fun copy(src: ImageProxy, dst: Image, rotation: Int) {
    val w = src.width
    val h = src.height
    for (p in 0 until 3) {
      val pw = if (p == 0) w else (w + 1) / 2
      val ph = if (p == 0) h else (h + 1) / 2
      val s = src.planes[p]
      val d = dst.planes[p]
      copyPlane(s.buffer, s.rowStride, s.pixelStride, d.buffer, d.rowStride, d.pixelStride, pw, ph, rotation)
    }
  }

  private fun ensure(array: ByteArray, size: Int): ByteArray = if (array.size >= size) array else ByteArray(size)

  private fun copyPlane(
    srcBuf: ByteBuffer, srcRow: Int, srcPix: Int,
    dstBuf: ByteBuffer, dstRow: Int, dstPix: Int,
    w: Int, h: Int, rotation: Int,
  ) {
    val src = srcBuf.duplicate().apply { rewind() }
    val dst = dstBuf.duplicate().apply { rewind() }
    if (rotation == 0) {
      val inLen = (w - 1) * srcPix + 1
      val outLen = (w - 1) * dstPix + 1
      if (srcPix == 1 && dstPix == 1) {
        // Packed plane -> straight row copies (no per-byte work at all).
        for (y in 0 until h) {
          val pos = y * srcRow
          if (pos >= src.limit()) break
          src.limit(min(src.capacity(), pos + w)).position(pos)
          dst.position(y * dstRow)
          dst.put(src)
          src.limit(src.capacity())
        }
        return
      }
      // Interleaved chroma on either side: re-stride each row through byte arrays.
      rowIn = ensure(rowIn, inLen)
      rowOut = ensure(rowOut, outLen)
      for (y in 0 until h) {
        val pos = y * srcRow
        if (pos >= src.limit()) break
        src.position(pos)
        src.get(rowIn, 0, min(inLen, src.remaining()))
        dst.position(y * dstRow)
        val avail = min(outLen, dst.remaining())
        if (dstPix > 1) dst.get(rowOut, 0, avail) // keep the interleaved neighbour (other chroma) intact
        var si = 0
        var di = 0
        for (x in 0 until w) {
          rowOut[di] = rowIn[si]
          si += srcPix
          di += dstPix
        }
        dst.position(y * dstRow)
        dst.put(rowOut, 0, avail)
      }
      return
    }

    // Rotated: read the whole source plane once, then emit destination rows.
    val srcLen = src.remaining()
    scratch = ensure(scratch, srcLen)
    src.get(scratch, 0, srcLen)
    val (ow, oh) = rotatedSize(w, h, rotation)
    val outLen = (ow - 1) * dstPix + 1
    rowOut = ensure(rowOut, outLen)
    val a = scratch
    for (oy in 0 until oh) {
      dst.position(oy * dstRow)
      val avail = min(outLen, dst.remaining())
      if (dstPix > 1) dst.get(rowOut, 0, avail)
      var di = 0
      when (rotation) {
        90 -> { // (sx, sy) = (oy, h - 1 - ox)
          var si = (h - 1) * srcRow + oy * srcPix
          for (ox in 0 until ow) { rowOut[di] = a[si]; di += dstPix; si -= srcRow }
        }
        180 -> { // (sx, sy) = (w - 1 - ox, h - 1 - oy)
          var si = (h - 1 - oy) * srcRow + (w - 1) * srcPix
          for (ox in 0 until ow) { rowOut[di] = a[si]; di += dstPix; si -= srcPix }
        }
        else -> { // 270: (sx, sy) = (w - 1 - oy, ox)
          var si = (w - 1 - oy) * srcPix
          for (ox in 0 until ow) { rowOut[di] = a[si]; di += dstPix; si += srcRow }
        }
      }
      dst.position(oy * dstRow)
      dst.put(rowOut, 0, avail)
    }
  }

  /**
   * Subsampled + rotated NV21 (for YuvImage -> JPEG). `step` >= 1 is the integer downscale.
   * Returns (nv21, width, height). Cost: one bulk row read per sampled source row, then
   * small-array loops (~0.35 M byte moves for a 640x360 thumbnail).
   */
  fun thumbnailNv21(src: ImageProxy, rotation: Int, step: Int): Triple<ByteArray, Int, Int> {
    val sw = (src.width / step) and 1.inv()
    val sh = (src.height / step) and 1.inv()
    val cw = sw / 2
    val ch = sh / 2
    subY = ensure(subY, sw * sh)
    subU = ensure(subU, cw * ch)
    subV = ensure(subV, cw * ch)
    subsample(src.planes[0], sw, sh, step, subY)
    subsample(src.planes[1], cw, ch, step, subU)
    subsample(src.planes[2], cw, ch, step, subV)

    val (ow, oh) = rotatedSize(sw, sh, rotation)
    val out = ByteArray(ow * oh * 3 / 2)
    if (rotation == 0) {
      System.arraycopy(subY, 0, out, 0, sw * sh)
    } else {
      var o = 0
      for (oy in 0 until oh) for (ox in 0 until ow) out[o++] = subY[srcIndex(ox, oy, sw, sh, rotation)]
    }
    val (ocw, och) = rotatedSize(cw, ch, rotation)
    var o = ow * oh
    for (oy in 0 until och) {
      for (ox in 0 until ocw) {
        val i = srcIndex(ox, oy, cw, ch, rotation)
        out[o++] = subV[i]
        out[o++] = subU[i]
      }
    }
    return Triple(out, ow, oh)
  }

  /** Every `step`-th sample of a plane into a packed `ow x oh` array, one bulk read per row. */
  private fun subsample(plane: ImageProxy.PlaneProxy, ow: Int, oh: Int, step: Int, out: ByteArray) {
    val buf = plane.buffer.duplicate().apply { rewind() }
    val pix = plane.pixelStride
    val rowLen = (ow - 1) * step * pix + 1
    rowIn = ensure(rowIn, rowLen)
    val stride = step * pix
    for (oy in 0 until oh) {
      val pos = oy * step * plane.rowStride
      if (pos >= buf.limit()) break
      buf.position(pos)
      buf.get(rowIn, 0, min(rowLen, buf.remaining()))
      var si = 0
      val base = oy * ow
      for (ox in 0 until ow) {
        out[base + ox] = rowIn[si]
        si += stride
      }
    }
  }

  /** Index into an unrotated `w x h` array for output pixel (ox, oy) after `rotation`. */
  private fun srcIndex(ox: Int, oy: Int, w: Int, h: Int, rotation: Int): Int = when (rotation) {
    90 -> (h - 1 - ox) * w + oy
    180 -> (h - 1 - oy) * w + (w - 1 - ox)
    270 -> ox * w + (w - 1 - oy)
    else -> oy * w + ox
  }
}
