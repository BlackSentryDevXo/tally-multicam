const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const tiles = new Map(); // id -> { el, name, status, url, peak, peakAt, lastLevel, clipUntil, thermLogged, live, rtc }
let recording = false, startedAt = 0;
let cfgInfo = {};

const RES = [[2160, '4K'], [1080, '1080p'], [720, '720p']];
const FPS = [[24, '24'], [25, '25'], [30, '30'], [50, '50'], [60, '60']];
const CODEC = [['h264', 'H.264'], ['hevc', 'HEVC']];
const RES_LABEL = Object.fromEntries(RES);
const LENS_LABEL = { ultra: '0.5×', wide: '1×', tele: 'Tele', front: 'Front' };
const LENS_ORDER = ['ultra', 'wide', 'tele', 'front'];
const THERMAL = [null, ['warn', 'Warm'], ['hot', 'Hot'], ['crit', 'Critical']];
// ponytail: rough GB per hour of phone video, used only when the phone doesn't send remainingSec
const GB_PER_HOUR = { 720: 5, 1080: 10, 2160: 30 };
const PREVIEW_W = 640;

const gb = (b) => `${b >= 1e11 ? Math.round(b / 1e9) : (b / 1e9).toFixed(1)} GB`;
const dur = (sec) => { const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m`; };
const icon = (id) => `<svg class="i"><use href="#i-${id}"/></svg>`;
const online = (t) => !t.el.classList.contains('offline');

// ---------- activity log + toasts ----------
function log(msg, kind = '', mirror = true) {
  if (mirror) hub.call('rlog', msg); // hub-originated lines are already in the file
  const d = document.createElement('div');
  d.className = kind;
  d.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  $('#history').prepend(d);
  while ($('#history').childElementCount > 300) $('#history').lastChild.remove();
  $('#activity .last').textContent = msg;
}
function toast(msg, kind = 'ok') {
  log(msg, kind === 'ok' ? '' : kind);
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.innerHTML = icon(kind === 'ok' ? 'check' : 'warn');
  t.append(msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'ok' ? 3500 : 6000);
  while ($('#toasts').childElementCount > 4) $('#toasts').firstChild.remove();
}
$('#histBtn').onclick = () => document.body.classList.toggle('history');
$('#logBtn').onclick = () => hub.call('openLog');

// Promise-based confirm in the app's own style.
function ask(title, body, okLabel = 'OK') {
  const dlg = $('#askDlg');
  $('#askTitle').textContent = title;
  $('#askBody').replaceChildren(...(Array.isArray(body) ? [listOf(body)] : [Object.assign(document.createElement('p'), { textContent: body })]));
  $('#askOk').textContent = okLabel;
  dlg.returnValue = '';
  dlg.showModal();
  $('#askOk').focus();
  return new Promise((res) => dlg.addEventListener('close', () => res(dlg.returnValue === 'yes'), { once: true }));
}
function listOf(items) {
  const ul = document.createElement('ul');
  ul.className = 'issues';
  for (const it of items) { const li = document.createElement('li'); li.innerHTML = icon('warn'); li.append(it); ul.append(li); }
  return ul;
}

// ---------- segmented controls ----------
function seg(el, options, onPick) {
  el.replaceChildren(...options.map(([v, label]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.dataset.v = v;
    b.onclick = () => { segSet(el, v); onPick(v); };
    return b;
  }));
}
const segSet = (el, v) => $$('button', el).forEach((b) => b.classList.toggle('on', b.dataset.v === String(v)));
const segGet = (el) => $('button.on', el)?.dataset.v;

// ---------- WebRTC (WHEP) tile video: MediaMTX on localhost plays each phone's feed as real video ----------
// Falls back to the JPEG thumbnails whenever no frames are flowing; reconnects with backoff while the feed is ready.
function rtcStart(t) {
  if (t.rtc || !t.live?.ready || !t.live.path || !online(t) || !t.visible || hidden()) return;
  const video = $('video', t.el);
  const r = { pc: null, session: null, frames: 0, lastFrames: 0, lastAt: performance.now(), playing: false, stop: false, fails: t.rtcFails || 0 };
  t.rtc = r;
  (async () => {
    const pc = new RTCPeerConnection({ iceServers: [] });
    r.pc = pc;
    const vt = pc.addTransceiver('video', { direction: 'recvonly' });
    try { vt.receiver.jitterBufferTarget = 0; } catch {} // show frames as soon as they arrive
    pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.ontrack = (e) => { if (e.track.kind === 'video') { video.srcObject = new MediaStream([e.track]); video.play().catch(() => {}); } };
    pc.onconnectionstatechange = () => { if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) rtcStop(t, true); };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    // Localhost only: gather host candidates up front and send one complete offer (no trickle needed).
    await new Promise((res) => {
      if (pc.iceGatheringState === 'complete') return res();
      const done = () => { pc.removeEventListener('icegatheringstatechange', chk); res(); };
      const chk = () => pc.iceGatheringState === 'complete' && done();
      pc.addEventListener('icegatheringstatechange', chk);
      setTimeout(done, 1500);
    });
    if (r.stop) return;
    const ans = await hub.call('whep', t.live.path, pc.localDescription.sdp); // signalling goes through the main process
    if (!ans.ok) throw new Error(ans.error);
    r.session = ans.session;
    if (r.stop) { hub.call('whepEnd', r.session); return; }
    await pc.setRemoteDescription({ type: 'answer', sdp: ans.sdp });
    const tick = (_now, meta) => { r.frames = meta.presentedFrames; if (!r.stop) video.requestVideoFrameCallback(tick); };
    video.requestVideoFrameCallback(tick);
  })().catch((e) => { if (!r.stop) { t.rtcWhy = e.message; rtcStop(t, true); } });
}
function rtcStop(t, retry = false) {
  const r = t.rtc;
  if (!r) return;
  r.stop = true;
  t.rtc = null;
  if (r.playing) keepLastFrame(t);
  try { r.pc?.close(); } catch {}
  if (r.session) hub.call('whepEnd', r.session);
  const video = $('video', t.el);
  video.srcObject = null;
  setPlaying(t, false);
  if (retry) {
    t.rtcFails = Math.min(6, r.fails + 1);
    clearTimeout(t.rtcTimer);
    t.rtcTimer = setTimeout(() => { t.rtcTimer = null; rtcStart(t); }, Math.min(8000, 500 * 2 ** t.rtcFails));
  } else t.rtcFails = 0;
}
function setPlaying(t, on) {
  if ((t.rtcPlaying || false) === on) return;
  t.rtcPlaying = on;
  t.el.classList.toggle('video', on);
  if (on) { t.rtcFails = 0; t.gotFrame = true; }
  updatePreviewRate(t);
  renderLive(t);
}
// The last video frame stays on the tile when the stream stops (offline, feed off), like the thumbnails do.
function keepLastFrame(t) {
  const video = $('video', t.el);
  if (!video.videoWidth) return;
  try {
    const c = document.createElement('canvas');
    c.width = Math.min(PREVIEW_W, video.videoWidth); c.height = Math.round(c.width * video.videoHeight / video.videoWidth);
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    c.toBlob((b) => { if (!b) return; if (t.url) URL.revokeObjectURL(t.url); t.url = URL.createObjectURL(b); $('img', t.el).src = t.url; }, 'image/jpeg', 0.8);
  } catch {}
}
// Frame-stall watchdog: 3 s without a new frame means the feed is gone, whatever the connection says.
setInterval(() => {
  const now = performance.now();
  for (const t of tiles.values()) {
    const r = t.rtc;
    if (!r) { if (t.live?.ready && online(t) && t.visible && !t.rtcTimer) rtcStart(t); continue; }
    if (r.frames !== r.lastFrames) { r.lastFrames = r.frames; r.lastAt = now; if (!r.playing) { r.playing = true; setPlaying(t, true); } }
    else if (r.playing && now - r.lastAt > 3000) { t.rtcWhy = 'no frames for 3 s'; rtcStop(t, true); }
    else if (!r.playing && now - r.lastAt > 8000) { t.rtcWhy = 'no video within 8 s'; rtcStop(t, true); }
  }
}, 500);

// ---------- thumbnail rate: only what is on screen costs the phone anything ----------
let winHidden = false;
const hidden = () => winHidden || document.visibilityState === 'hidden';
hub.on('winVisible', (v) => {
  winHidden = !v;
  for (const t of tiles.values()) { updatePreviewRate(t); if (v) rtcStart(t); else rtcStop(t); }
});
function desiredPreview(t) {
  if (hidden()) return 2;
  if (t.rtcPlaying) return 1; // fallback frames only
  return t.visible ? 12 : 2;
}
function updatePreviewRate(t, force = false) {
  const fps = desiredPreview(t);
  if (!force && t.sentFps === fps) return;
  t.sentFps = fps;
  if (online(t)) hub.call('preview', t.id, fps, PREVIEW_W);
}
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const t = tiles.get(e.target.dataset.id);
    if (!t) continue;
    t.visible = e.isIntersecting;
    updatePreviewRate(t);
    if (t.visible) rtcStart(t); else rtcStop(t);
  }
}, { root: $('main'), threshold: 0.05 });
document.addEventListener('visibilitychange', () => {
  for (const t of tiles.values()) { updatePreviewRate(t); if (hidden()) rtcStop(t); else rtcStart(t); }
});

// ---------- tiles ----------
function tile(id) {
  if (tiles.has(id)) return tiles.get(id);
  const el = $('#tileTpl').content.firstElementChild.cloneNode(true);
  el.dataset.id = id;
  const t = { id, el, name: '', status: {}, url: null, peak: -60, peakAt: 0, lastLevel: 0, clipUntil: 0, thermLogged: 0, touched: 0, visible: true, live: null, rtc: null };
  el.onclick = () => select(id); // after the view's own handler: the first click selects, later ones focus
  $('.view', el).onclick = (e) => {
    if (sel !== id || !online(t)) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    const fr = frameOf(id); // the tile shows the framed view: focus where that point is in the full frame
    hub.call('focus', id, fr.x + (x - 0.5) / fr.zoom, fr.y + (y - 0.5) / fr.zoom);
    const f = $('.focus', el);
    Object.assign(f.style, { left: `${x * 100}%`, top: `${y * 100}%` });
    f.classList.add('show');
    requestAnimationFrame(() => requestAnimationFrame(() => f.classList.remove('show')));
  };
  $('#grid').append(el);
  tiles.set(id, t);
  applyFrame(t);
  io.observe(el);
  return t;
}
function dropTile(id, t) {
  if (sel === id) select(null);
  io.unobserve(t.el);
  rtcStop(t);
  clearTimeout(t.rtcTimer);
  t.rtcTimer = null;
  if (t.url) URL.revokeObjectURL(t.url);
  t.el.remove();
  tiles.delete(id);
}

// The tile's format pill: lens · resolution · fps · codec (+ HDR, lock, manual).
const lensName = (t, l) => (l !== 'front' && t.status.lensX?.[l] ? `${+t.status.lensX[l].toFixed(1)}×` : LENS_LABEL[l]);
function fmtParts(t, flags = true) {
  const s = t.status.settings;
  if (!s) return [];
  const m = t.status.manual || {};
  const parts = [lensName(t, s.lens), RES_LABEL[s.res] || s.res, s.fps && `${s.fps}p`, s.codec && (s.codec === 'hevc' ? 'HEVC' : 'H.264')];
  if (s.hdr) parts.push('HDR');
  if (!flags) return parts.filter(Boolean);
  if (t.status.locked) parts.push('AE/AF LOCK');
  else if (['iso', 'shutter', 'focus', 'wbTemp'].some((k) => m[k] != null)) parts.push('MANUAL');
  return parts.filter(Boolean);
}
function syncControls(t) {
  const fmt = $('.fmt', t.el);
  fmt.textContent = fmtParts(t).join(' · ');
  fmt.hidden = !fmt.textContent;
  if (t.id === sel) syncInspector(t);
}

function chip(el, sel, text, cls = '') {
  const c = $(sel, el);
  c.hidden = text == null;
  if (text == null) return;
  c.className = `chip ${sel.slice(1)} ${cls}`;
  c.lastElementChild.textContent = text;
}

function renderStatus(t) {
  const { el, status: s } = t;
  el.classList.toggle('rec', !!s.recording);
  if (s.battery != null) {
    const pct = Math.round(s.battery * 100);
    chip(el, '.bat', `${pct}%`, s.charging ? 'good' : pct < 20 ? 'warn' : '');
    $('.bat use', el).setAttribute('href', s.charging ? '#i-bolt' : '#i-bat');
  }
  if (s.remainingSec != null) chip(el, '.disk', `${dur(s.remainingSec)} left`, s.remainingSec < 3600 ? 'warn' : '');
  else if (s.free != null) chip(el, '.disk', `${gb(s.free)} free`);
  const th = s.thermal;
  if (th && th.level >= 1) {
    const [cls, label] = THERMAL[Math.min(3, th.level)];
    chip(el, '.therm', th.tempC != null ? `${label} · battery ${Math.round(th.tempC)}°C` : label, cls);
  } else chip(el, '.therm', th?.tempC != null ? `battery ${Math.round(th.tempC)}°C` : null);
  // Android apps can only read the battery temperature; Warm/Hot/Critical is the phone's own verdict from internal
  // sensors (on a Fold the skin runs hotter than the battery), so the two can disagree between phones.
  $('.therm', el).title = 'Warm / Hot / Critical is the phone\'s own thermal status, from internal sensors apps can\'t read. The °C is the battery, the only temperature Android shares, so a phone can be Critical at a lower battery temperature than another phone that is only Warm.';
  const lvl = th?.level || 0;
  if (lvl > t.thermLogged) toast(`${t.name} is ${THERMAL[Math.min(3, lvl)][1].toLowerCase()}${th.tempC != null ? ` (battery ${Math.round(th.tempC)}°C)` : ''}. Unplug it from charging if you can, and give it shade and airflow.`, lvl >= 2 ? 'e' : 'w');
  t.thermLogged = lvl; // escalations only: falling back resets, so a new rise warns again
  syncControls(t);
  renderLive(t);
}

// ---------- inspector: every control for the selected camera, in one side panel ----------
// Phone status wins, except right after the operator touched a control (avoids slider fights).
const ISO_STOPS = [25, 32, 40, 50, 64, 80, 100, 125, 160, 200, 250, 320, 400, 500, 640, 800, 1000, 1250, 1600, 2000, 2500, 3200, 4000, 5000, 6400, 8000, 10000, 12800];
const SHUTTER_DENOMS = [24, 25, 30, 40, 48, 50, 60, 80, 96, 100, 120, 125, 160, 192, 200, 240, 250, 320, 400, 500, 640, 800, 1000, 1250, 1600, 2000, 2500, 3200, 4000, 5000, 6400, 8000];
const QUALITY = [['standard', 'Standard'], ['high', 'High'], ['max', 'Max']];
const MODES = [['auto', 'Auto'], ['manual', 'Manual']];
const LENS_NAME = { ultra: 'Ultra wide', wide: 'Wide', tele: 'Telephoto', front: 'Front' };
const PLATFORM = { ios: 'iPhone', android: 'Android' };
const TOUCH_MS = 1500;
const fmtShutter = (sec) => (!sec ? '–' : sec >= 0.5 ? `${sec.toFixed(1)}s` : `1/${Math.round(1 / sec)}`);
const fmtFocus = (v) => (v == null ? '–' : v <= 0.01 ? 'Near' : v >= 0.99 ? '∞' : v.toFixed(2));
const signed = (v, d = 1) => `${v > 0 ? '+' : ''}${(+v).toFixed(d)}`;
const nearestIdx = (list, v, f = (x) => x) => list.reduce((bi, x, i) => (Math.abs(f(x) - f(v)) < Math.abs(f(list[bi]) - f(v)) ? i : bi), 0);
const isoStops = ([lo, hi]) => { const l = ISO_STOPS.filter((v) => v >= lo * 0.98 && v <= hi * 1.02); return l.length > 1 ? l : [lo, hi]; };
const shutterStops = ([lo, hi]) => { const l = SHUTTER_DENOMS.map((d) => 1 / d).filter((x) => x >= lo * 0.999 && x <= hi * 1.001); return l.length > 1 ? l : [hi, lo]; };

let sel = null; // id of the camera in the inspector
const cur = () => tiles.get(sel);
function select(id) {
  if (id === sel) return;
  if (sel) { hub.call('inspect', sel, false); tiles.get(sel)?.el.classList.remove('sel'); }
  sel = id && tiles.has(id) ? id : null;
  $('#insp').hidden = !sel;
  document.body.classList.toggle('inspecting', !!sel);
  if (!sel) return;
  const t = cur();
  t.el.classList.add('sel');
  t.mPending = null;
  if (t.url) $('#mmap img').src = t.url; else $('#mmap img').removeAttribute('src');
  hub.call('inspect', sel, true); // the phone sends live auto ISO/shutter/focus while this is open
  syncInspector(t, true);
}
$('#inspX').onclick = () => select(null);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sel && !$('dialog[open]')) select(null); });

const touch = () => { const t = cur(); if (t) t.touched = Date.now(); return t; };
const setS = (o) => { const t = touch(); if (t) hub.call('settings', t.id, o); };
// Manual 3A; null = back to auto. Shown at once, then the phone's status (clamped to its ranges) takes over.
const setM = (o) => {
  const t = touch();
  if (!t) return;
  t.mPending = { ...(t.mPending || {}), ...o };
  hub.call('manual', t.id, o);
  syncInspector(t);
};
const out = (id, text) => { $(id).textContent = text; };

$('#iZoom').oninput = (e) => { out('#iZoomV', `${(+e.target.value).toFixed(1)}×`); setS({ zoom: +e.target.value }); };
$('#iBias').oninput = (e) => { out('#iBiasV', signed(+e.target.value)); setS({ exposure: +e.target.value }); };
seg($('#iRes'), RES, (v) => setS({ res: +v }));
seg($('#iFps'), FPS, (v) => setS({ fps: +v }));
seg($('#iCodec'), CODEC, (v) => setS({ codec: v }));
for (const [id, k] of [['#iStab', 'stabilization'], ['#iHdr', 'hdr'], ['#iTorch', 'torch'], ['#iMirror', 'mirror']]) $(id).onchange = (e) => setS({ [k]: e.target.checked });
$('#iLock').onchange = (e) => { const t = touch(); if (t) hub.call('lock', t.id, e.target.checked); };

seg($('#iFocusMode'), MODES, (v) => {
  const a = cur()?.status.auto || {};
  if (v === 'manual') { const f = a.focus ?? +$('#iFocus').value; $('#iFocus').value = f; setM({ focus: f }); } else setM({ focus: null });
});
$('#iFocus').oninput = (e) => { out('#iFocusV', fmtFocus(+e.target.value)); setM({ focus: +e.target.value }); };

seg($('#iExpMode'), MODES, (v) => {
  const t = cur();
  if (!t) return;
  if (v !== 'manual') return setM({ iso: null, shutter: null });
  // Start from what auto exposure is doing now, so switching to manual doesn't jump.
  const r = t.status.ranges || {}, a = t.status.auto || {}, fps = t.status.settings?.fps || 30;
  const iso = isoStops(r.iso), sh = shutterStops(r.shutter);
  const i = nearestIdx(iso, a.iso ?? 400, Math.log), j = nearestIdx(sh, a.shutter ?? 1 / (fps * 2), Math.log);
  $('#iIso').value = i; $('#iShutter').value = j;
  setM({ iso: iso[i], shutter: sh[j] });
});
$('#iIso').oninput = (e) => { const v = $('#iIso').stops[+e.target.value]; out('#iIsoV', String(v)); setM({ iso: v }); };
$('#iShutter').oninput = (e) => { const v = $('#iShutter').stops[+e.target.value]; out('#iShutterV', fmtShutter(v)); setM({ shutter: v }); };

seg($('#iWbMode'), MODES, (v) => (v === 'manual' ? setM({ wbTemp: +$('#iWb').value, wbTint: +$('#iTint').value }) : setM({ wbTemp: null })));
$('#iWb').oninput = (e) => { out('#iWbV', `${e.target.value}K`); setM({ wbTemp: +e.target.value }); };
$('#iTint').oninput = (e) => { out('#iTintV', signed(+e.target.value, 0)); setM({ wbTint: +e.target.value }); };

// Close: disconnect now, keep the pairing (the phone waits for a tap). Forget: the phone clears its pairing.
$('#iClose').onclick = async () => {
  const t = cur();
  if (!t) return;
  if (t.status.recording && !(await ask(`${t.name} is recording`, 'Close it anyway? Its recording stops now, the clip is saved on the phone and copies here as soon as it can. The other cameras keep recording.', 'Stop and close'))) return;
  hub.call('close', t.id);
  toast(`${t.name} closed. It reconnects when someone taps it on the phone.`);
};
$('#iForget').onclick = async () => {
  const t = cur();
  if (t && (await ask(`Forget ${t.name}?`, 'The phone goes back to its pairing screen. It can pair again any time by scanning the code.', 'Forget'))) hub.call('forget', t.id);
};

function syncInspector(t, force = false) {
  const st = t.status, s = st.settings || {}, r = st.ranges, a = st.auto || {};
  const fresh = force || Date.now() - t.touched > TOUCH_MS;
  if (fresh) t.mPending = null;
  const m = { ...(st.manual || {}), ...(t.mPending || {}) };
  const ins = $('#insp'), off = !online(t);
  ins.classList.toggle('offline', off);
  ins.classList.toggle('rec', !!st.recording);
  $('#inspBody').disabled = off;
  $('#iClose').disabled = off;
  $('.iname', ins).textContent = t.name;
  $('.isub', ins).textContent = [PLATFORM[t.platform], ...fmtParts(t, false)].filter(Boolean).join(' · ');
  const put = (q, prop, v) => { const c = $(q); if (v != null && (force || (fresh && document.activeElement !== c))) c[prop] = v; };
  const ro = (q, text, cls = '') => { const e = $(q); e.textContent = text; e.className = `ro ${cls}`; };
  const note = (q, text) => { const e = $(q); e.textContent = text || ''; e.hidden = !text; };
  const row = (q, show) => { $(q).closest('.irow').hidden = !show; };

  renderFrameMap(t);

  // Lens + zoom
  const lenses = LENS_ORDER.filter((l) => (st.lenses || ['wide']).includes(l));
  const lensEl = $('#iLens'), lensKey = t.id + lenses.join() + JSON.stringify(st.lensX || {});
  if (lensEl.dataset.k !== lensKey) {
    lensEl.dataset.k = lensKey;
    seg(lensEl, lenses.map((l) => [l, lensName(t, l)]), (v) => setS({ lens: v }));
    force = true;
  }
  if (fresh) segSet(lensEl, s.lens);
  ro('#roLens', LENS_NAME[s.lens] || '');
  put('#iZoom', 'value', s.zoom);
  if (fresh && s.zoom != null) out('#iZoomV', `${(+s.zoom).toFixed(1)}×`);

  // Format + options
  if (fresh) { segSet($('#iRes'), s.res); segSet($('#iFps'), s.fps); segSet($('#iCodec'), s.codec); }
  put('#iStab', 'checked', !!s.stabilization);
  put('#iHdr', 'checked', !!s.hdr);
  put('#iTorch', 'checked', !!s.torch);
  put('#iLock', 'checked', !!st.locked);
  $('#swMirror').hidden = !('mirror' in s); // only phones that can mirror report it
  put('#iMirror', 'checked', !!s.mirror);
  const update = 'Update Tally Cam on this phone for manual controls.';

  // Focus
  const fMan = m.focus != null, fOk = !!r?.focus;
  if (fresh || force) segSet($('#iFocusMode'), fMan ? 'manual' : 'auto');
  $('#iFocusMode [data-v=manual]').disabled = !fOk && !fMan;
  row('#iFocus', fOk || fMan);
  $('#iFocus').disabled = !fMan;
  const fVal = fMan ? m.focus : a.focus;
  if (fMan) put('#iFocus', 'value', fVal); else if (fVal != null) $('#iFocus').value = fVal;
  if (!fMan || fresh) out('#iFocusV', fmtFocus(fVal));
  if (fMan) ro('#roFocus', 'MANUAL', 'man');
  else if (a.focus != null) ro('#roFocus', `AF · ${fmtFocus(a.focus)}`, 'live');
  else ro('#roFocus', 'AUTO');
  note('#nFocus', !r ? update : !fOk ? 'This lens has no manual focus. Tap the tile to focus.' : '');

  // Exposure
  const eMan = m.iso != null || m.shutter != null, eOk = !!(r?.iso && r?.shutter);
  if (fresh || force) segSet($('#iExpMode'), eMan ? 'manual' : 'auto');
  $('#iExpMode [data-v=manual]').disabled = !eOk && !eMan;
  $('#rowBias').hidden = eMan;
  put('#iBias', 'value', s.exposure);
  if (fresh && s.exposure != null) out('#iBiasV', signed(+s.exposure));
  $('#rowIso').hidden = $('#rowShutter').hidden = !eOk;
  if (eOk) {
    const iso = isoStops(r.iso), sh = shutterStops(r.shutter), isoEl = $('#iIso'), shEl = $('#iShutter');
    isoEl.stops = iso; isoEl.max = iso.length - 1; isoEl.disabled = !eMan;
    shEl.stops = sh; shEl.max = sh.length - 1; shEl.disabled = !eMan;
    const isoV = eMan ? m.iso ?? a.iso : a.iso, shV = eMan ? m.shutter ?? a.shutter : a.shutter;
    if (isoV != null && (!eMan || fresh) && document.activeElement !== isoEl) isoEl.value = nearestIdx(iso, isoV, Math.log);
    if (shV != null && (!eMan || fresh) && document.activeElement !== shEl) shEl.value = nearestIdx(sh, shV, Math.log);
    if (!eMan || fresh) { out('#iIsoV', isoV != null ? String(Math.round(isoV)) : '–'); out('#iShutterV', fmtShutter(shV)); }
  }
  const expText = (iso, sh) => [iso != null && `ISO ${Math.round(iso)}`, sh && fmtShutter(sh)].filter(Boolean).join(' · ');
  if (eMan) ro('#roExp', `MANUAL · ${expText(m.iso ?? a.iso, m.shutter ?? a.shutter)}`.replace(/ · $/, ''), 'man');
  else if (a.iso != null || a.shutter) ro('#roExp', `AE · ${expText(a.iso, a.shutter)}`, 'live');
  else ro('#roExp', 'AUTO');
  const fps = s.fps || 30;
  note('#nExp', !r ? '' // said once, under Focus
    : !eOk ? 'Manual ISO and shutter aren’t available on this lens. Use Bias and Lock to keep cameras matched.'
      : eMan ? `1/${fps * 2} is the natural 180° shutter at ${fps} fps.` : '');

  // White balance (the phone can't report its auto Kelvin, only whether it is auto)
  const wMan = m.wbTemp != null, wOk = !!r?.wbTemp;
  if (fresh || force) segSet($('#iWbMode'), wMan ? 'manual' : 'auto');
  $('#iWbMode [data-v=manual]').disabled = !wOk && !wMan;
  $('#rowWb').hidden = $('#rowTint').hidden = !wMan;
  if (r?.wbTemp) { $('#iWb').min = r.wbTemp[0]; $('#iWb').max = r.wbTemp[1]; }
  if (r?.wbTint) { $('#iTint').min = r.wbTint[0]; $('#iTint').max = r.wbTint[1]; }
  put('#iWb', 'value', m.wbTemp);
  put('#iTint', 'value', m.wbTint ?? 0);
  if (fresh) { out('#iWbV', `${$('#iWb').value}K`); out('#iTintV', signed(+$('#iTint').value, 0)); }
  if (wMan) ro('#roWb', `MANUAL · ${m.wbTemp}K${m.wbTint ? ` · ${signed(m.wbTint, 0)}` : ''}`, 'man');
  else ro('#roWb', 'AWB', a.iso != null ? 'live' : '');
  note('#nWb', !r ? '' : !wOk ? 'This lens has no manual white balance.' : !wMan ? 'Set the same Kelvin on every camera so skin tones match between angles.' : '');

  renderLiveQ();
}

// Live quality is global: it sets the bitrate of every camera's live feed to OBS.
function renderLiveQ() {
  const el = $('#iLiveQ');
  if (!el.childElementCount) {
    seg(el, QUALITY, async (q) => {
      liveQ = await hub.call('liveQuality', q);
      renderLiveQ();
      const kb = liveKbps[live]?.[liveQ];
      toast(`Live quality: ${QUALITY.find(([k]) => k === liveQ)[1]}${kb ? ` (${kb / 1000} Mb/s at ${liveLabel(live)})` : ''} on every camera`);
    });
  }
  segSet(el, liveQ);
  for (const b of $$('button', el)) { const kb = liveKbps[live]?.[b.dataset.v] ?? liveKbps[1080]?.[b.dataset.v]; b.title = kb ? `${kb / 1000} Mb/s` : ''; }
  const kb = liveKbps[live]?.[liveQ];
  $('#roLive').textContent = live !== 'off' && kb ? `${liveLabel(live)} · ${kb / 1000} Mb/s` : 'LIVE OFF';
  $('#nLive').textContent = live === 'off'
    ? 'Sets the bitrate of every camera’s live feed to OBS. Turn Live on in the toolbar.'
    : 'Applies to every camera’s live feed. Higher needs strong Wi-Fi; a hot phone steps down on its own.';
}

// ---------- framing: per-camera digital pan + zoom of the live view (tiles + OBS); recordings stay full frame ----------
// Same rules as the hub's clampFraming(): zoom 1–3, centre kept inside the frame, 9:16 guide kept inside the picture.
const PORTRAIT_W = (9 / 16) / (16 / 9);
const framing = {}; // id -> { zoom, x, y, portraitX }
let portrait = false;
const clampF = (f) => {
  const zoom = Math.min(3, Math.max(1, +f.zoom || 1)), h = 0.5 / zoom, pw = PORTRAIT_W / 2;
  const c = (v, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(+v) ? +v : 0.5));
  return { zoom, x: c(f.x, h, 1 - h), y: c(f.y, h, 1 - h), portraitX: c(f.portraitX, pw, 1 - pw) };
};
const frameOf = (id) => framing[id] || clampF({});
const frameCss = (f) => (f.zoom === 1 ? 'none' : `scale(${f.zoom}) translate(${(0.5 - f.x) * 100}%, ${(0.5 - f.y) * 100}%)`);
function applyFrame(t) {
  const f = frameOf(t.id);
  $('.view', t.el).style.setProperty('--frame', frameCss(f));
  $('.view .pg', t.el).style.setProperty('--l', `${(f.portraitX - PORTRAIT_W / 2) * 100}%`);
  if (t.id === sel) renderFrameMap(t);
}
function renderFrameMap(t) {
  const f = frameOf(t.id), r = $('#mrect');
  const L = (f.x - 0.5 / f.zoom) * 100, T = (f.y - 0.5 / f.zoom) * 100, W = 100 / f.zoom;
  Object.assign(r.style, { left: `${L}%`, top: `${T}%`, width: `${W}%`, height: `${W}%` });
  r.classList.toggle('full', f.zoom === 1);
  // Dim everything outside the crop: the whole map minus the crop rectangle (even-odd hole).
  $('#mdim').style.clipPath = f.zoom === 1 ? 'inset(50%)'
    : `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${L}% ${T}%, ${L + W}% ${T}%, ${L + W}% ${T + W}%, ${L}% ${T + W}%, ${L}% ${T}%)`;
  $('#mpg').style.setProperty('--l', `${(f.portraitX - PORTRAIT_W / 2) * 100}%`);
  if (document.activeElement !== $('#iFZoom')) $('#iFZoom').value = Math.round(f.zoom * 100);
  out('#iFZoomV', `${Math.round(f.zoom * 100)}%`);
  $('#roFrame').textContent = f.zoom === 1 ? 'FULL FRAME' : `${Math.round(f.zoom * 100)}% · ${Math.round(f.x * 100)},${Math.round(f.y * 100)}`;
}
// Local first (instant), then the hub (persisted, pushed to the OBS page); one IPC per animation frame while dragging.
const frameQueue = new Map();
function setFrame(id, patch) {
  const t = tiles.get(id);
  if (!t) return;
  framing[id] = clampF({ ...frameOf(id), ...patch });
  applyFrame(t);
  if (!frameQueue.size) requestAnimationFrame(() => { for (const [fid, f] of frameQueue) hub.call('framing', fid, f); frameQueue.clear(); });
  frameQueue.set(id, framing[id]);
}
$('#iFZoom').oninput = (e) => sel && setFrame(sel, { zoom: +e.target.value / 100 });
$('#iFrameReset').onclick = () => sel && setFrame(sel, { zoom: 1, x: 0.5, y: 0.5, portraitX: 0.5 });
$('#iPortrait').onchange = async (e) => { portrait = await hub.call('portraitGuide', e.target.checked); document.body.classList.toggle('portrait', portrait); };
// Minimap: drag the box to pan (or press outside it to centre it there), drag the 9:16 guide sideways, scroll to zoom.
$('#mmap').onpointerdown = (e) => {
  if (!sel || e.button !== 0) return;
  const map = $('#mmap'), box = map.getBoundingClientRect(), id = sel, f0 = frameOf(id);
  const rr = $('#mrect').getBoundingClientRect(), px = (e.clientX - rr.left) / rr.width;
  const guide = portrait && $('#mrect').contains(e.target) && Math.abs(px - f0.portraitX) <= PORTRAIT_W / 2; // inside the 9:16 box
  let base = f0;
  if (!guide && !$('#mrect').contains(e.target)) {
    setFrame(id, { x: (e.clientX - box.left) / box.width, y: (e.clientY - box.top) / box.height });
    base = frameOf(id);
  }
  try { map.setPointerCapture(e.pointerId); } catch {}
  map.classList.add('drag');
  const move = (ev) => {
    const dx = (ev.clientX - e.clientX) / box.width, dy = (ev.clientY - e.clientY) / box.height;
    if (guide) setFrame(id, { portraitX: base.portraitX + dx * base.zoom });
    else setFrame(id, { x: base.x + dx, y: base.y + dy });
  };
  const up = () => { map.classList.remove('drag'); map.removeEventListener('pointermove', move); map.removeEventListener('pointerup', up); map.removeEventListener('pointercancel', up); };
  map.addEventListener('pointermove', move);
  map.addEventListener('pointerup', up);
  map.addEventListener('pointercancel', up);
};
$('#mmap').addEventListener('wheel', (e) => {
  if (!sel) return;
  e.preventDefault();
  setFrame(sel, { zoom: frameOf(sel).zoom * Math.exp(-e.deltaY * 0.002) });
}, { passive: false });
function initFraming(c) {
  Object.assign(framing, Object.fromEntries(Object.entries(c.framing || {}).map(([id, f]) => [id, clampF(f)])));
  portrait = !!c.portraitGuide;
  $('#iPortrait').checked = portrait;
  document.body.classList.toggle('portrait', portrait);
  for (const t of tiles.values()) applyFrame(t);
}

hub.on('phones', (list) => {
  const ids = new Set(list.map((p) => p.id));
  for (const [id, t] of tiles) if (!ids.has(id)) dropTile(id, t);
  for (const p of list) {
    const isNew = !tiles.has(p.id);
    const t = tile(p.id);
    const wasOnline = !isNew && online(t);
    if (isNew && p.online) log(`${p.name} connected`);
    else if (!isNew && wasOnline !== p.online) log(p.online ? `${p.name} reconnected` : `${p.name} went offline`, p.online ? '' : 'w');
    t.name = p.name;
    t.platform = p.platform;
    $('.name', t.el).textContent = p.name;
    t.el.classList.toggle('offline', !p.online);
    t.status = { ...t.status, ...p.status };
    if (!p.online) { rtcStop(t); t.live = null; }
    else if (!wasOnline) { t.onlineAt = 0; updatePreviewRate(t, true); }
    renderStatus(t);
  }
  document.body.classList.toggle('empty', !list.length);
  const on = list.filter((p) => p.online).length;
  if (on) { everConnected = true; $('#tips').hidden = true; }
  $('#count span:last-child').textContent = list.length ? `${on} of ${list.length} camera${list.length === 1 ? '' : 's'} online` : 'No cameras';
  $('#count').classList.toggle('ok', on > 0 && on === list.length);
  $('#count').classList.toggle('warn', on < list.length);
});
hub.on('status', ({ id, status }) => { const t = tiles.get(id); if (t) { t.status = status; renderStatus(t); } });
hub.on('frame', ({ id, jpg }) => {
  const t = tiles.get(id);
  if (!t) return;
  if (t.url) URL.revokeObjectURL(t.url);
  t.url = URL.createObjectURL(new Blob([jpg], { type: 'image/jpeg' }));
  t.gotFrame = true;
  $('img', t.el).src = t.url;
  if (id === sel) $('#mmap img').src = t.url;
});
hub.on('upload', ({ id, got, expected, done, error }) => {
  const t = tiles.get(id);
  if (!t) return;
  const up = $('.up', t.el), bar = $('.prog b', t.el);
  if (error) {
    toast(`Copy from ${t.name} failed: ${error}. The clip is safe on the phone and will retry.`, 'e');
    up.textContent = 'Copy failed'; up.className = 'up warn'; bar.style.width = '0';
  } else if (done) {
    toast(`${t.name}: clip saved`);
    up.textContent = '✓ Copied'; up.className = 'up good'; bar.style.width = '0';
  } else if (expected) {
    const pct = Math.round((got / expected) * 100);
    up.textContent = `Copying ${pct}%`; up.className = 'up'; bar.style.width = `${pct}%`;
  }
});
hub.on('obs', ({ ok, msg }) => {
  $('#obsChip span:last-child').textContent = ok ? 'OBS connected' : 'OBS not connected';
  $('#obsChip').classList.toggle('ok', ok);
  $('#obsChip').title = msg;
  $('#obsState').classList.toggle('ok', ok);
  $('#obsState span:last-child').textContent = ok ? 'Connected' : `Not connected: ${msg}`;
});
hub.on('log', (m) => log(m, /fail|error|could not/i.test(m) ? 'e' : '', false));
hub.on('state', (s) => setRecording(s.recording, s.startedAt, s.session));

// ---------- live feeds ----------
let live = 'off', mains = 60, liveQ = 'standard', liveKbps = {};
const liveLabel = (k) => ({ off: 'Off', 720: `720p${mains / 2}`, 1080: `1080p${mains / 2}`, '1080hfr': `1080p${mains}` })[k];
function renderLiveSeg() {
  seg($('#liveSeg'), ['off', '720', '1080', '1080hfr'].map((k) => [k, liveLabel(k)]), async (k) => {
    live = await hub.call('live', k);
    toast(live === 'off' ? 'Live feeds to OBS off' : `Live feeds on: ${liveLabel(live)}`);
    for (const t of tiles.values()) renderLive(t);
  });
  segSet($('#liveSeg'), live);
  renderLiveQ();
  seg($('#mainsSeg'), [[60, '60 Hz · Americas'], [50, '50 Hz · Europe, Africa, Asia']], async (hz) => { mains = await hub.call('mains', hz); renderLiveSeg(); });
  segSet($('#mainsSeg'), mains);
}
function renderLive(t) {
  const pill = $('.pill.live', t.el), hubSide = t.live || {}, ph = t.status.stream || {};
  const role = hubSide.role || (live !== 'off' ? 'live' : 'off');
  pill.hidden = role === 'off' || !online(t);
  if (pill.hidden) return;
  const tag = role === 'live' ? 'LIVE' : 'MON';
  let cls = 'none', text = `NO ${role === 'live' ? 'FEED' : 'MONITOR'}`, k = '';
  if (hubSide.ready) {
    cls = role === 'live' ? 'on' : 'mon'; text = tag;
    // Short side: 1080p whether the phone is landscape or portrait.
    k = [ph.width && `${Math.min(ph.width, ph.height)}p${ph.fps || ''}`, hubSide.kbps && `${(hubSide.kbps / 1000).toFixed(1)} Mb/s`, hubSide.readers && 'OBS'].filter(Boolean).join(' · ');
  } else if (ph.state === 'error') { cls = 'err'; text = 'FEED ERROR'; }
  else if (ph.state === 'connecting' || ph.state === 'live') { cls = 'wait'; text = 'CONNECTING'; }
  else if (t.status.thermal?.level >= 3) { cls = 'err'; text = 'PAUSED · TOO HOT'; } // the phone refuses live at critical
  pill.className = `pill live ${cls}`;
  pill.title = ph.error || (hubSide.ready
    ? `${t.rtcPlaying ? 'Playing in this tile. ' : t.rtcWhy ? `Tile video: ${t.rtcWhy}. ` : ''}${hubSide.readers ? `Read by ${hubSide.readers} OBS source(s).` : role === 'live' ? 'Not in OBS yet (Add to OBS).' : 'Monitor feed for this tile.'}`
    : t.status.thermal?.level >= 3 ? 'The phone is critically hot, so it paused its live feed to protect the recording. Unplug it from charging, give it shade and airflow; the feed resumes when it cools.'
    : 'This phone is not sending a feed yet');
  pill.replaceChildren(text);
  if (k) { const s = document.createElement('span'); s.className = 'k'; s.textContent = k; pill.append(s); }
}
hub.on('live', (d) => {
  const t = tiles.get(d.id);
  if (!t) return;
  const was = t.live?.ready;
  t.live = d;
  renderLive(t);
  if (d.ready && !was) { t.rtcFails = 0; rtcStart(t); }
  if (!d.ready && t.rtc) rtcStop(t, true);
});
hub.on('liveCfg', (c) => { live = c.live; mains = c.mains; liveQ = c.liveQuality || liveQ; liveKbps = c.liveKbps || liveKbps; applySmooth(c); renderLiveSeg(); for (const t of tiles.values()) renderLive(t); });
function applySmooth(c) { $('#smoothIos').checked = !!c.smooth; $('#smoothAndroid').checked = !!c.smoothAndroid; }
$('#smoothIos').onchange = (e) => hub.call('smooth', { smooth: e.target.checked });
$('#smoothAndroid').onchange = (e) => hub.call('smooth', { smoothAndroid: e.target.checked });

// ---------- "no preview" state: tell the operator why instead of an endless black box ----------
hub.on('phoneError', ({ id, message }) => {
  const t = tiles.get(id);
  if (!t) return;
  if (/preview|snapshot|frame/i.test(message)) t.previewWhy = message;
  else if (Date.now() - t.touched < 5000) toast(`${t.name}: ${message}`, 'w'); // the answer to a control just used
});
setInterval(() => {
  const now = Date.now();
  for (const t of tiles.values()) {
    if (!online(t)) { t.onlineAt = 0; continue; }
    t.onlineAt ||= now;
    const unavailable = t.status.preview === 'unavailable' && !t.rtcPlaying;
    const late = !t.gotFrame && now - t.onlineAt > 5000;
    t.el.classList.toggle('nopv', unavailable);
    $('.wait b', t.el).textContent = unavailable || late ? 'No preview from this camera yet' : 'Waiting for preview…';
    $('.wait small', t.el).textContent = unavailable || late
      ? t.previewWhy || (unavailable ? 'The phone reports its preview is unavailable. Recording is not affected.' : 'Recording is not affected. Check that Tally Cam is open on the phone.')
      : '';
  }
}, 1000);
const saveObs = () => hub.call('obs', { enabled: $('#obsOn').checked, url: $('#obsUrl').value, password: $('#obsPw').value });
async function addToObs() {
  if ($('#obsDlg').open) await saveObs(); // use what's typed in the dialog, saved or not
  const r = await hub.call('obsAddCameras');
  if (r.ok) toast(`OBS: ${r.n} camera${r.n === 1 ? '' : 's'} added to “Tally Cameras”, plus a scene for each`);
  else toast(`OBS: ${r.error}`, 'w');
}
$('#obsAdd').onclick = $('#obsAdd2').onclick = addToObs;

// ---------- audio meters ----------
const frac = (db) => Math.min(1, Math.max(0, (db + 60) / 60)); // -60..0 dBFS -> 0..1
hub.on('level', ({ id, db }) => {
  const t = tiles.get(id);
  if (!t || !Number.isFinite(db)) return;
  const now = performance.now();
  t.lastLevel = now;
  if (db >= t.peak) { t.peak = db; t.peakAt = now; }
  if (db >= -1) t.clipUntil = now + 2000;
  $('.mbar .cover', t.el).style.transform = `scaleX(${1 - frac(db)})`;
  $('.db', t.el).textContent = `${db <= -60 ? '-∞' : db.toFixed(1)} dB`;
  t.el.querySelector('.meter').classList.remove('silent');
});
// Peak hold for 1 s then decay at 20 dB/s; CLIP latches 2 s; "no audio" after 2 s of silence on the wire.
setInterval(() => {
  const now = performance.now();
  for (const t of tiles.values()) {
    if (now - t.peakAt > 1000) t.peak = Math.max(-60, t.peak - 2);
    $('.mbar .pk', t.el).style.transform = `translateX(${frac(t.peak) * 100}%)`;
    $('.clip', t.el).classList.toggle('on', now < t.clipUntil);
    if (now - t.lastLevel > 2000) {
      const m = t.el.querySelector('.meter');
      if (!m.classList.contains('silent')) {
        m.classList.add('silent');
        $('.db', t.el).textContent = 'no audio';
        $('.mbar .cover', t.el).style.transform = 'scaleX(1)';
      }
    }
  }
}, 100);

// ---------- record ----------
function preflight() {
  const issues = [];
  for (const t of tiles.values()) {
    const s = t.status, r = s.settings?.res || 1080;
    if (!online(t)) { issues.push(`${t.name} is offline`); continue; }
    if (s.battery < 0.2 && !s.charging) issues.push(`${t.name} battery is at ${Math.round(s.battery * 100)}%`);
    if (s.remainingSec != null ? s.remainingSec < 3600 : s.free < (GB_PER_HOUR[r] || 10) * 1e9)
      issues.push(`${t.name} has ${s.remainingSec != null ? dur(s.remainingSec) : gb(s.free)} of recording space left`);
    if (s.thermal?.level >= 2) issues.push(`${t.name} is running ${THERMAL[Math.min(3, s.thermal.level)][1].toLowerCase()}`);
  }
  return issues;
}

// Short 1 kHz beep at the shared start moment: a clean spike for the editor's "sync by audio".
function beepAt(ms) {
  setTimeout(() => {
    const ctx = new AudioContext(), o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = 1000; g.gain.value = 0.3;
    o.connect(g).connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + 0.15);
    o.onended = () => ctx.close();
  }, Math.max(0, ms - Date.now()));
}

function setRecording(on, at, session) {
  if (on && !recording) { beepAt(at); log(`Recording “${session}”`); }
  if (!on && recording) log('Stopped. Clips are copying to this computer…');
  recording = on; startedAt = at;
  document.body.classList.toggle('recording', on);
  $('#rec .txt').textContent = on ? 'STOP' : 'REC';
  $('#session').disabled = on;
}

let busy = false;
async function toggleRecord() {
  if (busy) return;
  if (recording) return hub.call('stop');
  busy = true;
  try {
    if (!tiles.size && !(await ask('No cameras paired', 'Record with OBS only?', 'Record'))) return;
    const issues = preflight();
    if (issues.length && !(await ask('Before you record', issues, 'Record anyway'))) return;
    await hub.call('record', $('#session').value);
  } finally { busy = false; }
}
$('#rec').onclick = toggleRecord;
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat) return;
  if ($('dialog[open]') || ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(document.activeElement?.tagName)) return;
  e.preventDefault();
  toggleRecord();
});

setInterval(() => {
  const ms = recording ? Math.max(0, Date.now() - startedAt) : 0;
  $('#timer').textContent = new Date(ms).toISOString().slice(11, 19);
}, 200);

// ---------- toolbar ----------
seg($('#allRes'), RES, () => {}); segSet($('#allRes'), 1080);
seg($('#allFps'), FPS, () => {}); segSet($('#allFps'), 30);
seg($('#allCodec'), CODEC, () => {}); segSet($('#allCodec'), 'hevc');
$('#session').oninput = (e) => hub.call('session', e.target.value); // name used when a phone starts the take
$('#matchBtn').onclick = () => {
  hub.call('settings', null, {
    res: +segGet($('#allRes')), fps: +segGet($('#allFps')), codec: segGet($('#allCodec')),
    stabilization: $('#allStab').checked, hdr: $('#allHdr').checked,
  });
  toast(`Sent ${RES_LABEL[segGet($('#allRes'))]} · ${segGet($('#allFps'))}p to every camera`);
};
$('#lockAll').onclick = () => { tiles.forEach((t) => (t.touched = Date.now())); hub.call('lock', null, true); $('#iLock').checked = true; toast('Focus, exposure and white balance locked'); };
$('#unlockAll').onclick = () => { tiles.forEach((t) => (t.touched = Date.now())); hub.call('lock', null, false); $('#iLock').checked = false; toast('Cameras back on auto'); };
$('#folderBtn').onclick = $('#folderBtn2').onclick = () => hub.call('openFolder');
$('#logBtn2').onclick = () => hub.call('openLog');
$('#settingsBtn').onclick = () => $('#settingsDlg').showModal();

// ---------- firewall (macOS); Windows shows its own Defender prompt on first launch ----------
let fwNoted = false, fwStuck = '';
async function checkFirewall() {
  const fw = await hub.call('firewall');
  if (fw.dev && !fwNoted) { fwNoted = true; log('Development build: macOS Firewall check skipped (only the installed app is checked).'); }
  const blocked = !fw.ok;
  $('#fwBanner').hidden = !blocked;
  $('#pairFw').hidden = !blocked;
  $('#fwMsg').textContent = fw.blockAll ? 'It is set to block all incoming connections. Turn that off in System Settings.' : "Tally Hub isn't allowed to accept incoming connections.";
  for (const b of [$('#fwFix'), $('#pairFwFix')]) { b.textContent = fw.blockAll ? 'Open Firewall settings' : 'Allow Tally Hub'; b.hidden = !!fwStuck && !fw.blockAll; }
  if (fwStuck && !fw.blockAll) $('#fwMsg').textContent = fwStuck;
  return fw;
}
async function fixFirewall() {
  const fw = await hub.call('firewall');
  if (fw.blockAll) return hub.call('firewallSettings');
  const r = await hub.call('firewallFix'); // macOS shows its own administrator password prompt
  await checkFirewall();
  if (r.ok) { fwStuck = ''; toast('Firewall now allows Tally Hub. Cameras can connect.'); }
  else if (r.adhoc?.length) {
    // Don't loop on the password prompt: macOS ignores rules for ad-hoc signed code.
    fwStuck = `macOS won't keep the rule because ${r.adhoc.join(' and ')} ${r.adhoc.length > 1 ? 'are' : 'is'} ad-hoc signed. Tally Hub must be signed: see README → Packaging.`;
    await checkFirewall();
    toast(fwStuck, 'e');
  } else if (!r.cancelled) {
    const still = (r.blocked || []).map((p) => p.split('/').pop()).join(' and ') || 'Tally Hub';
    toast(`Could not allow ${still}. Add it in System Settings → Network → Firewall → Options.`, 'w');
  }
}
$('#fwFix').onclick = $('#pairFwFix').onclick = fixFirewall;

