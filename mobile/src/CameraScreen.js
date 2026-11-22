import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Animated, AppState, PanResponder, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Brightness from 'expo-brightness';
import { StatusBar } from 'expo-status-bar';
import { File, Paths } from 'expo-file-system';
import * as Battery from 'expo-battery';
import { useKeepAwake } from 'expo-keep-awake';
import { Ionicons } from '@expo/vector-icons';
import { Camera, CommonDynamicRanges, useVideoOutput } from 'react-native-vision-camera';
import { waitUntil } from '../clock';
import { useHubLink } from './useHubLink';
import { RES_SIZE, useFormatSupport, useLenses } from './capabilities';
import { LevelMeter, MicSource } from './AudioMeter';
import { FormatSheet, ProPanel, fmtShutter, useLiveReadout } from './panels';
import { C, FocusReticle, Grid, IconButton, RecordButton, RotContext, SP, StatCell, T, Tag, Toast, haptic, mono } from './controls';
import {
  RES_LABEL, bitrate, clamp, fileUri, fmtDuration, fmtRemaining, jobIsForHub, loadSettings, nearest, newClipPath, pickHub, sleep, today,
} from './config';
import { readThermal, thermalColor, thermalText } from './thermal';
import { fpsBeats, shutterFlickers } from './pairing';
import { canDecodeJpeg, decodeJpeg, useStreamSource } from './previewSource';
import { physicalDelta, physicalInsets, physicalToWindow, useDeviceRotation } from './orientation';
import { PILL_W, fitStatusPills } from './layout';

const OLD_ANDROID = Platform.OS === 'android' && Platform.Version < 29; // no concurrent mic capture before Android 10
const LOCK_MS = 600;
const SAVER_IDLE_MS = 5000;
const SAVER_BRIGHTNESS = 0.05;
const HOT_BRIGHTNESS = 0.01;
const PREV_TAKE_WAIT_MS = 6000; // how long a new take waits for the previous one to finish writing
const STOP_CONFIRM_MS = 8000; // a stop the recorder never confirms is retried, then the take is released
const MAX_FRAME_BYTES = 1_000_000; // never send the hub a preview bigger than this
// Hub preview thumbnails. Defaults until the hub sends {t:'preview', fps, maxWidth}; the caps always apply.
const PREVIEW_W = 640;
const PREVIEW_FPS = { max: 15, connected: 12, recording: 6, dimmed: 2, histogramOnly: 3 };
const HIST_MIN_MS = 334; // histogram never faster than 3 Hz
const MANUAL_KEYS = ['focus', 'iso', 'shutter', 'wbTemp'];
const RESTART_KEYS = ['lens', 'res', 'fps', 'hdr', 'stabilization', 'codec'];

