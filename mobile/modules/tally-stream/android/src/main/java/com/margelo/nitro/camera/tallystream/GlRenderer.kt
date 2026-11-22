package com.margelo.nitro.camera.tallystream

import android.annotation.SuppressLint
import android.graphics.SurfaceTexture
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLExt
import android.opengl.EGLSurface
import android.opengl.GLES11Ext
import android.opengl.GLES20
import android.opengl.Matrix
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.util.Size
import android.view.Surface
import androidx.camera.core.CameraInfo
import androidx.camera.core.CameraSelector
import androidx.camera.core.SurfaceOutput
import androidx.camera.core.SurfaceProcessor
import androidx.camera.core.SurfaceRequest
import com.margelo.nitro.camera.CameraOrientation
import com.margelo.nitro.camera.extensions.surfaceRotation
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.util.concurrent.Executor

/**
 * CameraX [SurfaceProcessor] on the Preview stream (never VideoCapture, so a GL fault can't touch a
 * recording). Each camera frame (an OES texture) is drawn:
 *  1. to the preview output, pass-through, with CameraX's transform;
 *  2. to the live encoder's input surface (LiveEngine decides which frames), scaled and centre-cropped to the
 *     feed size and rotated sensor -> upright for [orientation];
 *  3. now and then into a small offscreen buffer read back with glReadPixels for a JPEG thumbnail.
 * Everything runs on one GL thread. Problems in 2 and 3 are caught so the preview keeps running.
 */
internal class GlRenderer(private val streamer: HybridLiveStreamer) : SurfaceProcessor {
  private val thread = HandlerThread("tally-gl").apply { start() }
  private val handler = Handler(thread.looper)
  val executor = Executor { r -> handler.post(r) }

  /** Device orientation the feed and thumbnails are uprighted for (VisionCamera sets it from the sensor). */
  @Volatile var orientation: CameraOrientation = CameraOrientation.UP

  /** Feed (encoder) size actually being produced, for the output's `currentResolution`. */
  @Volatile var feedSize: Size? = null
    private set

  private class Input(
    val texture: Int,
    val surfaceTexture: SurfaceTexture,
    val surface: Surface,
    val size: Size,
    val cameraInfo: CameraInfo,
  )

  private class Output(val surfaceOutput: SurfaceOutput, val eglSurface: EGLSurface, val size: Size)

  // GL thread state
  private var display: EGLDisplay = EGL14.EGL_NO_DISPLAY
  private var context: EGLContext = EGL14.EGL_NO_CONTEXT
  private var eglConfig: EGLConfig? = null
  private var pbuffer: EGLSurface = EGL14.EGL_NO_SURFACE
  private var program = 0
  private var aPosition = 0
  private var aTexCoord = 0
  private var uTexMatrix = 0
  private var input: Input? = null
  private val outputs = ArrayList<Output>()
  private val encoderSurfaces = HashMap<AvcEncoder, EGLSurface>()
  private var thumbFbo = 0
  private var thumbTex = 0
  private var thumbSize: Size? = null
  @Volatile private var released = false

  private val stMatrix = FloatArray(16)
  private val outMatrix = FloatArray(16)
  private val extra = FloatArray(16)
  private val desired = FloatArray(16)
  private val predicted = FloatArray(16)

  init {
    // Encoders are created and destroyed on the GL thread, which owns their EGL surfaces.
    streamer.engine.releaser = { enc -> if (!handler.post { dropEncoder(enc) }) enc.release() }
  }

  // MARK: SurfaceProcessor (GL thread: CameraX calls these on [executor])

