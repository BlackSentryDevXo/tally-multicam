import { Directory, File, Paths } from 'expo-file-system';

// Persisted state: hub pairing, camera name, camera settings, learned format support, clips not yet copied.
const cfgFile = new File(Paths.document, 'cemedia.json'); // filename kept so existing pairings survive the rename
export const loadCfg = () => { try { return JSON.parse(cfgFile.textSync()); } catch { return null; } };
export const saveCfg = (c) => { try { cfgFile.writeSync(JSON.stringify(c)); } catch (e) { console.warn('config save failed', e); } };

// Clips are written here (not the OS temp dir, which can be purged) and are never deleted automatically.
export const clipsDir = new Directory(Paths.document, 'Tally');
// Clips the hub has confirmed are moved here (still never deleted), so crash recovery only scans the top level.
export const sentDir = new Directory(Paths.document, 'Tally', 'sent');
const plainPath = (uri) => decodeURI(uri.replace(/^file:\/\//, '')).replace(/\/$/, '');
const safe = (s) => String(s || 'take').replace(/[^\w-]+/g, '-').slice(0, 60);
// "<session>__<timestamp>.mov": the session is recoverable from the name after a crash.
export const newClipPath = (session) => `${plainPath(clipsDir.uri)}/${safe(session)}__${Date.now()}.mov`;
export const sessionFromClip = (name) => name.split('__')[0] || 'recovered';
export const clipName = (path) => path.split('/').pop();
// Queued clips belong to the hub they were recorded for. Older jobs (no hubKey) count as this hub's.
export const jobIsForHub = (job, key) => !job.hubKey || !key || job.hubKey === key;

export const RES_LIST = [720, 1080, 2160];
export const FPS_LIST = [24, 25, 30, 50, 60];
export const RES_LABEL = { 720: '720p', 1080: '1080p', 2160: '4K' }; // same words as Tally Hub
export const LENS_IDS = ['ultra', 'wide', 'tele', 'front'];

const SETTINGS_VERSION = 3;
export const DEFAULT_SETTINGS = {
  res: 1080, fps: 25, lens: 'wide', zoom: 1, exposure: 0, torch: false,
  stabilization: false, hdr: false, codec: 'hevc',
  // phone-only preferences
  grid: false, meter: false, recSaver: true, histogram: false, mains: 50,
  v: SETTINGS_VERSION,
};
// v3: external mics → meter off by default; tripods → stabilization off; 50 Hz mains region by default.
export function loadSettings(saved) {
  const s = { ...DEFAULT_SETTINGS, ...saved };
  if (saved?.v !== SETTINGS_VERSION) Object.assign(s, { meter: false, stabilization: false, v: SETTINGS_VERSION });
  delete s.meterInRec;
  return s;
}
// Keys the hub may read/write (the protocol contract).
export const HUB_KEYS = ['res', 'fps', 'lens', 'zoom', 'exposure', 'torch', 'stabilization', 'hdr', 'codec'];
export const pickHub = (s) => Object.fromEntries(HUB_KEYS.map((k) => [k, s[k]]));

// Target bitrate in bits/s. Set explicitly so quality is consistent across phones and "time left" is honest.
// ponytail: fixed table; tune per phone model if footage looks starved
export function bitrate({ res, fps, codec }) {
  const mbps = { 720: 10, 1080: 20, 2160: 50 }[res] * (fps > 30 ? 1.5 : 1) * (codec === 'hevc' ? 0.7 : 1);
  return Math.round(mbps * 1e6);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const fileUri = (p) => (p.startsWith('file://') ? p : `file://${p}`);
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const today = () => new Date().toISOString().slice(0, 10);

export function fmtDuration(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s)}`;
}
export function fmtRemaining(sec) {
  if (!isFinite(sec)) return '—';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

// Nearest supported value; ties go to the lower one (a lower fps never surprises with a higher-res crop).
export function nearest(list, want) {
  return [...list].sort((a, b) => Math.abs(a - want) - Math.abs(b - want) || a - b)[0];
}