export function CameraScreen({ cfg, update, hasMic }) {
  useKeepAwake();
  // The window is locked to portrait; the UI canvas rotates itself from the physical orientation (orientation.js).
  const win = useWindowDimensions();
  const { rot, landscape, name: orientation, rotAnim, upsideDown } = useDeviceRotation();
  const rotRef = useRef(0);
  rotRef.current = rot;
  const upsideDownRef = useRef(false);
  upsideDownRef.current = upsideDown;
  const width = landscape ? win.height : win.width; // canvas = what the user sees
  const height = landscape ? win.width : win.height;
  const compact = Math.min(win.width, win.height) < 380; // 360×640-class phones: drop secondary HUD items
  const winInsets = useSafeAreaInsets(); // notch / Dynamic Island / punch-hole / gesture bar (window space)
  const insets = physicalInsets(winInsets, rot); // …as the user sees them on the rotated canvas

  // ---------- config + settings ----------
  const cfgRef = useRef(cfg);
  const commit = (c) => { cfgRef.current = c; update(c); };
  const [settings, setSettings] = useState(() => loadSettings(cfg.settings));
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  useEffect(() => { // persist, debounced (sliders change settings many times a second)
    const t = setTimeout(() => commit({ ...cfgRef.current, settings }), 500);
    return () => clearTimeout(t);
  }, [settings]);
  const patch = (p) => setSettings((s) => ({ ...s, ...p }));

  // take.current = { id, mode: 'hub'|'local', session, recorder, recording, stopReq, done, resolve } | null
  // A take exists from the moment a start is accepted (pre-roll included) until its file is saved.
  // (Declared here because the device pinning below reads it.)
  const take = useRef(null);

  // ---------- lenses + capabilities ----------
  const lenses = useLenses();
  const lens = lenses.find((l) => l.id === settings.lens) ?? lenses.find((l) => l.id === 'wide') ?? lenses[0];
  // Keyed on device.id: a camera add/remove event rebuilds the device objects, and a new object for the same
  // camera must not reconfigure the session. During a take the device is pinned and never swapped.
  const deviceRef = useRef(null);
  let device = lens?.device;
  const pinned = deviceRef.current;
  if (pinned && (take.current || (device && pinned.id === device.id))) device = pinned;
  deviceRef.current = device ?? null;
  const [codecs, setCodecs] = useState([]);
  const caps = useFormatSupport(device, device ? cfg.learned?.[device.id] : null, codecs);
  const capsRef = useRef(caps);
  capsRef.current = caps;
  const lensesRef = useRef(lenses);
  lensesRef.current = lenses;

  // ---------- refs to the camera ----------
  const cam = useRef(null);
  const toast = useRef(null);
  const say = (msg, opts) => toast.current?.show(msg, opts);
  const layout = useRef({ width: 1, height: 1 });
  const ctrl = () => cam.current?.controller;

  const [hud, setHud] = useState({ battery: null, charging: false, free: Paths.availableDiskSpace });
  const [thermal, setThermal] = useState(null);
  const thermalRef = useRef(null);
  thermalRef.current = thermal;
  const [sheet, setSheet] = useState(null); // { kind: 'format' | 'pro', tab? } | null
  const [reticle, setReticle] = useState(null); // {x, y, id}
  const [aeLocked, setAeLocked] = useState(false);
  const aeLockedRef = useRef(false);
  aeLockedRef.current = aeLocked;
  const [zoomHud, setZoomHud] = useState(false);
  const [manual, setManualState] = useState({});
  const manualRef = useRef({});
  const [micBusy, setMicBusy] = useState(false); // meter paused so the recorder can take the mic (old Android)

  const video = useVideoOutput({
    targetResolution: RES_SIZE[settings.res],
    enableAudio: hasMic,
    targetBitRate: bitrate(settings),
    fileType: 'mov',
  });
  const videoRef = useRef(video);
  videoRef.current = video;
  // Live feed (react-native-tally-stream). Latched so a new object each render can't churn effects.
  // iOS: its output is always attached (live feed + hub thumbnails).
  // Android: it's CameraX ImageAnalysis, which can break 4K recording binding, so it's attached ONLY while
  // a live feed is requested, never changed mid-take, and Android thumbnails stay on takeSnapshot.
  const stream = useStreamSource();
  const liveRef = useRef(null);
  if (stream.live && !liveRef.current) liveRef.current = stream.live;
  const live = liveRef.current;
  const thumbsRef = useRef(null);
  if (Platform.OS === 'ios' && stream.thumbs && !thumbsRef.current) thumbsRef.current = stream.thumbs;
  const [liveAttached, setLiveAttached] = useState(false); // Android only
  const liveAttachedRef = useRef(false);
  liveAttachedRef.current = liveAttached;
  const streamOut = live?.output ?? stream.output ?? null;
  const attachLive = !!streamOut && (Platform.OS === 'ios' || liveAttached);
  const outputs = useMemo(() => (attachLive ? [video, streamOut] : [video]), [video, streamOut, attachLive]);

  const hdrOk = !!caps?.hdr, stabOk = !!caps?.stabilization;
  const constraints = useMemo(() => {
    const c = [{ resolutionBias: video }, { fps: settings.fps }];
    if (stabOk) c.push({ videoStabilizationMode: settings.stabilization ? 'standard' : 'off' });
    if (hdrOk) c.push({ videoDynamicRange: settings.hdr ? CommonDynamicRanges.ANY_HDR : CommonDynamicRanges.ANY_SDR });
    return c;
  }, [video, settings.fps, settings.stabilization, settings.hdr, stabOk, hdrOk]);

  // ---------- takes (recording state machine) ----------
  const takeSeq = useRef(0);
  const stopSeq = useRef(0); // takes with id <= stopSeq must not start (a stop arrived during their pre-roll)
  const recStartAt = useRef(0);
  const [rec, setRec] = useState(false);
  const [pending, setPending] = useState(null); // 'start' | 'stop' while waiting: drives the shutter instantly
  const reqTimer = useRef();

  // ---------- hub link ----------
  async function getStatus({ forHello } = {}) {
    const [battery, state, th] = await Promise.all([
      Battery.getBatteryLevelAsync(), Battery.getBatteryStateAsync(), readThermal(),
    ]);
    const t = take.current;
    const hubTake = !!t && t.mode === 'hub';
    return {
      t: 'status',
      battery,
      charging: state === Battery.BatteryState.CHARGING || state === Battery.BatteryState.FULL,
      free: Paths.availableDiskSpace,
      // In hello, only a hub-started take counts: the hub stops stale takes, but must not stop a standalone one.
      recording: forHello ? hubTake && !!t.recording : !!t?.recording,
      session: hubTake ? t.session : '', // lets the hub stop a phone still running a previous take
      duration: t?.recording ? t.recorder?.recordedDuration ?? 0 : 0,
      settings: pickHub(settingsRef.current),
      lenses: lensesRef.current.map((l) => l.id),
      remainingSec: Math.round(Paths.availableDiskSpace / (bitrate(settingsRef.current) / 8)),
      thermal: th ?? thermalRef.current ?? null,
      preview: previewState.current, // 'ok' | 'unavailable': lets the hub explain a missing preview
      stream: liveStats(),
      orientation: orientationRef.current, // 'portrait' | 'landscape-left' (top of phone left) | 'landscape-right'
      platform: Platform.OS,
    };
  }
  const orientationRef = useRef('portrait');
  orientationRef.current = orientation;
  const handlers = useRef({});
  handlers.current = {
    onMessage, getStatus, isBusy: () => !!take.current, onForget: () => setSheet(null),
    // The hub closed this camera: stop publishing to it (Android detach waits for the take, as always).
    onClose: () => { if (live && (liveCfg.current || deferredLive.current)) applyStream({ on: false }); },
  };
  const link = useHubLink({ cfgRef, commit, handlers });
  const linkRef = useRef(link);
  linkRef.current = link;
  const [hintHidden, setHintHidden] = useState(false);
  useEffect(() => { if (link.online) setHintHidden(false); }, [link.online]);
  const report = (msg) => linkRef.current.report(msg);

  // Push settings (and the orientation) to the hub soon after any change, so both sides stay in sync.
  useEffect(() => {
    if (!link.online) return;
    const t = setTimeout(() => link.pushStatus(), 300);
    return () => clearTimeout(t);
  }, [settings, lens?.id, link.online, orientation]);

  // HUD: battery, storage, heat — also while offline. Warn once when the phone gets hot.
  // State only changes when a shown value changes, so this never re-renders the screen for nothing.
  const heatWarned = useRef(false);
  useEffect(() => {
    const read = async () => {
      try {
        const [battery, st, th] = await Promise.all([Battery.getBatteryLevelAsync(), Battery.getBatteryStateAsync(), readThermal()]);
        const next = {
          battery: battery == null ? null : Math.round(battery * 100) / 100,
          charging: st === Battery.BatteryState.CHARGING || st === Battery.BatteryState.FULL,
          free: Math.round(Paths.availableDiskSpace / 1e8) * 1e8, // 0.1 GB steps
        };
        setHud((p) => (p.battery === next.battery && p.charging === next.charging && p.free === next.free ? p : next));
        setThermal((p) => (p?.level === th?.level && p?.label === th?.label && Math.round(p?.tempC ?? -1) === Math.round(th?.tempC ?? -1) ? p : th));
        thermalRef.current = th;
        if (th?.level >= 2 && !heatWarned.current) {
          heatWarned.current = true;
          haptic.warn();
          say('Phone is getting hot — consider lowering resolution/fps or adding airflow.', { tone: 'warn', ms: 5000 });
        } else if (th && th.level <= 0) heatWarned.current = false;
      } catch {}
    };
    read();
    const t = setInterval(read, 5000);
    return () => clearInterval(t);
  }, []);

  // ---------- settings: validation + application ----------
  // When the lens (caps) or requested format changes, fall back to the nearest combo this lens supports.
  useEffect(() => {
    if (!caps) return;
    const s = settingsRef.current;
    const fix = {};
    const res = caps.resolutions.includes(s.res) ? s.res : nearest(caps.resolutions, s.res);
    const list = caps.fps[res];
    const fps = list.includes(s.fps) ? s.fps : nearest(list, s.fps);
    if (res !== s.res || fps !== s.fps) {
      Object.assign(fix, { res, fps });
      const msg = `${RES_LABEL[s.res]} · ${s.fps} isn’t available on this lens. Using ${RES_LABEL[res]} · ${fps}.`;
      say(msg, { tone: 'warn' });
      report(msg);
    }
    if (s.hdr && !caps.hdr) fix.hdr = false;
    if (s.torch && !caps.torch) fix.torch = false;
    if (caps.exposureBias) {
      const e = clamp(s.exposure, caps.exposureBias.min, caps.exposureBias.max);
      if (e !== s.exposure) fix.exposure = e;
    }
    if (Object.keys(fix).length) patch(fix);
  }, [caps, settings.res, settings.fps, settings.hdr, settings.torch]);

  // From the hub or our own UI. Unsupported keys are refused with a reason (codec is skipped silently:
  // the hub's "Match all" always sends it, and phones that can't choose would only spam errors).
  function applySettings(p, fromHub) {
    const cur = settingsRef.current;
    const c = capsRef.current;
    const next = {};
    const errs = [];
    const busy = !!take.current;
    for (const [k, v] of Object.entries(p)) {
      if (k === 't' || v === undefined || v === cur[k]) continue;
      if (k === 'codec' && !c?.codec) continue;
      if (busy && RESTART_KEYS.includes(k)) { errs.push(`stop recording to change ${k}`); continue; }
      switch (k) {
        case 'lens':
          if (!lensesRef.current.some((l) => l.id === v)) errs.push(`this phone has no ${v} lens`);
          else Object.assign(next, { lens: v, zoom: 1 });
          break;
        case 'res':
          if (![720, 1080, 2160].includes(v)) errs.push(`unknown resolution ${v}`);
          else next.res = v; // per-lens fallback happens in the validation effect
          break;
        case 'fps':
          if (![24, 25, 30, 50, 60].includes(v)) errs.push(`unknown frame rate ${v}`);
          else next.fps = v;
          break;
        case 'codec':
          if (['hevc', 'h264'].includes(v)) next.codec = v;
          break;
        case 'hdr':
          if (v && c && !c.hdr) errs.push('this lens has no HDR video');
          else next.hdr = !!v;
          break;
        case 'stabilization':
          if (v && c && !c.stabilization) errs.push('this lens has no video stabilization');
          else next.stabilization = !!v;
          break;
        case 'torch':
          if (v && c && !c.torch) errs.push('this lens has no torch');
          else next.torch = !!v;
          break;
        case 'zoom':
          next.zoom = c ? clamp(+v || 1, c.zoom.min, Math.min(c.zoom.max, 10)) : +v || 1;
          break;
        case 'exposure':
          if (c && !c.exposureBias) errs.push('this lens has no exposure compensation');
          else next.exposure = c ? clamp(+v || 0, c.exposureBias.min, c.exposureBias.max) : +v || 0;
          break;
        case 'grid': case 'meter': case 'recSaver': case 'histogram':
          next[k] = !!v;
          break;
        case 'mains':
          if (v === 50 || v === 60) next.mains = v;
          break;
        default:
          if (fromHub) errs.push(`unknown setting ${k}`);
      }
    }
    if (Object.keys(next).length) patch(next);
    if (errs.length) {
      const msg = errs.join('; ');
      say(msg.charAt(0).toUpperCase() + msg.slice(1), { tone: 'warn' });
      if (fromHub) report(msg);
      haptic.warn();
    }
  }

  // The session tells us what it actually negotiated: learn refused combos and fall back honestly.
  function onSessionConfigSelected(config) {
    const s = settingsRef.current;
    const got = Math.round(config.selectedFPS ?? s.fps);
    if (got < s.fps && device) {
      const learned = { ...(cfgRef.current.learned || {}) };
      const forDev = { ...(learned[device.id] || {}) };
      forDev[s.res] = [...new Set([...(forDev[s.res] || []), s.fps])];
      learned[device.id] = forDev;
      commit({ ...cfgRef.current, learned }); // useFormatSupport re-filters, validation effect picks the fallback
      say(`${RES_LABEL[s.res]} · ${s.fps} isn’t supported here.`, { tone: 'warn' });
    }
    if (s.hdr && config.selectedVideoDynamicRange && config.selectedVideoDynamicRange.bitDepth !== 'hdr-10-bit') {
      say(`HDR isn’t available at ${RES_LABEL[s.res]} · ${s.fps}. Recording SDR.`, { tone: 'warn' });
      patch({ hdr: false });
    }
    if (s.stabilization && config.selectedVideoStabilizationMode === 'off') {
      say('Stabilization isn’t available with this format.', { tone: 'warn' });
      patch({ stabilization: false });
    }
  }

  function onStarted() {
    // Which codecs the encoder can choose between (iOS reports them; elsewhere this throws → no codec picker).
    let list = [];
    try { list = videoRef.current.getSupportedVideoCodecs?.() ?? []; } catch {}
    setCodecs((prev) => (prev.join() === list.join() ? prev : list));
    // Resolution check: the encoder may have quietly picked a smaller size.
    const r = videoRef.current.currentResolution;
    const s = settingsRef.current;
    if (r && Math.min(r.width, r.height) < RES_SIZE[s.res].width * 0.95) {
      say(`${RES_LABEL[s.res]} isn’t available with these settings. Recording ${Math.min(r.width, r.height)}p.`, { tone: 'warn' });
    }
    reapplyManual();
  }

  // ---------- recording ----------
  function endTake(t) {
    if (t.ended) return;
    t.ended = true;
    clearTimeout(t.stopDog);
    // Free the native recorder once its file is saved and queued (never while it still reports recording).
    const r = t.recorder;
    if (r) setTimeout(() => { try { if (!r.isRecording) r.dispose?.(); } catch {} }, 2000);
    if (take.current === t) {
      take.current = null;
      setRec(false);
      setMicBusy(false);
      setPending(null);
    }
    t.resolve();
    linkRef.current.takeEnded();
    const d = deferredLive.current; // Android live-feed change that had to wait for the take to end
    if (d) { deferredLive.current = null; setTimeout(() => applyStream(d), 0); }
  }
  function saveClip(t, path) {
    if (t.saved || !path) return;
    try {
      const f = new File(fileUri(path));
      if (!f.exists || !f.size) return;
    } catch { return; }
    t.saved = true;
    linkRef.current.enqueue(path, t.session);
  }

  async function startRecording({ session, localAt, mode }) {
    const prev = take.current;
    if (prev && !prev.stopReq) return; // already recording (or arming) a take
    const id = ++takeSeq.current;
    const cancelled = (t) => t.stopReq || stopSeq.current >= id;
    if (prev) {
      // REC right after STOP: the previous clip is still being written. Wait for it (bounded), then start ASAP.
      await Promise.race([prev.done, sleep(PREV_TAKE_WAIT_MS)]);
      if (!prev.ended) { report('previous take still finishing; starting the new take anyway'); endTake(prev); }
    }
    if (takeSeq.current !== id || take.current) return; // superseded by a newer start
    const t = { id, mode, session, stopReq: false, recording: false };
    t.done = new Promise((r) => { t.resolve = r; });
    take.current = t;
    try {
      if (OLD_ANDROID) { setMicBusy(true); await sleep(200); } // let the meter release the mic first
      const s = settingsRef.current;
      if (capsRef.current?.codec) {
        await videoRef.current.setOutputSettings({ codec: s.codec === 'hevc' ? 'h265' : 'h264' })
          .catch((e) => report(`codec: ${e.message}`));
      }
      // Into the app's documents (not temp, which the OS may purge); created ahead of the start time so start is instant.
      t.recorder = await videoRef.current.createRecorder({ filePath: newClipPath(session) });
      if (localAt) await waitUntil(localAt);
      if (cancelled(t)) { // STOP arrived during the pre-roll: never start
        try { t.recorder.dispose?.(); } catch {}
        endTake(t);
        return;
      }
      await t.recorder.startRecording(
        (path) => { saveClip(t, path); haptic.thud(); endTake(t); },
        (e) => {
          say(`Recording error: ${e.message}`, { tone: 'warn' });
          report(`recording error: ${e.message}`);
          let path = null;
          try { path = t.recorder?.filePath; } catch {}
          saveClip(t, path); // keep whatever was written
          endTake(t);
        },
      );
      t.recording = true;
      recStartAt.current = Date.now();
      if (take.current === t) { setRec(true); setPending(null); }
      haptic.thud();
      if (localAt) linkRef.current.send({ t: 'started', lateMs: Date.now() - localAt });
      if (cancelled(t)) await t.recorder.stopRecording(); // a stop landed while the recorder was starting
    } catch (e) {
      say(`Couldn’t start recording: ${e.message}`, { tone: 'warn' });
      report(`start failed: ${e.message}`);
      if (!t.recording) endTake(t);
    }
  }

  // Safe to call repeatedly: a repeat (hub re-send or another shutter press) retries the stop.
  async function stopTake(localAt) {
    stopSeq.current = takeSeq.current; // also cancels a take that is still waiting to start
    const t = take.current;
    if (!t) { setPending(null); return; }
    t.stopReq = true;
    if (localAt) await waitUntil(localAt);
    if (t.recording && t.recorder?.isRecording) {
      try { await t.recorder.stopRecording(); } catch (e) { report(`stop failed: ${e.message}`); }
    }
    armStopWatchdog(t);
  }
  // If the recorder never confirms the stop (stopRecording rejected, or its finish callback never came),
  // retry once, then release the take anyway so the shutter is never left dead. Whatever was written is
  // kept and queued; a late finish callback is harmless (saveClip/endTake are idempotent).
  function armStopWatchdog(t) {
    if (t.stopDog || t.ended) return;
    t.stopDog = setTimeout(async () => {
      if (t.ended) return;
      try { if (t.recorder?.isRecording) await t.recorder.stopRecording(); } catch {}
      await sleep(1500);
      if (t.ended) return;
      let path = null;
      try { path = t.recorder?.filePath; } catch {}
      saveClip(t, path);
      say('The camera didn’t confirm the stop. The take was released; anything recorded is kept.', { tone: 'warn', ms: 5000 });
      report('recorder did not confirm stop within 8 s; take released (clip kept if written)');
      endTake(t);
    }, STOP_CONFIRM_MS);
  }

  // The red button: with a hub, ask it to start/stop every camera; without one, record here.
  // The shutter changes state the instant it's pressed; a subtle ring shows we're waiting for the hub.
  function onShutter() {
    haptic.thud();
    clearTimeout(reqTimer.current);
    const t = take.current;
    if (t && !t.stopReq) {
      setPending('stop');
      if (t.mode === 'hub' && link.isOpen()) {
        link.send({ t: 'requestStop' });
        reqTimer.current = setTimeout(() => {
          if (take.current === t) { say('Hub didn’t respond. Stopping this camera.', { tone: 'warn' }); stopTake(); }
        }, 3000);
      } else {
        stopTake();
      }
      return;
    }
    if (t) { // a stop is already in progress: pressing again retries it (never a dead shutter)
      setPending('stop');
      say('Stopping…');
      stopTake();
      return;
    }
    setPending('start');
    if (link.isOpen()) {
      link.send({ t: 'requestRecord' });
      reqTimer.current = setTimeout(() => {
        if (!take.current) { say('Hub didn’t start recording. Check Tally Hub.', { tone: 'warn' }); setPending(null); }
      }, 3500);
    } else {
      startRecording({ session: `standalone_${today()}`, mode: 'local' });
    }
  }

  // ---------- hub messages ----------
  // Hub focus taps are relative to the preview image it shows. Map them into the camera image inside
  // this view (resizeMode "contain" letterboxes it), using the snapshot's aspect when we have one.
  // A landscape preview (the phone held sideways; frames are sent in physical orientation) is first
  // turned back into window space, since the window itself stays portrait.
  const snapAspect = useRef(null);
  function hubPointToView(nx, ny) {
    const { width: W, height: H } = layout.current;
    const thumbs = previewKind === 'thumbs'; // iOS stream thumbnails (Android snapshots are the view itself)
    // Held upside down, thumbnails are rotated 180° while the UI stays portrait (rot 0).
    if (thumbs && upsideDownRef.current) { nx = 1 - nx; ny = 1 - ny; }
    const va = W / H;
    let a = snapAspect.current ?? (W > H ? 16 / 9 : 9 / 16);
    const r = rotRef.current;
    if (r && a > 1 && W < H) { ({ x: nx, y: ny } = physicalToWindow(nx, ny, r)); a = 1 / a; }
    // Thumbnails are never mirrored, but the front camera's on-screen preview is (mirrorMode 'auto'):
    // flip across the window's vertical axis, after the point is back in window space.
    if (thumbs && settingsRef.current.lens === 'front') nx = 1 - nx;
    if (Math.abs(a - va) / va < 0.03) return { x: nx * W, y: ny * H }; // snapshot is the whole view
    let w = W, h = H;
    if (a > va) h = W / a; else w = H * a;
    return { x: (W - w) / 2 + nx * w, y: (H - h) / 2 + ny * h };
  }

  async function onMessage(m) {
    try {
      if (m.t === 'record') {
        clearTimeout(reqTimer.current);
        await startRecording({ session: m.session, localAt: linkRef.current.toLocal(m.atHubMs), mode: 'hub' });
      } else if (m.t === 'stop') {
        clearTimeout(reqTimer.current);
        await stopTake(linkRef.current.toLocal(m.atHubMs));
      } else if (m.t === 'settings') {
        applySettings(m, true);
      } else if (m.t === 'focus') {
        focusAt(hubPointToView(clamp(+m.x, 0, 1), clamp(+m.y, 0, 1)), false);
      } else if (m.t === 'lock') {
        await lockAll(!!m.on);
      } else if (m.t === 'stream') {
        applyStream(m);
      } else if (m.t === 'preview') {
        setHubPreview({ fps: clamp(+m.fps || 0, 0, PREVIEW_FPS.max), maxWidth: +m.maxWidth || PREVIEW_W });
      }
    } catch (e) {
      report(`${m.t}: ${e.message}`);
    }
  }

  // ---------- focus / exposure / lock ----------
  // Metering modes not under manual control.
  const autoModes = () => {
    const m = manualRef.current;
    return ['AE', 'AF', 'AWB'].filter((x) =>
      !(x === 'AF' && m.focus != null) && !(x === 'AE' && (m.iso != null || m.shutter != null)) && !(x === 'AWB' && m.wbTemp != null));
  };

  // resetFocus() returns AF/AE/AWB to continuous auto, which would silently drop manual WB/ISO/shutter/focus
  // while the UI still shows them. Always re-apply them after a reset.
  const reapplyManual = () => {
    if (MANUAL_KEYS.some((k) => manualRef.current[k] != null)) queueManual({}, manualRef.current, true);
  };

  async function focusAt(pt, lock) {
    setReticle({ ...pt, id: Date.now() });
    const modes = autoModes();
    if (!modes.length) return say('Manual mode: tap A in Pro controls to return to auto.');
    try {
      if (aeLockedRef.current && !lock) { await ctrl()?.resetFocus(); setAeLocked(false); reapplyManual(); }
      // A lock must hold until the user unlocks it: VisionCamera's default autoResetAfter (5 s) would
      // quietly return to continuous auto while the UI still shows AE/AF LOCK.
      await cam.current?.focusTo(pt, {
        modes, adaptiveness: lock ? 'locked' : 'continuous', responsiveness: 'snappy', autoResetAfter: lock ? null : 5,
      });
      if (lock) { setAeLocked(true); haptic.thud(); }
    } catch (e) {
      // Focus can be cancelled by a newer tap; only surface real failures.
      if (!/cancel/i.test(e.message)) say(`Focus: ${e.message}`, { tone: 'warn' });
    }
  }

  // Lock focus + exposure + white balance where they are now (hub "Lock all", Pro panel toggle).
  // Uses lockCurrent* where the device supports it; otherwise a locked metering pass at the last point.
  async function lockAll(on) {
    if (!on) {
      try { await ctrl()?.resetFocus(); } catch {}
      setAeLocked(false);
      reapplyManual();
      return;
    }
    const c = ctrl();
    const k = capsRef.current;
    let locked = false;
    if (c && k && (k.manualFocus || k.manualExposure || k.manualWB)) {
      try {
        if (k.manualFocus && manualRef.current.focus == null) await c.lockCurrentFocus();
        if (k.manualExposure && manualRef.current.iso == null && manualRef.current.shutter == null) await c.lockCurrentExposure();
        if (k.manualWB && manualRef.current.wbTemp == null) await c.lockCurrentWhiteBalance();
        locked = true;
      } catch (e) {
        report(`lock: ${e.message}; using metering lock instead`);
      }
    }
    if (locked) { setAeLocked(true); haptic.thud(); return; }
    await focusAt(reticle ?? { x: layout.current.width / 2, y: layout.current.height / 2 }, true);
  }

  // Manual 3A. Calls are coalesced: slider drags only ever apply the latest value.
  const applying = useRef(false);
  const pendingApply = useRef(null);
  function setManual(p) {
    const prev = manualRef.current;
    const next = { ...prev, ...p };
    manualRef.current = next;
    setManualState(next);
    queueManual(prev, next, false);
  }
  async function queueManual(prev, next, force) {
    const q = pendingApply.current;
    pendingApply.current = { prev: q ? q.prev : prev, next, force: force || q?.force };
    if (applying.current) return;
    applying.current = true;
    while (pendingApply.current) {
      const job = pendingApply.current;
      pendingApply.current = null;
      try { await applyManual(job.prev, job.next, job.force); } catch (e) { say(`Manual control: ${e.message}`, { tone: 'warn' }); }
    }
    applying.current = false;
  }
  async function applyManual(prev, next, force) {
    const c = ctrl();
    const k = capsRef.current;
    if (!c || !k) return;
    // resetFocus() returns all of AF/AE/AWB to continuous auto, so after it every manual value is re-applied.
    const all = force || MANUAL_KEYS.some((x) => prev[x] != null && next[x] == null);
    if (all) { await c.resetFocus(); setAeLocked(false); }
    if (k.manualFocus && next.focus != null && (all || next.focus !== prev.focus)) {
      await c.setFocusLocked(clamp(next.focus, 0, 1));
    }
    if (k.manualExposure && (next.iso != null || next.shutter != null)
      && (all || next.iso !== prev.iso || next.shutter !== prev.shutter)) {
      const iso = clamp(next.iso ?? c.iso, c.minISO, c.maxISO);
      const dur = clamp(next.shutter ?? c.exposureDuration, c.minExposureDuration, c.maxExposureDuration);
      await c.setExposureLocked(dur, iso);
    }
    if (k.manualWB && next.wbTemp != null && (all || next.wbTemp !== prev.wbTemp || next.wbTint !== prev.wbTint)) {
      const g = c.convertWhiteBalanceTemperatureAndTintValues({ temperature: next.wbTemp, tint: next.wbTint ?? 0 });
      const max = k.maxWBGain || 4;
      await c.setWhiteBalanceLocked({
        redGain: clamp(g.redGain, 1, max), greenGain: clamp(g.greenGain, 1, max), blueGain: clamp(g.blueGain, 1, max),
      });
    }
  }

  // ---------- viewfinder gestures: tap focus, long-press lock, drag exposure, pinch zoom ----------
  const g = useRef({}).current;
  const zoomHudTimer = useRef();
  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => {
      const { locationX: x, locationY: y } = e.nativeEvent;
      Object.assign(g, { x, y, t: Date.now(), moved: false, pinch: null, mode: null, exp0: settingsRef.current.exposure });
      clearTimeout(g.lockTimer);
      g.lockTimer = setTimeout(() => { if (!g.moved && !g.pinch) { g.mode = 'lock'; focusAt({ x, y }, true); } }, LOCK_MS);
    },
    onPanResponderMove: (e, gs) => {
      const t = e.nativeEvent.touches;
      if (t.length >= 2) {
        clearTimeout(g.lockTimer);
        const d = Math.hypot(t[0].pageX - t[1].pageX, t[0].pageY - t[1].pageY);
        if (!g.pinch) g.pinch = { d0: d, z0: settingsRef.current.zoom };
        const k = capsRef.current;
        const z = clamp(g.pinch.z0 * (d / g.pinch.d0), k?.zoom.min ?? 1, Math.min(k?.zoom.max ?? 10, 10));
        if (!g.raf) g.raf = requestAnimationFrame(() => { g.raf = null; patch({ zoom: Math.round(z * 100) / 100 }); });
        setZoomHud(true);
        clearTimeout(zoomHudTimer.current);
        zoomHudTimer.current = setTimeout(() => setZoomHud(false), 1200);
        g.moved = true;
        return;
      }
      if (Math.abs(gs.dx) > 8 || Math.abs(gs.dy) > 8) {
        g.moved = true;
        clearTimeout(g.lockTimer);
      }
      // Vertical drag (as the user holds the phone) right after a focus tap = exposure compensation,
      // like the stock camera's sun slider.
      const ev = capsRef.current?.exposureBias;
      const d = physicalDelta(gs.dx, gs.dy, rotRef.current);
      if (ev && g.moved && !g.pinch && Math.abs(d.dy) > Math.abs(d.dx) && g.recentFocus) {
        g.mode = 'exposure';
        const v = clamp(g.exp0 - d.dy / 120, ev.min, ev.max);
        patch({ exposure: Math.round(v * 10) / 10 });
      }
    },
    onPanResponderRelease: () => {
      clearTimeout(g.lockTimer);
      if (!g.moved && !g.pinch && g.mode !== 'lock' && Date.now() - g.t < LOCK_MS) {
        // Single tap: focus + expose there (continuous; also unlocks). Double tap: same point, then lock AE/AF.
        const now = Date.now();
        const last = g.lastTap;
        const dbl = last && now - last.t < 320 && Math.hypot(g.x - last.x, g.y - last.y) < 44;
        g.lastTap = dbl ? null : { t: now, x: g.x, y: g.y };
        if (dbl) focusAt({ x: g.x, y: g.y }, true);
        else { haptic.tap(); focusAt({ x: g.x, y: g.y }, false); }
        g.recentFocus = true;
        clearTimeout(g.recentTimer);
        g.recentTimer = setTimeout(() => { g.recentFocus = false; }, 4000);
      }
    },
    onPanResponderTerminate: () => clearTimeout(g.lockTimer),
  }), []);

  // ---------- lens switching ----------
  function pickLens(id) {
    if (id === settingsRef.current.lens) return;
    if (take.current) { haptic.warn(); return say('Stop recording to switch lenses.', { tone: 'warn' }); }
    haptic.tap();
    setAeLocked(false);
    applySettings({ lens: id }, false);
  }
  function flip() {
    const cur = settingsRef.current.lens;
    if (cur === 'front') pickLens(cfgRef.current.lastBackLens && lenses.some((l) => l.id === cfgRef.current.lastBackLens) ? cfgRef.current.lastBackLens : 'wide');
    else { cfgRef.current = { ...cfgRef.current, lastBackLens: cur }; pickLens('front'); }
  }

  // ---------- quick format toggles (one tap, like the stock "HD · 30" badges) ----------
  function cycleRes() {
    if (!caps) return;
    if (take.current) return say('Stop recording to change format.', { tone: 'warn' });
    const list = caps.resolutions;
    const next = list[(list.indexOf(settings.res) + 1) % list.length];
    haptic.tap();
    const fpsOk = caps.fps[next];
    if (!fpsOk.includes(settings.fps)) {
      const f = nearest(fpsOk, settings.fps);
      say(`${settings.fps} fps isn’t available at ${RES_LABEL[next]}. Using ${f}.`);
      patch({ res: next, fps: f });
    } else patch({ res: next });
  }
  function cycleFps() {
    if (!caps) return;
    if (take.current) return say('Stop recording to change format.', { tone: 'warn' });
    const list = caps.fps[settings.res] ?? [];
    if (list.length < 2) return say(`${RES_LABEL[settings.res]} only supports ${list[0]} fps on this lens.`);
    haptic.tap();
    patch({ fps: list[(list.indexOf(settings.fps) + 1) % list.length] });
  }

  // ---------- recording saver: dim UI + screen while recording, wake on touch ----------
  const [dimmed, setDimmed] = useState(false);
  const dimmedRef = useRef(false);
  dimmedRef.current = dimmed;
  const idleTimer = useRef();
  const savedBrightness = useRef(null);
  function poke() {
    if (dimmedRef.current) setDimmed(false);
    clearTimeout(idleTimer.current);
    if (take.current && settingsRef.current.recSaver) idleTimer.current = setTimeout(() => setDimmed(true), SAVER_IDLE_MS);
  }
  async function restoreBrightness() {
    const b = savedBrightness.current;
    if (b == null) return;
    savedBrightness.current = null;
    try {
      if (Platform.OS === 'android') await Brightness.restoreSystemBrightnessAsync(); // back to following the system
      else await Brightness.setBrightnessAsync(b);
    } catch {}
  }
  const hot = (thermal?.level ?? 0) >= 2;
  useEffect(() => {
    if (rec && settings.recSaver) poke();
    else { clearTimeout(idleTimer.current); setDimmed(false); }
  }, [rec, settings.recSaver]);
  useEffect(() => {
    if (!dimmed) { restoreBrightness(); return; }
    (async () => {
      try {
        if (savedBrightness.current == null) savedBrightness.current = await Brightness.getBrightnessAsync();
        if (dimmedRef.current) await Brightness.setBrightnessAsync(hot ? HOT_BRIGHTNESS : SAVER_BRIGHTNESS);
      } catch {}
    })();
  }, [dimmed, hot]);
  const [appActive, setAppActive] = useState(AppState.currentState !== 'background');
  const appActiveRef = useRef(appActive);
  appActiveRef.current = appActive;
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      setAppActive(st === 'active');
      if (st !== 'active') { clearTimeout(idleTimer.current); setDimmed(false); restoreBrightness(); }
    });
    return () => { sub.remove(); clearTimeout(idleTimer.current); clearTimeout(reqTimer.current); restoreBrightness(); };
  }, []);

  // ---------- preview frames for the hub's grid (+ histogram) ----------
  // Sources, best first: (a) tally-stream thumbnails (iOS + Android); (b) takeSnapshot (Android only —
  // VisionCamera v5 iOS throws "not available"). Failures are reported once, shown, and backed off.
  const previewKind = thumbsRef.current ? 'thumbs' : Platform.OS === 'android' ? 'snapshot' : null;
  const histOk = previewKind === 'snapshot' || (previewKind === 'thumbs' && canDecodeJpeg());
  const previewState = useRef(previewKind ? 'ok' : 'unavailable');
  if (!previewKind) previewState.current = 'unavailable';
  const [previewErr, setPreviewErr] = useState(null);
  const previewFails = useRef(0);
  const lastFrameAt = useRef(0);
  const lastHistAt = useRef(0); // separate from lastFrameAt, which every preview frame resets
  function previewFailed(e) {
    const msg = String(e?.message || e || 'unknown error').slice(0, 120);
    previewFails.current++;
    if (previewFails.current === 1) {
      previewState.current = 'unavailable';
      setPreviewErr(msg);
      report(`preview unavailable: ${msg}`);
    }
    return Math.min(60000, 5000 * 2 ** Math.min(previewFails.current - 1, 4)); // 5 s, 10 s … 60 s
  }
  function previewWorked() {
    lastFrameAt.current = Date.now();
    previewState.current = 'ok';
    if (previewFails.current) { previewFails.current = 0; setPreviewErr(null); }
  }
  async function histFrom(img) {
    const tiny = await img.resizeAsync(64, Math.max(1, Math.round((64 * img.height) / img.width)));
    try { histBus.publish(lumaHistogram(await tiny.toRawPixelDataAsync())); } finally { try { tiny.dispose?.(); } catch {} }
  }

  // What the hub asked for ({t:'preview', fps, maxWidth}); null until it says something.
  const [hubPreview, setHubPreview] = useState(null);
  // The histogram only costs anything while its box is actually on screen.
  const histVisible = settings.histogram && histOk && !dimmed && appActive && !sheet;
  const histVisibleRef = useRef(false);
  histVisibleRef.current = histVisible;
  // The plan: thumbnail rate/size right now. 0 fps = thumbnails off (not connected, backgrounded, hub said 0).
  const plan = useMemo(() => {
    const width = clamp(Math.round(hubPreview?.maxWidth || PREVIEW_W), 160, 1280);
    if (!appActive) return { fps: 0, width };
    if (!link.online) return { fps: histVisible ? PREVIEW_FPS.histogramOnly : 0, width };
    let fps = hubPreview ? clamp(+hubPreview.fps || 0, 0, PREVIEW_FPS.max) : PREVIEW_FPS.connected;
    if (dimmed) fps = Math.min(fps, PREVIEW_FPS.dimmed);
    else if (rec) fps = Math.min(fps, PREVIEW_FPS.recording);
    if (!fps && histVisible) fps = PREVIEW_FPS.histogramOnly;
    return { fps, width };
  }, [hubPreview, appActive, link.online, dimmed, rec, histVisible]);
  const planRef = useRef(plan);
  planRef.current = plan;

  // (a) thumbnails pushed by the stream module: subscribe once, (re)start per the plan.
  const thumbsOn = previewKind === 'thumbs';
  useEffect(() => {
    const api = thumbsRef.current;
    if (!thumbsOn || !api) return;
    let unsub = null, histBusy = false, lastHist = 0;
    try {
      const r = api.onThumbnail((jpeg, w, h) => {
        try {
          if (!jpeg || jpeg.byteLength > MAX_FRAME_BYTES) return; // never send oversized frames
          previewWorked();
          if (w && h) snapAspect.current = w / h;
          if (linkRef.current.isOpen()) linkRef.current.sendBinary(jpeg);
          if (histVisibleRef.current && !histBusy && Date.now() - lastHist > HIST_MIN_MS) {
            histBusy = true;
            lastHist = Date.now();
            decodeJpeg(jpeg, w, h)
              .then(async (img) => { if (img) { try { await histFrom(img); } finally { try { img.dispose?.(); } catch {} } } })
              .catch(() => {})
              .finally(() => { histBusy = false; });
          }
        } catch (e) { previewFailed(e); }
      });
      unsub = typeof r === 'function' ? r : null;
    } catch (e) {
      previewFailed(e);
    }
    // Watchdog: thumbnails requested but nothing arrives while the hub is waiting for pictures.
    const dog = setInterval(() => {
      if (planRef.current.fps > 0 && linkRef.current.isOpen() && Date.now() - lastFrameAt.current > 6000 && !previewFails.current) {
        previewFailed(new Error('camera sent no preview frames'));
      }
    }, 3000);
    return () => { clearInterval(dog); try { unsub?.(); api.stopThumbnails?.(); } catch {} };
  }, [thumbsOn]);
  const applied = useRef({ fps: 0, width: 0 });
  useEffect(() => {
    const api = thumbsRef.current;
    if (!thumbsOn || !api) return;
    const was = applied.current;
    applied.current = plan;
    try {
      if (!plan.fps) { if (was.fps) api.stopThumbnails(); return; }
      lastFrameAt.current = Date.now();
      if (was.fps && was.width === plan.width) api.setThumbnailInterval(Math.round(1000 / plan.fps));
      else api.startThumbnails({ intervalMs: Math.round(1000 / plan.fps), maxWidth: plan.width, quality: 55 });
    } catch (e) { previewFailed(e); }
  }, [thumbsOn, plan]);

  // (b) Android snapshot loop, paced by the same plan.
  useEffect(() => {
    if (previewKind !== 'snapshot') return;
    let stop = false;
    (async () => {
      while (!stop) {
        const t = Date.now();
        const p = planRef.current;
        if (!p.fps) { await sleep(500); continue; }
        const wantHub = linkRef.current.isOpen();
        const wantHist = histVisibleRef.current;
        const imgs = [];
        let wait = 0;
        try {
          if ((wantHub || wantHist) && cam.current) {
            const img = await cam.current.takeSnapshot();
            imgs.push(img);
            snapAspect.current = img.width / img.height;
            const w = Math.min(p.width, img.width);
            // Always downscale; if that fails the frame is skipped, never sent full-size.
            const small = await img.resizeAsync(w, Math.max(1, Math.round((w * img.height) / img.width)));
            imgs.push(small);
            if (wantHub) {
              const jpg = await small.toEncodedImageDataAsync('jpg', 55);
              if (jpg.buffer.byteLength <= MAX_FRAME_BYTES) linkRef.current.sendBinary(jpg.buffer);
            }
            if (wantHist && Date.now() - lastHistAt.current >= HIST_MIN_MS) { lastHistAt.current = Date.now(); await histFrom(small); }
            previewWorked();
          }
        } catch (e) {
          wait = previewFailed(e);
        } finally {
          imgs.forEach((i) => { try { i.dispose?.(); } catch {} });
        }
        await sleep(Math.max(0, (wait || Math.round(1000 / p.fps)) - (Date.now() - t)));
      }
    })();
    return () => { stop = true; };
  }, [previewKind]);

  // ---------- live feed (hub → {t:'stream', on, url, width, height, fps, bitrateKbps, profile, role}) ----------
  // role 'live': on air to OBS (red LIVE pill). role 'monitor': the hub's smooth preview feed (subtle HUB badge).
  const liveCfg = useRef(null); // the config currently requested (null = off)
  const stepped = useRef(false); // thermal step-down applied
  const deferredLive = useRef(null);
  const [liveState, setLiveState] = useState('off');
  const [liveRole, setLiveRole] = useState('live');
  function liveStats() {
    if (!live) return null;
    try {
      const st = live.getStats();
      return { state: st.state, width: st.width, height: st.height, fps: st.fps, kbps: st.kbps, droppedFrames: st.droppedFrames, error: st.error ?? null };
    } catch { return null; }
  }
  const withLatency = (url) => (/[?&]latency=/.test(url) ? url : `${url}${url.includes('?') ? '&' : '?'}latency=120`);

  // Identity of a requested feed: the hub re-sends its stream message on every reconnect, and restarting an
  // identical feed would glitch what's on air. Compared before any thermal step-down.
  const liveReqKey = useRef(null);
  function stopLive() {
    liveCfg.current = null;
    liveReqKey.current = null;
    stepped.current = false;
    try { live?.stop(); } catch (e) { report(`live stop: ${e.message}`); }
  }

  function applyStream(m) {
    if (!live) return report('live feed isn’t available in this build of Tally Cam');
    const on = !!m.on;
    if (!on) {
      // Stopping the encoder never touches the camera's outputs, so it happens now, even mid-take.
      // Android: only detaching the output (a camera reconfigure) waits for the take to end.
      deferredLive.current = null;
      stopLive();
      if (Platform.OS === 'android') {
        if (!take.current) setLiveAttached(false);
        else if (liveAttachedRef.current) deferredLive.current = { on: false };
      }
      return;
    }
    // Android: attaching the output reconfigures the camera, which must never happen mid-take.
    if (Platform.OS === 'android' && take.current && !liveAttachedRef.current) {
      deferredLive.current = m;
      report('Live feed changes apply after this take (Android)');
      return;
    }
    deferredLive.current = null; // applied directly: an older deferred change must not undo it later
    const url = String(m.url || '');
    if (!/^srt:\/\//.test(url)) return report('live feed: invalid stream URL');
    const lvl = thermalRef.current?.level ?? 0;
    if (lvl >= 3) return report('live feed refused: phone is critically hot');
    const camFps = settingsRef.current.fps;
    const cfgL = {
      url: withLatency(url),
      width: clamp(Math.round(+m.width || 1920), 320, 3840),
      height: clamp(Math.round(+m.height || 1080), 180, 2160),
      fps: Math.min(Math.round(+m.fps || 30), camFps), // never above what the camera is producing
      bitrateKbps: clamp(Math.round(+m.bitrateKbps || 8000), 500, 50000),
      keyframeIntervalSec: 1,
      profile: ['baseline', 'main', 'high'].includes(m.profile) ? m.profile : 'main', // passed through to the encoder
    };
    const role = m.role === 'monitor' ? 'monitor' : 'live';
    const reqKey = JSON.stringify([cfgL.url, cfgL.width, cfgL.height, cfgL.fps, cfgL.bitrateKbps, cfgL.profile, role]);
    const cur = liveStats()?.state;
    if (reqKey === liveReqKey.current && (cur === 'live' || cur === 'connecting')) return; // already running exactly this
    liveReqKey.current = reqKey;
    stepped.current = false; // a fresh "on" from the hub restores full quality (if the phone has cooled)
    if (lvl >= 2) { cfgL.fps = Math.min(cfgL.fps, 30); cfgL.bitrateKbps = Math.min(cfgL.bitrateKbps, 4000); stepped.current = true; }
    liveCfg.current = cfgL;
    setLiveRole(role);
    if (Platform.OS === 'android') setLiveAttached(true);
    try { live.start(cfgL); } catch (e) { report(`live start: ${e.message}`); say(`Live feed: ${e.message}`, { tone: 'warn' }); }
  }

  // State changes → phone UI + an immediate status to the hub.
  useEffect(() => {
    if (!live) return;
    let lastErr = null;
    const off = live.addListener((st) => {
      setLiveState(st.state);
      if (st.state === 'error' && st.error && st.error !== lastErr) say(`Live feed: ${st.error}`, { tone: 'warn' });
      lastErr = st.error ?? null;
      linkRef.current.pushStatus();
    });
    return () => { try { off?.(); live.stop(); } catch {} };
  }, [live]);

  // Thermal step-down while live. Local recording always wins; full quality returns only on a new "on".
  useEffect(() => {
    const cfgL = liveCfg.current;
    if (!live || !cfgL) return;
    const lvl = thermal?.level ?? 0;
    if (lvl >= 3) {
      stopLive();
      report('live feed stopped: phone is critically hot (recording continues)');
      say('Live feed stopped to protect the recording: phone is too hot.', { tone: 'warn', ms: 5000 });
      if (Platform.OS === 'android') { if (take.current) deferredLive.current = { on: false }; else setLiveAttached(false); }
    } else if (lvl >= 2 && !stepped.current) {
      stepped.current = true;
      try { live.setFps(Math.min(30, cfgL.fps)); live.setBitrate(Math.min(4000, cfgL.bitrateKbps)); } catch {}
      report('live feed stepped down to 30 fps / 4 Mbps: phone is hot');
    }
  }, [thermal?.level, live]);

  // Never stream faster than the camera runs.
  useEffect(() => {
    const cfgL = liveCfg.current;
    if (live && cfgL && cfgL.fps > settings.fps) {
      cfgL.fps = settings.fps;
      try { live.setFps(settings.fps); } catch {}
    }
  }, [settings.fps, live]);

  // ---------- Podcast preset: 4K (or HD) · 25/30 fps · 180° shutter · WB locked · stabilization off ----------
  function applyPodcastPreset() {
    const c = capsRef.current;
    if (!c) return;
    if (take.current) return say('Stop recording to change format.', { tone: 'warn' });
    const want = settingsRef.current.mains === 50 ? 25 : 30;
    const res = [2160, 1080].find((r) => c.fps[r]?.includes(want)) ?? settingsRef.current.res;
    const fps = c.fps[res]?.includes(want) ? want : nearest(c.fps[res] ?? [want], want);
    patch({ res, fps, stabilization: false, hdr: false, ...(c.codec ? { codec: 'hevc' } : {}) });
    const done = [`${RES_LABEL[res]} · ${fps}`];
    if (c.manualExposure) { setManual({ shutter: 1 / (fps * 2) }); done.push(`1/${fps * 2}`); }
    haptic.thud();
    setSheet(null);
    // Let auto white balance settle on the new format, then hold it.
    setTimeout(async () => {
      try {
        if (c.manualWB && manualRef.current.wbTemp == null) { await ctrl()?.lockCurrentWhiteBalance(); done.push('WB locked'); }
      } catch {}
      say(`Podcast preset: ${done.join(' · ')}`);
    }, 1500);
  }

  // ---------- render ----------
  // Audio meter is opt-in (show audio comes from external mics); when off, the mic is never opened for it.
  const meterEnabled = hasMic && settings.meter && !micBusy && !(rec && OLD_ANDROID);
  // Levels go to the hub only while the meter is actually running.
  const onLevel = useRef((db) => linkRef.current.isOpen() && linkRef.current.send({ t: 'level', db })).current;
  const showMeter = hasMic && settings.meter;
  const zoom = caps ? clamp(settings.zoom, caps.zoom.min, Math.min(caps.zoom.max, 10)) : 1;
  const displayZoom = (lens?.factor ?? 1) * zoom;
  const fmtX = (x) => `${Math.round(x * 10) / 10}`.replace(/\.0$/, '');
  const backLenses = lenses.filter((l) => l.id !== 'front');
  const shutterTarget = pending ? pending === 'start' : rec;
  const anyManual = MANUAL_KEYS.some((k) => manual[k] != null);
  const flicker = fpsBeats(settings.fps, settings.mains) || (manual.shutter != null && shutterFlickers(manual.shutter, settings.mains));
  const linkState = link.state;
  const clips = useMemo(() => {
    const pend = cfg.pending || [];
    return {
      queued: pend.filter((j) => jobIsForHub(j, cfg.key)).length,
      previous: pend.filter((j) => !jobIsForHub(j, cfg.key)).map((j) => ({ name: j.path.split('/').pop(), session: j.session })),
      hubName: cfg.hubName,
    };
  }, [cfg.pending, cfg.key, cfg.hubName]);

  if (!device) {
    return <View style={[s.fill, s.center]}><StatusBar hidden /><Text style={s.dimText}>Starting camera…</Text></View>;
  }

  // Everything the user reads or taps lives on a canvas that is rotated to the physical orientation
  // (the window stays portrait). `insets`, `width` and `height` are already in canvas terms.
  const RAIL = 76 + SP.m + 48; // shutter column + gap + lens column (landscape right edge)
  const edgeL = insets.left + SP.m + (landscape && showMeter ? 24 : 0);
  const edgeR = insets.right + (landscape ? RAIL + SP.m * 2 : SP.m);
  const canvas = {
    position: 'absolute', width, height,
    left: (win.width - width) / 2, top: (win.height - height) / 2,
    transform: [{ rotate: rotAnim.interpolate({ inputRange: [-90, 90], outputRange: ['-90deg', '90deg'] }) }],
  };
  const size = { width, height };

  const lensChips = lens.id !== 'front' && backLenses.length > 1 && (
    <View style={[s.lensBar, landscape && s.lensBarV]}>
      {backLenses.map((l) => {
        const on = l.id === lens.id;
        return (
          <Pressable
            key={l.id}
            onPress={() => (on ? patch({ zoom: 1 }) : pickLens(l.id))}
            accessibilityRole="button"
            accessibilityLabel={`${l.id === 'ultra' ? 'Ultra wide' : l.id === 'tele' ? 'Telephoto' : 'Wide'} lens, ${fmtX(l.factor)} times`}
            accessibilityState={{ selected: on }}
            hitSlop={4}
            style={[s.lensChip, on && s.lensChipOn]}
          >
            <Text style={[s.lensText, mono, on && s.lensTextOn]} allowFontScaling={false}>
              {on ? `${fmtX(displayZoom)}×` : fmtX(l.factor)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
  const gridBtn = <IconButton icon="grid-outline" label="Grid" active={settings.grid} onPress={() => { haptic.tap(); patch({ grid: !settings.grid }); }} size={18} style={s.smallBtn} />;
  const torchBtn = caps?.torch
    ? <IconButton icon={settings.torch ? 'flashlight' : 'flashlight-outline'} label="Torch" active={settings.torch} tone="amber" onPress={() => { haptic.tap(); patch({ torch: !settings.torch }); }} size={18} style={s.smallBtn} />
    : <View style={s.smallBtn} />;
  const proBtn = <IconButton icon="options-outline" label="Pro controls" onPress={() => setSheet({ kind: 'pro' })} active={sheet?.kind === 'pro'} size={22} style={s.sideBtn} />;
  const flipBtn = <IconButton icon="camera-reverse-outline" label="Switch front and back camera" onPress={flip} size={22} style={s.sideBtn} disabled={!!take.current || !lenses.some((l) => l.id === 'front')} />;
  const shutter = <RecordButton recording={shutterTarget} pending={!!pending} onPress={onShutter} />;

  const statusRow = (
    <StatusRow
      name={cfg.name} hubName={cfg.hubName} linkState={linkState} liveState={liveState} liveRole={liveRole}
      rec={rec} since={recStartAt} thermal={thermal} hud={hud} bitrate={bitrate(settings)}
      onRepair={() => !take.current && Alert.alert('Pair with a different hub?', 'You’ll scan a new Tally Hub QR code.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Re-pair', onPress: () => commit({ ...cfgRef.current, host: null }) },
      ])}
    />
  );
  const strip = (
    <StatusStrip
      settings={settings} manual={manual} caps={caps} compact={compact} getController={ctrl}
      onRes={cycleRes} onFps={cycleFps}
      onFormat={() => setSheet({ kind: 'format' })}
      onPro={(tab) => setSheet({ kind: 'pro', tab })}
    />
  );
  const tags = (
    <View style={s.tags} pointerEvents="none">
      {aeLocked && <Tag text="AE/AF LOCK" tone="amber" />}
      {anyManual && <Tag text="MANUAL" tone="amber" />}
      {flicker && <Tag text="FLICKER RISK" tone="amber" />}
      {pending && <Tag text={pending === 'start' ? 'WAITING FOR HUB' : 'STOPPING'} />}
      {link.online && (previewErr || !previewKind) && (
        <Text style={s.previewNote} numberOfLines={1} allowFontScaling={false}>
          {previewErr ? `Preview unavailable: ${previewErr}` : 'Hub preview not supported on this phone yet'}
        </Text>
      )}
      <View style={{ flex: 1 }} />
      {histVisible && <Histogram />}
    </View>
  );
  const cardPos = landscape
    ? { top: insets.top + 120, left: edgeL, right: edgeR }
    : { bottom: insets.bottom + 216, left: insets.left + SP.m, right: insets.right + SP.m };

  return (
    <View style={s.fill} onStartShouldSetResponderCapture={() => { poke(); return false; }}>
      <StatusBar hidden />
      <MicSource enabled={meterEnabled} recording={rec || !!pending} pausedLabel={!hasMic ? 'NO MIC' : rec ? 'OFF' : '…'} onLevel={onLevel} />
      <Camera
        ref={cam}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive
        outputs={outputs}
        constraints={constraints}
        zoom={zoom}
        exposure={caps?.exposureBias ? settings.exposure : undefined}
        torchMode={settings.torch && caps?.torch ? 'on' : 'off'}
        resizeMode="contain"
        allowBackgroundAudioPlayback
        onLayout={(e) => (layout.current = e.nativeEvent.layout)}
        onSessionConfigSelected={onSessionConfigSelected}
        onStarted={onStarted}
        onError={(e) => { say(`Camera: ${e.message}`, { tone: 'warn' }); report(`camera: ${e.message}`); }}
        onInterruptionStarted={(r) => say(r === 'video-device-not-available-due-to-system-pressure'
          ? 'Camera paused: the phone is too hot.' : `Camera interrupted (${r}).`, { tone: 'warn' })}
      />

      {/* Window layer: gesture surface over the image, plus overlays positioned in window space. */}
      <View style={StyleSheet.absoluteFill} {...responder.panHandlers} accessibilityLabel="Viewfinder. Tap to focus, hold to lock exposure and focus, pinch to zoom." />
      {settings.grid && <Grid />}
      <FocusReticle point={reticle} locked={aeLocked} exposure={settings.exposure} rot={rot} />
      {rec && <View pointerEvents="none" style={s.tally} />}

      {/* Canvas layer: rotated to the physical orientation, so it reads upright however the phone is held. */}
      <Animated.View style={canvas} pointerEvents="box-none">
        <RotContext.Provider value={rot}>
          {landscape ? (
            <>
              <View style={[s.top, { top: insets.top + SP.s, left: edgeL, right: edgeR }]} pointerEvents="box-none">
                {strip}
                {tags}
              </View>
              <View style={[s.top, { bottom: insets.bottom + SP.s, left: edgeL, right: edgeR }]} pointerEvents="box-none">
                {statusRow}
              </View>
            </>
          ) : (
            <View style={[s.top, { top: insets.top + SP.s, left: edgeL, right: edgeR }]} pointerEvents="box-none">
              {statusRow}
              {strip}
              {tags}
            </View>
          )}

          {linkState === 'unreachable' && !hintHidden && !rec && (
            <View style={[s.hint, cardPos]}>
              <Text style={s.hintTitle}>Can’t reach {cfg.hubName || 'Tally Hub'}</Text>
              <Text style={s.hintLine}>• Is the laptop on the same Wi-Fi as this phone?</Text>
              <Text style={s.hintLine}>• Allow Tally Hub through the laptop’s firewall (shown in the hub).</Text>
              {Platform.OS === 'ios' && <Text style={s.hintLine}>• iPhone: Settings → Privacy & Security → Local Network → Tally Cam ON.</Text>}
              <View style={s.hintBtns}>
                <Pressable onPress={() => setHintHidden(true)} hitSlop={8} style={s.hintBtn} accessibilityRole="button"><Text style={s.hintBtnText}>Hide</Text></Pressable>
                <Pressable onPress={() => commit({ ...cfgRef.current, host: null })} hitSlop={8} style={[s.hintBtn, { backgroundColor: '#fff' }]} accessibilityRole="button">
                  <Text style={[s.hintBtnText, { color: '#000' }]}>Re-scan QR</Text>
                </Pressable>
              </View>
            </View>
          )}
          {linkState === 'closed' && !dimmed && (
            <Pressable onPress={link.reconnect} style={[s.hint, cardPos]} accessibilityRole="button" accessibilityLabel="Closed by Tally Hub. Tap to reconnect.">
              <Text style={s.hintTitle}>Closed by {cfg.hubName || 'Tally Hub'}</Text>
              <Text style={s.hintLine}>This camera was closed from the hub. {rec ? 'The recording continues and copies on the next connection.' : 'Clips waiting to copy are kept.'}</Text>
              <View style={s.hintBtns}>
                <Pressable onPress={link.reconnect} hitSlop={8} style={[s.hintBtn, { backgroundColor: '#fff' }]} accessibilityRole="button">
                  <Text style={[s.hintBtnText, { color: '#000' }]}>Reconnect</Text>
                </Pressable>
              </View>
            </Pressable>
          )}

          {landscape && showMeter && (
            <View style={[s.meterSide, { left: insets.left + SP.s, top: insets.top + 96, bottom: insets.bottom + 96 }]} pointerEvents="none">
              <LevelMeter vertical compact />
            </View>
          )}

          {zoomHud && (
            <View pointerEvents="none" style={s.zoomHud}><Text style={[s.zoomHudText, mono]}>{fmtX(displayZoom)}×</Text></View>
          )}

          {/* ---------- bottom (portrait) / right rail (landscape, camcorder style) ---------- */}
          {landscape ? (
            <View style={[s.rail, { right: insets.right + SP.m, top: insets.top + SP.s, bottom: insets.bottom + SP.s }]} pointerEvents="box-none">
              <View style={s.lensCol} pointerEvents="box-none">
                {torchBtn}
                {lensChips || <View />}
                {gridBtn}
              </View>
              <View style={s.shutterCol} pointerEvents="box-none">
                {flipBtn}
                {shutter}
                {proBtn}
              </View>
            </View>
          ) : (
            <View style={[s.bottom, { bottom: insets.bottom + (compact ? SP.s : SP.m), left: insets.left + SP.m, right: insets.right + SP.m }]} pointerEvents="box-none">
              {showMeter && <View style={s.meterH} pointerEvents="none"><LevelMeter vertical={false} compact /></View>}
              <View style={s.lensRow} pointerEvents="box-none">
                {gridBtn}
                {lensChips || <View />}
                {torchBtn}
              </View>
              <View style={s.shutterRow} pointerEvents="box-none">
                {proBtn}
                {shutter}
                {flipBtn}
              </View>
            </View>
          )}

          {sheet?.kind === 'format' && caps && (
            <FormatSheet caps={caps} settings={settings} recording={!!take.current} landscape={landscape} size={size} insets={insets}
              snapshots={histOk} clips={clips} onPreset={applyPodcastPreset}
              onSet={(p) => applySettings(p, false)} onClose={() => setSheet(null)} />
          )}
          {sheet?.kind === 'pro' && caps && (
            <ProPanel caps={caps} settings={settings} manual={manual} aeLocked={aeLocked} landscape={landscape} size={size} insets={insets}
              tab={sheet.tab} getController={ctrl} onSet={(p) => applySettings(p, false)} onManual={setManual}
              onToggleLock={() => lockAll(!aeLocked)} onClose={() => setSheet(null)} />
          )}

          <Toast ref={toast} top={insets.top + (landscape ? 104 : 132)} />

          {dimmed && <Saver insets={insets} since={recStartAt} hot={hot} showMeter={showMeter && meterEnabled} onWake={poke} />}
        </RotContext.Provider>
      </Animated.View>
    </View>
  );
}

// ---------- pieces with their own timers, so the camera screen doesn't re-render every tick ----------

// One compact status line: name + link state (shrinks), then fixed-width pills that never overlap.
// When the row is too narrow the least important pills go (time-left first, then battery); see layout.js.
function StatusRow({ name, hubName, linkState, liveState, liveRole, rec, since, thermal, hud, bitrate: bps, onRepair }) {
  const [rowW, setRowW] = useState(0);
  const online = linkState === 'online';
  const label = online ? null : { rejected: 'REJECTED', unreachable: 'NO HUB', closed: 'CLOSED' }[linkState] || 'SEARCHING';
  const wanted = ['timer'];
  if (liveState === 'live' || liveState === 'connecting') wanted.push('live');
  if (thermal && thermal.level >= 1) wanted.push('thermal');
  if (hud.battery != null) wanted.push('battery');
  if (hud.free != null) wanted.push('left');
  const show = new Set(rowW ? fitStatusPills(rowW, wanted) : ['timer']);
  const lowBat = hud.battery < 0.2 && !hud.charging;
  const live = liveState === 'live', monitor = liveRole === 'monitor';
  return (
    <View style={s.statusRow} pointerEvents="box-none" onLayout={(e) => setRowW(e.nativeEvent.layout.width)}>
      <Pressable
        onLongPress={onRepair}
        accessibilityLabel={online ? `${name}, connected to ${hubName || 'Tally Hub'}. Hold to re-pair.` : `${name}, ${label.toLowerCase()}. Hold to re-pair.`}
        hitSlop={8}
        style={s.hubChip}
      >
        <View style={[s.dot, { backgroundColor: online ? C.green : linkState === 'searching' ? C.faint : C.amber }]} />
        <Text style={s.camName} numberOfLines={1} allowFontScaling={false}>{name}</Text>
        {label && <Text style={[s.hubText, linkState !== 'searching' && { color: C.amber }]} numberOfLines={1} allowFontScaling={false}>{label}</Text>}
      </Pressable>
      {show.has('live') && (
        <View style={[s.pill, s.livePill, { width: PILL_W.live }, monitor ? s.hubPill : !live && { borderColor: C.amber }]}
          accessibilityLabel={monitor ? 'Sending preview to the hub' : live ? 'Live feed on air' : 'Live feed connecting'}>
          <Text style={[s.liveText, monitor ? { color: C.dim } : !live && { color: C.amber }]} allowFontScaling={false}>
            {monitor ? 'HUB' : live ? 'LIVE' : 'LIVE…'}
          </Text>
        </View>
      )}
      <Timecode rec={rec} since={since} />
      {show.has('thermal') && (
        <View style={[s.pill, { width: PILL_W.thermal }]} accessibilityLabel={`Phone temperature ${thermal.label}`}>
          <Ionicons name="thermometer-outline" size={13} color={thermalColor(thermal.level, C)} />
          <Text style={[s.sysText, mono, { color: thermalColor(thermal.level, C) }]} allowFontScaling={false} numberOfLines={1}>{thermalText(thermal)}</Text>
        </View>
      )}
      {show.has('battery') && (
        <View style={[s.pill, { width: PILL_W.battery }]} accessibilityLabel={`Battery ${Math.round(hud.battery * 100)} percent${hud.charging ? ', charging' : ''}`}>
          <Ionicons name={hud.charging ? 'battery-charging-outline' : 'battery-half-outline'} size={15} color={lowBat ? C.amber : C.dim} />
          <Text style={[s.sysText, mono, lowBat && { color: C.amber }]} allowFontScaling={false} numberOfLines={1}>{Math.round(hud.battery * 100)}%</Text>
        </View>
      )}
      {show.has('left') && (
        <View style={[s.pill, { width: PILL_W.left }]} accessibilityLabel="Recording time left on this phone">
          <Text style={[s.sysText, mono]} allowFontScaling={false} numberOfLines={1}>{fmtRemaining(hud.free / (bps / 8))}</Text>
        </View>
      )}
    </View>
  );
}

// The pro strip: RES · FPS · SHUTTER · ISO · WB · TINT. Tap a value to change it.
function StatusStrip({ settings, manual, caps, compact, getController, onRes, onFps, onFormat, onPro }) {
  const live = useLiveReadout(getController, 1000); // auto ISO/shutter readout; 1 Hz is plenty for the strip
  const [w, setW] = useState(0);
  const exposureLive = live.minISO > 0 && live.dur > 0;
  const ev = settings.exposure;
  const cells = [
    <StatCell key="res" label="RES" value={RES_LABEL[settings.res]} onPress={onRes} onLongPress={onFormat}
      a11y={`Resolution ${RES_LABEL[settings.res]}. Tap to change, hold for all formats.`} />,
    <StatCell key="fps" label="FPS" value={String(settings.fps)} onPress={onFps} onLongPress={onFormat}
      a11y={`${settings.fps} frames per second. Tap to change, hold for all formats.`} />,
  ];
  if (exposureLive) {
    const isoManual = manual.iso != null, shManual = manual.shutter != null;
    cells.push(
      <StatCell key="sh" label="SHUTTER" flex={1.3} value={fmtShutter(manual.shutter ?? live.dur)} tone={shManual ? 'amber' : null}
        onPress={() => onPro('exposure')} a11y={`Shutter ${fmtShutter(manual.shutter ?? live.dur)}${shManual ? ', manual' : ', auto'}`} />,
      <StatCell key="iso" label="ISO" value={String(Math.round(manual.iso ?? live.iso ?? 0))} tone={isoManual ? 'amber' : null}
        onPress={() => onPro('exposure')} a11y={`ISO ${Math.round(manual.iso ?? live.iso ?? 0)}${isoManual ? ', manual' : ', auto'}`} />,
    );
  }
  if (!exposureLive || ev !== 0) {
    cells.push(<StatCell key="ev" label="EV" value={`${ev > 0 ? '+' : ''}${ev.toFixed(1)}`} tone={ev !== 0 ? 'amber' : null} onPress={() => onPro('exposure')} />);
  }
  if (caps?.manualWB) {
    const wb = manual.wbTemp;
    cells.push(<StatCell key="wb" label="WB" flex={1.2} value={wb != null ? `${wb}K` : 'AUTO'} tone={wb != null ? 'amber' : null} onPress={() => onPro('wb')} />);
    if (wb != null && !compact) {
      const tint = manual.wbTint ?? 0;
      cells.push(<StatCell key="tint" label="TINT" value={`${tint > 0 ? '+' : ''}${tint}`} tone="amber" onPress={() => onPro('wb')} />);
    }
  }
  // Fit what the measured width allows; anything else is one tap away in the "…" / Pro sheets.
  const fit = w ? Math.max(2, Math.floor((w - 52) / (compact ? 50 : 58))) : 2;
  const shown = cells.slice(0, fit);
  return (
    <View style={s.strip} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
      {shown.map((c, i) => [i > 0 && <View key={`d${i}`} style={s.stripDiv} />, c])}
      <View style={s.stripDiv} />
      <Pressable onPress={onFormat} accessibilityRole="button" accessibilityLabel="Format and display settings" hitSlop={6}
        style={({ pressed }) => [s.stripBtn, pressed && { opacity: 0.55 }]}>
        <Ionicons name="ellipsis-horizontal" size={18} color={C.text} />
      </Pressable>
    </View>
  );
}

// ---------- histogram (luma, 32 bins), published from the snapshot loop ----------
const histBus = {
  data: null,
  subs: new Set(),
  publish(d) { this.data = d; this.subs.forEach((f) => f(d)); },
};
function lumaHistogram(px) {
  const bins = new Array(32).fill(0);
  const bytes = new Uint8Array(px.buffer);
  const f = px.pixelFormat || 'RGBA';
  const bpp = f === 'RGB' || f === 'BGR' ? 3 : 4;
  const r = f.indexOf('R'), g = f.indexOf('G'), b = f.indexOf('B');
  if (r < 0 || g < 0 || b < 0) return null;
  for (let i = 0; i + bpp <= bytes.length; i += bpp) {
    const y = 0.2126 * bytes[i + r] + 0.7152 * bytes[i + g] + 0.0722 * bytes[i + b];
    bins[Math.min(31, y >> 3)]++;
  }
  const max = Math.max(...bins) || 1;
  return bins.map((v) => v / max);
}
function Histogram() {
  const [d, setD] = useState(histBus.data);
  useEffect(() => { histBus.subs.add(setD); return () => histBus.subs.delete(setD); }, []);
  const clipped = d && d[31] > 0.6;
  return (
    <View style={[s.hist, clipped && { borderColor: C.amber }]} accessibilityLabel={clipped ? 'Histogram: highlights clipping' : 'Histogram'}>
      {(d ?? new Array(32).fill(0)).map((v, i) => (
        <View key={i} style={{ flex: 1, height: `${Math.max(2, v * 100)}%`, backgroundColor: i === 31 && clipped ? C.amber : 'rgba(255,255,255,0.75)' }} />
      ))}
    </View>
  );
}

function Timecode({ rec, since }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!rec) return;
    const t = setInterval(() => tick((n) => n + 1), 500); // whole seconds shown; 2 Hz keeps it from stuttering
    return () => clearInterval(t);
  }, [rec]);
  const secs = rec ? (Date.now() - since.current) / 1000 : 0;
  return (
    <View style={[s.pill, s.timecode, rec && s.timecodeRec, { width: PILL_W.timer }]} accessibilityLabel={rec ? `Recording, ${fmtDuration(secs)}` : 'Standby'}>
      <View style={[s.tcDot, { backgroundColor: rec ? '#fff' : C.faint }]} />
      <Text style={[s.tcText, mono, !rec && { color: C.dim }]} allowFontScaling={false}>{fmtDuration(secs)}</Text>
    </View>
  );
}

// Recording saver: near-black screen with only the essentials; fully black when the phone is hot.
function Saver({ insets, since, hot, showMeter, onWake }) {
  const o = useRef(new Animated.Value(0)).current;
  useEffect(() => { Animated.timing(o, { toValue: 1, duration: T.slow * 2, useNativeDriver: true }).start(); }, []);
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 0.25, duration: 800, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 1, duration: 800, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, []);
  const [, tick] = useState(0);
  useEffect(() => {
    if (hot) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [hot]);
  return (
    <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: '#000', opacity: o }]}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onWake}
        accessibilityLabel="Recording. Screen dimmed to reduce heat. Tap to show controls.">
        {!hot && (
          <>
            <View style={[s.saverTop, { top: insets.top + SP.m, left: insets.left + SP.m }]}>
              <Animated.View style={[s.saverDot, { opacity: pulse }]} />
              <Text style={[s.saverTime, mono]} allowFontScaling={false}>{fmtDuration((Date.now() - since.current) / 1000)}</Text>
            </View>
            {showMeter && (
              <View style={[s.saverMeter, { left: insets.left + SP.m, right: insets.right + SP.m, bottom: insets.bottom + SP.m }]}>
                <LevelMeter vertical={false} compact />
              </View>
            )}
            <Text style={[s.saverHint, { bottom: insets.bottom + SP.xl + SP.m }]} allowFontScaling={false}>Tap to wake</Text>
          </>
        )}
      </Pressable>
    </Animated.View>
  );
}