// ---------- pair dialog ----------
let everConnected = false, tipsTimer = null;
async function openPair() {
  const [p] = await Promise.all([hub.call('pairing'), checkFirewall()]);
  const area = $('#qrArea');
  area.replaceChildren();
  if (!p.nets.length) {
    area.innerHTML = '<div class="nonet">No network found. Connect this computer to Wi-Fi or turn on its hotspot.</div>';
  } else {
    const box = document.createElement('div'), img = document.createElement('img'), list = document.createElement('div');
    box.className = 'qrbox';
    img.src = p.img; img.alt = 'Pairing code';
    box.append(img);
    list.className = 'netlist';
    for (const [k, v] of [...p.nets.map((n) => [n.name, n.ip]), ['Bonjour', p.mdns]]) {
      const span = document.createElement('span'), b = document.createElement('b');
      b.textContent = k; span.append(b, ` · ${v}`);
      list.append(span);
    }
    area.append(box, list);
  }
  $('#mAddr').textContent = p.nets[0] ? `${p.nets[0].ip}:${p.port}` : '–';
  $('#mKey').textContent = p.key;
  $('#tips').hidden = true;
  clearTimeout(tipsTimer);
  tipsTimer = setTimeout(() => { if (!everConnected && $('#pairDlg').open) $('#tips').hidden = false; }, 30000);
  $('#pairDlg').showModal();
}
$('#pairBtn').onclick = $('#emptyPair').onclick = openPair;
$$('[data-copy]').forEach((b) => (b.onclick = () => {
  hub.call('copy', $(`#${b.dataset.copy}`).textContent);
  b.lastChild.textContent = 'Copied';
  setTimeout(() => (b.lastChild.textContent = 'Copy'), 1200);
}));

