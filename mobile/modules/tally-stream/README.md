# react-native-tally-stream

Tally Cam's live feed and hub thumbnails, as a VisionCamera v5 custom `CameraOutput`.
The local 4K recording is untouched; this output only taps the same camera.

- **Live feed:** hardware H.264 (profile baseline / main / high, default main), no B-frames, 1 s GOP, rate-capped (iOS: VBR, peak 1.5× average over 1 s), SPS/PPS repeated before every IDR, sent as MPEG-TS over **SRT as the caller**, to MediaMTX on the hub (`srt://hub:8890?streamid=publish:<cam>&latency=120`). OBS and the hub's WebRTC (WHEP) player then read each phone from MediaMTX.
- **Thumbnails:** JPEGs up to 15 fps from the same frames for the hub grid. They work with the stream on or off.

| | iOS | Android |
|---|---|---|
| Camera tap | `AVCaptureVideoDataOutput`, NV12. Buffers are requested already downsized to the output's target (exact source aspect, orientation-aware; iOS 16+), falling back to preview-sized, then full-size buffers | CameraX `ImageAnalysis` (YUV_420_888); the slot VisionCamera leaves free |
| Encoder | VideoToolbox real-time VBR (AverageBitRate + DataRateLimits 1.5×/1 s and 2×/0.2 s), MaximizePowerEfficiency, profile keys with SPS verification; camera buffers at the target size go straight in, anything else is scaled/cropped once on the GPU | MediaCodec async, profile/level from the codec's advertised list (falls back to encoder defaults), CBR where supported, `KEY_LOW_LATENCY` on API 30+ |
| Mux + SRT | Own MPEG-TS muxer, then libsrt 1.5.7 (vendored static xcframework + OpenSSL-Universal) | RootEncoder `srt` 2.8.2 (pure Kotlin; MPEG-TS + SRT caller; prepends SPS/PPS to keyframes) |
| Thumbnails | GPU downscale (VTPixelTransferSession), then the hardware JPEG encoder (VideoToolbox `jpeg`), ImageIO as fallback | Bulk-row subsample to NV21 (rotation on the small array), then `YuvImage.compressToJpeg` (libjpeg-turbo) |

Measured on an Apple Silicon Mac with the harness (720p30 main-profile encode from 1080p frames): encode ≈ 3.1% of one core; hardware JPEG thumbnails at ~10/s add ≈ 0.3% (ImageIO ≈ 1.2%).

## Setup (app)
`mobile/package.json` dependencies: `"react-native-tally-stream": "file:./modules/tally-stream"`, then `npm install`. The Android/iOS autolinking only picks up dependencies listed there. Then run `pod install` / prebuild.

## JS
```js
import { useLiveStreamOutput } from '../modules/tally-stream'
const live = useLiveStreamOutput()            // stable object, or null if not linked
<Camera outputs={[video, live.output]} ... /> // attach before recording starts

live.startThumbnails({ fps: 12, maxWidth: 640, quality: 0.6 }) // or intervalMs; quality 0-1 or 0-100; max 15 fps
live.setThumbnailInterval(250)                                   // live, takes effect on the next frame
const off = live.onThumbnail((jpeg, w, h) => ws.send(jpeg))

live.start({ url: 'srt://192.168.1.10:8890?streamid=publish:cam-a&latency=120',
             width: 1920, height: 1080, fps: 60, bitrateKbps: 10000, profile: 'main' })
live.addListener((s) => {/* s.state: off | connecting | live | error, s.error */})
live.getStats()  // { state, width, height, fps, kbps, sentFrames, droppedFrames, rttMs,
                 //   profile (from the SPS; undefined until the first keyframe), cpuPct (app CPU, % of all cores; -1 if unknown), error }
live.setBitrate(6000); live.setFps(30)   // live thermal / congestion step-down
live.stop()
```

## Rebuilding specs
`npm run specs` (nitrogen 0.37.2) after editing `src/specs/TallyStream.nitro.ts`.