const SHADOW = { textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 3, textShadowOffset: { width: 0, height: 1 } };
const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#000' },
  center: { alignItems: 'center', justifyContent: 'center' },
  dimText: { color: C.dim, fontSize: 14 },
  tally: { ...StyleSheet.absoluteFillObject, borderWidth: 3, borderColor: C.red },
  top: { position: 'absolute', gap: SP.s },

  statusRow: { flexDirection: 'row', alignItems: 'center', minHeight: 28, gap: SP.s },
  hubChip: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 28 },
  pill: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3, height: 26, borderRadius: 6, overflow: 'hidden' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  camName: { color: C.text, fontSize: 13, fontWeight: '700', flexShrink: 1, ...SHADOW },
  hubText: { color: C.faint, fontSize: 9, fontWeight: '800', letterSpacing: 0.8, flexShrink: 1, ...SHADOW },
  sysText: { color: C.dim, fontSize: 12, fontWeight: '600', ...SHADOW },

  timecode: { gap: 6 },
  timecodeRec: { backgroundColor: C.red },
  tcDot: { width: 7, height: 7, borderRadius: 4 },
  tcText: { color: '#fff', fontSize: 14, fontWeight: '600', letterSpacing: 0.5, ...SHADOW },

  strip: { flexDirection: 'row', alignItems: 'center', minHeight: 44, overflow: 'hidden', paddingHorizontal: SP.xs, borderRadius: 12, backgroundColor: C.surface },
  stripDiv: { width: StyleSheet.hairlineWidth, height: 24, backgroundColor: C.line },
  stripBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  tags: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', gap: 6, minHeight: 20 },
  livePill: { height: 20, borderRadius: 4, borderWidth: 1.5, borderColor: C.red },
  hubPill: { borderColor: C.line, backgroundColor: C.surface },
  liveText: { color: C.red, fontSize: 10, fontWeight: '800', letterSpacing: 0.8 },
  previewNote: { color: C.faint, fontSize: 11, alignSelf: 'center', flexShrink: 1, ...SHADOW },
  hist: { width: 96, height: 40, flexDirection: 'row', alignItems: 'flex-end', gap: 1, padding: 3, borderRadius: 6, borderWidth: 1, borderColor: 'transparent', backgroundColor: C.surface },
  hint: { position: 'absolute', padding: SP.m, gap: 6, borderRadius: 14, backgroundColor: C.sheet, maxWidth: 520, alignSelf: 'center' },
  hintTitle: { color: C.text, fontSize: 15, fontWeight: '700', marginBottom: 2 },
  hintLine: { color: C.dim, fontSize: 13, lineHeight: 18 },
  hintBtns: { flexDirection: 'row', justifyContent: 'flex-end', gap: SP.s, marginTop: SP.s },
  hintBtn: { minHeight: 36, paddingHorizontal: SP.m, borderRadius: 18, justifyContent: 'center', backgroundColor: C.surfaceHi },
  hintBtnText: { color: C.text, fontSize: 14, fontWeight: '600' },

  bottom: { position: 'absolute', alignItems: 'center', gap: SP.m },
  meterH: { width: '60%', maxWidth: 220, opacity: 0.85 },
  lensRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', width: '100%', maxWidth: 360 },
  shutterRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', width: '100%', maxWidth: 360, paddingHorizontal: SP.l },
  rail: { position: 'absolute', flexDirection: 'row', alignItems: 'center', gap: SP.m },
  lensCol: { height: '100%', maxHeight: 360, alignItems: 'center', justifyContent: 'space-between', paddingVertical: SP.l },
  shutterCol: { height: '100%', maxHeight: 360, alignItems: 'center', justifyContent: 'space-between', paddingVertical: SP.m },
  sideBtn: { width: 48, height: 48, borderRadius: 24 },
  smallBtn: { width: 40, height: 40, borderRadius: 20 },

  lensBar: { flexDirection: 'row', alignItems: 'center', gap: SP.xs, padding: SP.xs, borderRadius: 24, backgroundColor: C.surface },
  lensBarV: { flexDirection: 'column-reverse' },
  lensChip: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  lensChipOn: { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.16)' },
  lensText: { color: C.dim, fontSize: 12, fontWeight: '700' },
  lensTextOn: { color: C.text, fontSize: 13 },

  meterSide: { position: 'absolute', width: 18 },
  zoomHud: { position: 'absolute', alignSelf: 'center', top: '44%', paddingHorizontal: SP.m, paddingVertical: 6, borderRadius: 18, backgroundColor: C.surface },
  zoomHudText: { color: C.text, fontSize: 22, fontWeight: '700' },

  saverTop: { position: 'absolute', flexDirection: 'row', alignItems: 'center', gap: SP.s },
  saverDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: C.red },
  saverTime: { color: 'rgba(255,59,48,0.75)', fontSize: 15, fontWeight: '600' },
  saverMeter: { position: 'absolute', height: 24, opacity: 0.5 },
  saverHint: { position: 'absolute', alignSelf: 'center', color: 'rgba(255,255,255,0.22)', fontSize: 12 },
});