// ---------- OBS dialog ----------
$('#obsBtn').onclick = () => $('#obsDlg').showModal();
$('#obsDlg').onclose = () => {
  if ($('#obsDlg').returnValue !== 'save') return;
  $('#obsDlg').returnValue = '';
  saveObs();
};

checkFirewall(); // again whenever the pair dialog opens and after "Allow Tally Hub"; never polled (it's a system call)
hub.call('init').then((c) => {
  cfgInfo = c;
  live = c.live || 'off'; mains = c.mains || 60; liveQ = c.liveQuality || 'standard'; liveKbps = c.liveKbps || {};
  applySmooth(c);
  initFraming(c);
  renderLiveSeg();
  $('#obsOn').checked = c.obs.enabled;
  $('#obsUrl').value = c.obs.url;
  $('#obsPw').value = c.obs.password;
  $('#version').textContent = `Tally Hub ${c.version}`;
  $('#outPath').textContent = c.out;
  $('#logPath').textContent = c.logPath;
  if (!c.mediamtx) toast('Live feeds and smooth previews are off: MediaMTX is missing (see README).', 'w');
  if (c.state.recording) setRecording(true, c.state.startedAt, c.state.session);
  if (c.platform === 'win32') {
    document.body.classList.add('win');
    let noted = false;
    try { noted = localStorage.getItem('winFwNoted') === '1'; } catch {}
    if (!noted) {
      toast('Windows Defender Firewall will ask to allow "Tally Hub" and "mediamtx.exe" on first launch: click Allow, including Private networks.', 'w');
      try { localStorage.setItem('winFwNoted', '1'); } catch {}
    }
  }
});
