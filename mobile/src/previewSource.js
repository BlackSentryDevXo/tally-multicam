// Hub preview thumbnails from the tally-stream native module (works on iOS, where VisionCamera's
// takeSnapshot() doesn't exist). Loaded optionally: the app runs unchanged if the module isn't built in.
//
// Expected from modules/tally-stream (any one of these hook names):
//   useLiveStreamOutput() (react-native-tally-stream) — also accepts useTallyStream / useStreamOutput
//   → { output: CameraOutput, start, stop, setBitrate, setFps, getStats, addListener,
//       startThumbnails?, stopThumbnails?, setThumbnailInterval?, onThumbnail? } | null
//     (or the CameraOutput itself carrying those methods)
//   startThumbnails({ intervalMs, maxWidth, quality }); stopThumbnails(); setThumbnailInterval(ms);
//   onThumbnail((jpeg: ArrayBuffer, width: number, height: number) => void) → optional unsubscribe fn
let mod = null;
try {
  mod = require('../modules/tally-stream');
} catch {}
let Images = null;
try {
  Images = require('react-native-nitro-image').Images;
} catch {}

const useNone = () => null;
const hook = (mod && (mod.useTallyStream || mod.useStreamOutput || mod.useLiveStreamOutput)) || useNone;

// Stable across renders (always the same hook), so it's safe to call unconditionally.
export function useStreamSource() {
  let r = null;
  try { r = hook(); } catch { r = null; }
  if (!r) return { live: null, output: null, thumbs: null };
  const output = r.output ?? r;
  const api = typeof r.startThumbnails === 'function' ? r : typeof output?.startThumbnails === 'function' ? output : null;
  return {
    live: typeof r.start === 'function' ? r : null, // the full live-feed controller (start/stop/stats…)
    output: output && typeof output === 'object' ? output : null,
    thumbs: api,
  };
}

// Decode a thumbnail JPEG to an Image (for the histogram). null when nitro-image can't.
export async function decodeJpeg(buffer, width, height) {
  if (!Images?.loadFromEncodedImageDataAsync) return null;
  return Images.loadFromEncodedImageDataAsync({ buffer, width, height, imageFormat: 'jpg' });
}
export const canDecodeJpeg = () => !!Images?.loadFromEncodedImageDataAsync;