  @SuppressLint("RestrictedApi")
  override fun onInputSurface(request: SurfaceRequest) {
    if (released || !ensureGl()) {
      request.willNotProvideSurface()
      return
    }
    makeCurrent(pbuffer)
    val tex = IntArray(1).also { GLES20.glGenTextures(1, it, 0) }[0]
    GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, tex)
    GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
    GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
    GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
    GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
    val st = SurfaceTexture(tex).apply { setDefaultBufferSize(request.resolution.width, request.resolution.height) }
    val surface = Surface(st)
    val inp = Input(tex, st, surface, request.resolution, request.camera.cameraInfoInternal)
    input = inp
    st.setOnFrameAvailableListener({ onFrame(inp) }, handler)
    request.provideSurface(surface, executor) {
      st.setOnFrameAvailableListener(null)
      if (input === inp) input = null
      if (!released) makeCurrent(pbuffer)
      st.release()
      surface.release()
      if (!released) GLES20.glDeleteTextures(1, intArrayOf(tex), 0)
    }
  }

  override fun onOutputSurface(surfaceOutput: SurfaceOutput) {
    if (released || !ensureGl()) {
      surfaceOutput.close()
      return
    }
    val surface = surfaceOutput.getSurface(executor) { removeOutput(surfaceOutput) }
    val egl = createWindowSurface(surface)
    if (egl == null) {
      surfaceOutput.close()
      return
    }
    outputs.add(Output(surfaceOutput, egl, surfaceOutput.size))
  }

  private fun removeOutput(surfaceOutput: SurfaceOutput) {
    val o = outputs.firstOrNull { it.surfaceOutput === surfaceOutput }
    if (o != null) {
      outputs.remove(o)
      destroySurface(o.eglSurface)
    }
    surfaceOutput.close()
  }

  // MARK: Frames

  private fun onFrame(inp: Input) {
    if (released || input !== inp) return
    try {
      makeCurrent(pbuffer)
      inp.surfaceTexture.updateTexImage()
    } catch (e: Throwable) {
      Log.w(TAG, "updateTexImage failed", e)
      return
    }
    inp.surfaceTexture.getTransformMatrix(stMatrix)
    val ts = inp.surfaceTexture.timestamp
    GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
    GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, inp.texture)

    // 1. Preview, pass-through.
    for (o in outputs) {
      try {
        o.surfaceOutput.updateTransformMatrix(outMatrix, stMatrix)
        if (!makeCurrent(o.eglSurface)) continue
        draw(outMatrix, o.size.width, o.size.height)
        // No eglPresentationTimeANDROID here: camera timestamps may be in another clock base (BOOTTIME on
        // Samsung), and a "desired present time" from it can make SurfaceFlinger hold or bunch preview frames.
        EGL14.eglSwapBuffers(display, o.eglSurface)
      } catch (e: Throwable) {
        Log.w(TAG, "Preview draw failed", e)
      }
    }

    val rotation = try {
      inp.cameraInfo.getSensorRotationDegrees(orientation.surfaceRotation)
    } catch (_: Throwable) {
      0
    }
    val swap = rotation % 180 != 0
    val uprightW = if (swap) inp.size.height else inp.size.width
    val uprightH = if (swap) inp.size.width else inp.size.height

    // 2. Live encoder.
    try {
      encode(ts, rotation, uprightW, uprightH)
    } catch (e: Throwable) {
      Log.w(TAG, "Encoder draw failed", e)
    }
    // 3. Thumbnail.
    try {
      thumbnail(rotation, uprightW, uprightH)
    } catch (e: Throwable) {
      streamer.thumbnailer.cancel()
      Log.w(TAG, "Thumbnail failed", e)
    }
  }

  private fun encode(ts: Long, rotation: Int, uprightW: Int, uprightH: Int) {
    val frame = streamer.engine.acquireFrame(ts, uprightW >= uprightH) ?: return
    val enc = frame.encoder
    feedSize = Size(enc.width, enc.height)
    var egl = encoderSurfaces[enc]
    if (egl == null) {
      egl = createWindowSurface(enc.inputSurface) ?: run {
        streamer.engine.onEncoderError(IllegalStateException("Couldn't attach the encoder surface"))
        return
      }
      encoderSurfaces[enc] = egl
    }
    if (!makeCurrent(egl)) return
    uprightTransform(rotation, uprightW, uprightH, enc.width, enc.height, flipV = false)
    draw(outMatrix, enc.width, enc.height)
    EGLExt.eglPresentationTimeANDROID(display, egl, frame.ptsNs)
    if (EGL14.eglSwapBuffers(display, egl)) {
      enc.frameQueued()
    } else {
      streamer.engine.onEncoderError(IllegalStateException("eglSwapBuffers: 0x${Integer.toHexString(EGL14.eglGetError())}"))
    }
  }

  private fun thumbnail(rotation: Int, uprightW: Int, uprightH: Int) {
    val opts = streamer.thumbnailer.due() ?: return
    // 16:9 (or 9:16 upright) like the recording; longest edge <= maxWidth and never upscaled.
    val landscape = uprightW >= uprightH
    val long = minOf(opts.maxWidth, maxOf(uprightW, uprightH))
    val short = (long * 9 / 16) and 1.inv()
    val w = if (landscape) long and 1.inv() else short
    val h = if (landscape) short else long and 1.inv()
    if (w < 16 || h < 16) {
      streamer.thumbnailer.cancel()
      return
    }
    makeCurrent(pbuffer)
    ensureThumbTarget(w, h)
    GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, thumbFbo)
    // glReadPixels returns the bottom row first; flip so the bitmap is top-down.
    uprightTransform(rotation, uprightW, uprightH, w, h, flipV = true)
    draw(outMatrix, w, h)
    val buf = ByteBuffer.allocateDirect(w * h * 4).order(ByteOrder.nativeOrder())
    GLES20.glReadPixels(0, 0, w, h, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, buf)
    GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0)
    buf.rewind()
    streamer.thumbnailer.submit(buf, w, h, opts.quality)
  }

  private fun ensureThumbTarget(w: Int, h: Int) {
    if (thumbSize?.width == w && thumbSize?.height == h && thumbFbo != 0) return
    if (thumbFbo != 0) {
      GLES20.glDeleteFramebuffers(1, intArrayOf(thumbFbo), 0)
      GLES20.glDeleteTextures(1, intArrayOf(thumbTex), 0)
    }
    thumbTex = IntArray(1).also { GLES20.glGenTextures(1, it, 0) }[0]
    GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, thumbTex)
    GLES20.glTexImage2D(GLES20.GL_TEXTURE_2D, 0, GLES20.GL_RGBA, w, h, 0, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, null)
    GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
    GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
    thumbFbo = IntArray(1).also { GLES20.glGenFramebuffers(1, it, 0) }[0]
    GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, thumbFbo)
    GLES20.glFramebufferTexture2D(GLES20.GL_FRAMEBUFFER, GLES20.GL_COLOR_ATTACHMENT0, GLES20.GL_TEXTURE_2D, thumbTex, 0)
    GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0)
    // Re-bind the camera texture (glBindTexture above replaced the 2D binding only, but be explicit).
    input?.let { GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, it.texture) }
    thumbSize = Size(w, h)
  }

  /**
   * outMatrix = stMatrix x A^-1 x D, the way CameraX's own SurfaceOutput builds its transforms:
   *  - A predicts the SurfaceTexture transform: Camera2 already writes the sensor orientation (and the front
   *    camera's mirroring) into the buffer transform, plus the GL vertical flip; A^-1 undoes exactly that.
   *  - D is what we want: GL flip, rotate by [rotation] (sensor -> upright for the device orientation), never
   *    mirrored (like the recording), centre-cropped to the destination aspect, optionally flipped vertically
   *    (glReadPixels returns the bottom row first).
   */
  private fun uprightTransform(rotation: Int, srcW: Int, srcH: Int, dstW: Int, dstH: Int, flipV: Boolean) {
    val info = input?.cameraInfo
    val srcAspect = srcW.toFloat() / srcH
    val dstAspect = dstW.toFloat() / dstH
    val sx = if (srcAspect > dstAspect) dstAspect / srcAspect else 1f
    val sy = if (srcAspect > dstAspect) 1f else srcAspect / dstAspect

    Matrix.setIdentityM(desired, 0)
    verticalFlip(desired)
    rotate(desired, rotation.toFloat())
    Matrix.translateM(desired, 0, 0.5f, 0.5f, 0f)
    Matrix.scaleM(desired, 0, sx, if (flipV) -sy else sy, 1f)
    Matrix.translateM(desired, 0, -0.5f, -0.5f, 0f)

    Matrix.setIdentityM(predicted, 0)
    verticalFlip(predicted)
    rotate(predicted, (info?.sensorRotationDegrees ?: 0).toFloat())
    if (info?.lensFacing == CameraSelector.LENS_FACING_FRONT) {
      Matrix.translateM(predicted, 0, 1f, 0f, 0f)
      Matrix.scaleM(predicted, 0, -1f, 1f, 1f)
    }
    Matrix.invertM(extra, 0, predicted, 0)
    Matrix.multiplyMM(predicted, 0, extra, 0, desired, 0)
    Matrix.multiplyMM(outMatrix, 0, stMatrix, 0, predicted, 0)
  }

  private fun verticalFlip(m: FloatArray) {
    Matrix.translateM(m, 0, 0f, 0.5f, 0f)
    Matrix.scaleM(m, 0, 1f, -1f, 1f)
    Matrix.translateM(m, 0, 0f, -0.5f, 0f)
  }

  private fun rotate(m: FloatArray, degrees: Float) {
    Matrix.translateM(m, 0, 0.5f, 0.5f, 0f)
    Matrix.rotateM(m, 0, degrees, 0f, 0f, 1f)
    Matrix.translateM(m, 0, -0.5f, -0.5f, 0f)
  }

  private fun draw(texMatrix: FloatArray, width: Int, height: Int) {
    GLES20.glViewport(0, 0, width, height)
    GLES20.glUseProgram(program)
    GLES20.glUniformMatrix4fv(uTexMatrix, 1, false, texMatrix, 0)
    GLES20.glEnableVertexAttribArray(aPosition)
    GLES20.glVertexAttribPointer(aPosition, 2, GLES20.GL_FLOAT, false, 0, QUAD_POS)
    GLES20.glEnableVertexAttribArray(aTexCoord)
    GLES20.glVertexAttribPointer(aTexCoord, 2, GLES20.GL_FLOAT, false, 0, QUAD_TEX)
    GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
  }

  // MARK: Encoders

  private fun dropEncoder(enc: AvcEncoder) {
    encoderSurfaces.remove(enc)?.let { destroySurface(it) }
    if (encoderSurfaces.isEmpty()) feedSize = null
    enc.release()
  }

  // MARK: EGL

  private fun ensureGl(): Boolean {
    if (context != EGL14.EGL_NO_CONTEXT) return true
    try {
      display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
      val version = IntArray(2)
      check(EGL14.eglInitialize(display, version, 0, version, 1)) { "eglInitialize" }
      eglConfig = chooseConfig(alpha = 8) ?: chooseConfig(alpha = 0) ?: error("No recordable EGL config")
      context = EGL14.eglCreateContext(
        display, eglConfig, EGL14.EGL_NO_CONTEXT,
        intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE), 0,
      )
      check(context != EGL14.EGL_NO_CONTEXT) { "eglCreateContext" }
      pbuffer = EGL14.eglCreatePbufferSurface(
        display, eglConfig, intArrayOf(EGL14.EGL_WIDTH, 1, EGL14.EGL_HEIGHT, 1, EGL14.EGL_NONE), 0,
      )
      check(makeCurrent(pbuffer)) { "eglMakeCurrent" }
      program = buildProgram()
      aPosition = GLES20.glGetAttribLocation(program, "aPosition")
      aTexCoord = GLES20.glGetAttribLocation(program, "aTexCoord")
      uTexMatrix = GLES20.glGetUniformLocation(program, "uTexMatrix")
      return true
    } catch (e: Throwable) {
      Log.e(TAG, "GL init failed", e)
      releaseGl()
      return false
    }
  }

  private fun chooseConfig(alpha: Int): EGLConfig? {
    val attribs = intArrayOf(
      EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8, EGL14.EGL_BLUE_SIZE, 8, EGL14.EGL_ALPHA_SIZE, alpha,
      EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
      EGL14.EGL_SURFACE_TYPE, EGL14.EGL_WINDOW_BIT or EGL14.EGL_PBUFFER_BIT,
      EGL_RECORDABLE_ANDROID, 1,
      EGL14.EGL_NONE,
    )
    val configs = arrayOfNulls<EGLConfig>(1)
    val count = IntArray(1)
    if (!EGL14.eglChooseConfig(display, attribs, 0, configs, 0, 1, count, 0) || count[0] < 1) return null
    return configs[0]
  }

  private fun createWindowSurface(surface: Surface): EGLSurface? {
    val s = EGL14.eglCreateWindowSurface(display, eglConfig, surface, intArrayOf(EGL14.EGL_NONE), 0)
    if (s == null || s == EGL14.EGL_NO_SURFACE) {
      Log.w(TAG, "eglCreateWindowSurface: 0x${Integer.toHexString(EGL14.eglGetError())}")
      return null
    }
    return s
  }

  private fun destroySurface(s: EGLSurface) {
    if (display == EGL14.EGL_NO_DISPLAY) return
    makeCurrent(pbuffer)
    EGL14.eglDestroySurface(display, s)
  }

  private fun makeCurrent(s: EGLSurface): Boolean = EGL14.eglMakeCurrent(display, s, s, context)

  private fun buildProgram(): Int {
    fun shader(type: Int, src: String): Int {
      val s = GLES20.glCreateShader(type)
      GLES20.glShaderSource(s, src.trimIndent())
      GLES20.glCompileShader(s)
      val ok = IntArray(1)
      GLES20.glGetShaderiv(s, GLES20.GL_COMPILE_STATUS, ok, 0)
      check(ok[0] != 0) { "Shader: ${GLES20.glGetShaderInfoLog(s)}" }
      return s
    }
    val p = GLES20.glCreateProgram()
    GLES20.glAttachShader(p, shader(GLES20.GL_VERTEX_SHADER, VERTEX))
    GLES20.glAttachShader(p, shader(GLES20.GL_FRAGMENT_SHADER, FRAGMENT))
    GLES20.glLinkProgram(p)
    val ok = IntArray(1)
    GLES20.glGetProgramiv(p, GLES20.GL_LINK_STATUS, ok, 0)
    check(ok[0] != 0) { "Program: ${GLES20.glGetProgramInfoLog(p)}" }
    return p
  }

  private fun releaseGl() {
    if (display != EGL14.EGL_NO_DISPLAY) {
      EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
      if (pbuffer != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(display, pbuffer)
      if (context != EGL14.EGL_NO_CONTEXT) EGL14.eglDestroyContext(display, context)
      EGL14.eglTerminate(display)
    }
    display = EGL14.EGL_NO_DISPLAY
    context = EGL14.EGL_NO_CONTEXT
    pbuffer = EGL14.EGL_NO_SURFACE
  }

  /** Tears the GL thread down. Encoders still alive are released directly from now on. */
  fun release() {
    streamer.engine.releaser = { it.release() }
    handler.post {
      if (released) return@post
      released = true
      input?.let { it.surfaceTexture.setOnFrameAvailableListener(null) }
      input = null
      outputs.toList().forEach { removeOutput(it.surfaceOutput) }
      encoderSurfaces.keys.toList().forEach { dropEncoder(it) }
      releaseGl()
      thread.quitSafely()
    }
  }

  companion object {
    private const val TAG = "TallyGlRenderer"
    private const val EGL_RECORDABLE_ANDROID = 0x3142

    private const val VERTEX = """
      uniform mat4 uTexMatrix;
      attribute vec4 aPosition;
      attribute vec4 aTexCoord;
      varying highp vec2 vTexCoord;
      void main() {
        gl_Position = aPosition;
        vTexCoord = (uTexMatrix * aTexCoord).xy;
      }
    """

    private const val FRAGMENT = """
      #extension GL_OES_EGL_image_external : require
      precision highp float;
      uniform samplerExternalOES sTexture;
      varying highp vec2 vTexCoord;
      void main() {
        gl_FragColor = texture2D(sTexture, vTexCoord);
      }
    """

    private fun floats(vararg v: Float): FloatBuffer =
      ByteBuffer.allocateDirect(v.size * 4).order(ByteOrder.nativeOrder()).asFloatBuffer().apply {
        put(v)
        position(0)
      }

    private val QUAD_POS = floats(-1f, -1f, 1f, -1f, -1f, 1f, 1f, 1f)
    private val QUAD_TEX = floats(0f, 0f, 1f, 0f, 0f, 1f, 1f, 1f)
  }
}
