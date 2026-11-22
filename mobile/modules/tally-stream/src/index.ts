import { useEffect, useMemo, useRef } from 'react'
import { NitroModules } from 'react-native-nitro-modules'
import type { CameraOutput } from 'react-native-vision-camera'
import type {
  H264Profile,
  LiveStreamConfig,
  LiveStreamFactory,
  LiveStreamer,
  LiveStreamStats,
  ThumbnailOptions,
} from './specs/TallyStream.nitro'

export type {
  H264Profile,
  LiveStreamConfig,
  LiveStreamState,
  LiveStreamStats,
  ThumbnailOptions,
} from './specs/TallyStream.nitro'

// No-op-safe: if the native module isn't linked into this build, everything below returns null.
let factory: LiveStreamFactory | null = null
try {
  factory = NitroModules.createHybridObject<LiveStreamFactory>('LiveStreamFactory')
} catch {
  factory = null
}

export const isLiveStreamAvailable = factory != null

export interface StartOptions {
  /** `srt://<hub>:8890?streamid=publish:<cam>&latency=120` */
  url: string
  width?: number
  height?: number
  fps?: number
  bitrateKbps?: number
  keyframeIntervalSec?: number
  /**
   * H.264 profile; default 'main'. 'baseline' and 'main' decode reliably in Chromium's WebRTC
   * path (the hub plays MediaMTX WHEP in Electron); 'high' is hardware-dependent there.
   */
  profile?: H264Profile
}

export const MAX_THUMBNAIL_FPS = 15

export interface ThumbnailStartOptions {
  /** Minimum time between thumbnails. Clamped to 15 fps max. */
  intervalMs?: number
  /** Alternative to intervalMs: thumbnails per second, clamped to 15. */
  fps?: number
  maxWidth?: number
  /** 0..1 or 0..100 (both accepted). */
  quality?: number
}

export type ThumbnailCallback = (jpeg: ArrayBuffer, width: number, height: number) => void
export type StatsCallback = (stats: LiveStreamStats) => void

export interface LiveStream {
  /** Add to `<Camera outputs={[video, live.output]}>`. Stable for the lifetime of the hook. */
  output: CameraOutput
  start(options: StartOptions): void
  stop(): void
  setBitrate(kbps: number): void
  setFps(fps: number): void
  getStats(): LiveStreamStats
  /** State changes (off/connecting/live/error). Returns an unsubscribe function. */
  addListener(callback: StatsCallback): () => void
  startThumbnails(options?: ThumbnailStartOptions): void
  stopThumbnails(): void
  setThumbnailInterval(intervalMs: number): void
  /** Each JPEG thumbnail, on the JS thread. Returns an unsubscribe function. */
  onThumbnail(callback: ThumbnailCallback): () => void
  /** Stops everything and releases native resources. The hook calls this on unmount. */
  dispose(): void
}

const DEFAULT_SIZE = { width: 1920, height: 1080 }

/**
 * Creates a live stream + its CameraOutput. `targetWidth/Height` only hint the capture
 * buffer size (iOS uses preview-sized buffers when <= 1920; Android sizes its analysis
 * stream). The actual encoded size is set per `start()`.
 */
export function createLiveStream(
  targetWidth = DEFAULT_SIZE.width,
  targetHeight = DEFAULT_SIZE.height,
): LiveStream | null {
  if (factory == null) return null
  let streamer: LiveStreamer
  let output: CameraOutput
  try {
    streamer = factory.createStreamer()
    output = factory.createStreamOutput(streamer, targetWidth, targetHeight)
  } catch {
    return null
  }

  const stateListeners = new Set<StatsCallback>()
  const thumbListeners = new Set<ThumbnailCallback>()
  let disposed = false

  const syncStateListener = () => {
    streamer.setStateListener(
      stateListeners.size > 0
        ? (stats) => stateListeners.forEach((cb) => cb(stats))
        : undefined,
    )
  }
  const syncThumbListener = () => {
    streamer.setThumbnailListener(
      thumbListeners.size > 0
        ? (jpeg, w, h) => thumbListeners.forEach((cb) => cb(jpeg, w, h))
        : undefined,
    )
  }

  return {
    output,
    start(options) {
      if (disposed) return
      const config: LiveStreamConfig = {
        url: options.url,
        width: options.width ?? 1920,
        height: options.height ?? 1080,
        fps: options.fps ?? 30,
        bitrateKbps: options.bitrateKbps ?? 8000,
        keyframeIntervalSec: options.keyframeIntervalSec ?? 1,
        profile: options.profile ?? 'main',
      }
      streamer.start(config)
    },
    stop() {
      if (!disposed) streamer.stop()
    },
    setBitrate(kbps) {
      if (!disposed) streamer.setBitrate(kbps)
    },
    setFps(fps) {
      if (!disposed) streamer.setFps(fps)
    },
    getStats() {
      return streamer.getStats()
    },
    addListener(callback) {
      stateListeners.add(callback)
      syncStateListener()
      return () => {
        stateListeners.delete(callback)
        if (!disposed) syncStateListener()
      }
    },
    startThumbnails(options = {}) {
      if (disposed) return
      const rawQuality = options.quality ?? 0.6
      const requested = options.fps != null ? 1000 / options.fps : (options.intervalMs ?? 250)
      const thumb: ThumbnailOptions = {
        intervalMs: Math.max(1000 / MAX_THUMBNAIL_FPS, requested),
        maxWidth: options.maxWidth ?? 640,
        quality: rawQuality > 1 ? rawQuality / 100 : rawQuality,
      }
      streamer.startThumbnails(thumb)
    },
    stopThumbnails() {
      if (!disposed) streamer.stopThumbnails()
    },
    setThumbnailInterval(intervalMs) {
      if (!disposed) streamer.setThumbnailInterval(Math.max(1000 / MAX_THUMBNAIL_FPS, intervalMs))
    },
    onThumbnail(callback) {
      thumbListeners.add(callback)
      syncThumbListener()
      return () => {
        thumbListeners.delete(callback)
        if (!disposed) syncThumbListener()
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      stateListeners.clear()
      thumbListeners.clear()
      try {
        streamer.setStateListener(undefined)
        streamer.setThumbnailListener(undefined)
        streamer.stopThumbnails()
        streamer.stop()
      } catch {}
      // Release the native objects now instead of waiting for garbage collection.
      try {
        ;(output as unknown as { dispose?: () => void }).dispose?.()
      } catch {}
      try {
        ;(streamer as unknown as { dispose?: () => void }).dispose?.()
      } catch {}
    },
  }
}

/**
 * Stable LiveStream for a camera screen (same object across renders), or null when the
 * native module isn't in this build. Stops the stream and thumbnails on unmount.
 */
export function useLiveStreamOutput(): LiveStream | null {
  const live = useMemo(() => createLiveStream(), [])
  const mounts = useRef(0)
  // On unmount: stop at once, then dispose a tick later only if the component didn't mount again
  // (React StrictMode's dev double-effect unmounts and remounts synchronously; the stable object must survive).
  useEffect(() => {
    mounts.current += 1
    return () => {
      mounts.current -= 1
      try {
        live?.stopThumbnails()
        live?.stop()
      } catch {}
      setTimeout(() => {
        if (mounts.current === 0) live?.dispose()
      }, 0)
    }
  }, [live])
  return live
}

export const useTallyStream = useLiveStreamOutput
export const useStreamOutput = useLiveStreamOutput
