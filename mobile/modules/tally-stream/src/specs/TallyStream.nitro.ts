import type { HybridObject } from 'react-native-nitro-modules'
import type { CameraOutput } from 'react-native-vision-camera'

export type LiveStreamState = 'off' | 'connecting' | 'live' | 'error'

/**
 * H.264 profile. 'baseline' (Constrained Baseline) and 'main' decode reliably in Chromium's
 * WebRTC path (the hub plays MediaMTX WHEP in Electron); 'high' is hardware-dependent there.
 */
export type H264Profile = 'baseline' | 'main' | 'high'

export interface LiveStreamConfig {
  /** e.g. `srt://192.168.1.10:8890?streamid=publish:cam-a&latency=120` (latency in ms) */
  url: string
  /** Encoded size. iOS scales to exactly this; Android encodes the analysis size closest to it. */
  width: number
  height: number
  /** Target stream fps. Frames above this rate are dropped (decimated) before encoding. */
  fps: number
  bitrateKbps: number
  keyframeIntervalSec: number
  profile: H264Profile
}

export interface LiveStreamStats {
  state: LiveStreamState
  width: number
  height: number
  fps: number
  kbps: number
  sentFrames: number
  droppedFrames: number
  rttMs: number
  /** Profile actually in the SPS (parsed from the encoder output); undefined until the first keyframe. */
  profile?: H264Profile
  /** This app's CPU use over the last ~1 s as a share of all cores, 0..100 (-1 if unavailable). */
  cpuPct: number
  error?: string
}

export interface ThumbnailOptions {
  /** Minimum time between thumbnails (e.g. 250 = 4 Hz). Clamped to >= 1000/15 (15 fps max). */
  intervalMs: number
  /** Longest edge is scaled down to at most this many pixels (aspect preserved). */
  maxWidth: number
  /** JPEG quality, 0..1. */
  quality: number
}

export interface LiveStreamer
  extends HybridObject<{ ios: 'swift'; android: 'kotlin' }> {
  /** Starts encoding + sending. Safe to call again with a new config (restarts the stream). */
  start(config: LiveStreamConfig): void
  /** Stops the stream. Never affects local recording. */
  stop(): void
  /** Live bitrate change (thermal/congestion step-down). */
  setBitrate(kbps: number): void
  /** Live fps change by frame decimation (cannot exceed the camera fps). */
  setFps(fps: number): void
  getStats(): LiveStreamStats
  /** Called (on the JS thread) whenever `state` changes or an error occurs. Pass undefined to clear. */
  setStateListener(listener: ((stats: LiveStreamStats) => void) | undefined): void

  /**
   * Low-rate JPEG thumbnails from the same camera frames (for the hub's framing grid).
   * Works whether or not the live stream is running; never opens a second camera stream.
   */
  startThumbnails(options: ThumbnailOptions): void
  stopThumbnails(): void
  setThumbnailInterval(intervalMs: number): void
  /** Called on the JS thread with each JPEG. Pass undefined to clear. */
  setThumbnailListener(
    listener: ((jpeg: ArrayBuffer, width: number, height: number) => void) | undefined,
  ): void
}

export interface LiveStreamFactory
  extends HybridObject<{ ios: 'swift'; android: 'kotlin' }> {
  createStreamer(): LiveStreamer
  /**
   * Creates the VisionCamera output that feeds `streamer`.
   * Nitro can't (yet) express a HybridObject extending an external one in Swift,
   * so the control API lives on `LiveStreamer` and this returns a plain CameraOutput
   * (same pattern as react-native-vision-camera-barcode-scanner).
   */
  createStreamOutput(
    streamer: LiveStreamer,
    targetWidth: number,
    targetHeight: number,
  ): CameraOutput
}
