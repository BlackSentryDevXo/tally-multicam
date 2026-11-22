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
    pc.addTransceiver('video', { direction: 'recvonly' });
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
  const set = (s) => { t.touched = Date.now(); hub.call('settings', id, s); };
  $('.zoom', el).oninput = (e) => { $('.zoomv', el).textContent = `${(+e.target.value).toFixed(1)}×`; set({ zoom: +e.target.value }); };
  $('.exposure', el).oninput = (e) => { $('.expv', el).textContent = (+e.target.value).toFixed(1); set({ exposure: +e.target.value }); };
  seg($('.res', el), RES, (v) => set({ res: +v }));
  seg($('.fps', el), FPS, (v) => set({ fps: +v }));
  seg($('.codec', el), CODEC, (v) => set({ codec: v }));
  for (const k of ['stabilization', 'hdr', 'torch']) $(`.${k}`, el).onchange = (e) => set({ [k]: e.target.checked });
  $('.lock', el).onchange = (e) => hub.call('lock', id, e.target.checked);
  // Close: disconnect now, keep the pairing (the phone waits for a tap). Forget: the phone clears its pairing.
  $('.close', el).onclick = async () => {
    if (t.status.recording && !(await ask(`${t.name} is recording`, 'Close it anyway? Its recording stops now, the clip is saved on the phone and copies here as soon as it can. The other cameras keep recording.', 'Stop and close'))) return;
    hub.call('close', id);
    toast(`${t.name} closed. It reconnects when someone taps it on the phone.`);
  };
  $('.forget', el).onclick = async () => {
    if (await ask(`Forget ${t.name}?`, 'The phone goes back to its pairing screen. It can pair again any time by scanning the code.', 'Forget')) hub.call('forget', id);
  };
  $('.view', el).onclick = (e) => {
    if (!online(t)) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    hub.call('focus', id, x, y);
    const f = $('.focus', el);
    Object.assign(f.style, { left: `${x * 100}%`, top: `${y * 100}%` });
    f.classList.add('show');
    requestAnimationFrame(() => requestAnimationFrame(() => f.classList.remove('show')));
  };
  $('#grid').append(el);
  tiles.set(id, t);
  io.observe(el);
  return t;
}
function dropTile(id, t) {
  io.unobserve(t.el);
  rtcStop(t);
  clearTimeout(t.rtcTimer);
  t.rtcTimer = null;
  if (t.url) URL.revokeObjectURL(t.url);
  t.el.remove();
  tiles.delete(id);
}

// Reflect the phone's real settings, except right after the operator touched a control (avoids slider fights).
function syncControls(t) {
  const s = t.status.settings, el = t.el;
  if (!s) return;
  const fresh = Date.now() - t.touched > 1500;
  const put = (sel, prop, v) => { const c = $(sel, el); if (c && v != null && document.activeElement !== c && fresh) c[prop] = v; };
  put('.zoom', 'value', s.zoom);
  put('.exposure', 'value', s.exposure);
  if (fresh) {
    if (s.zoom != null) $('.zoomv', el).textContent = `${(+s.zoom).toFixed(1)}×`;
    if (s.exposure != null) $('.expv', el).textContent = (+s.exposure).toFixed(1);
    segSet($('.res', el), s.res); segSet($('.fps', el), s.fps); segSet($('.codec', el), s.codec);
  }
  put('.stabilization', 'checked', !!s.stabilization);
  put('.hdr', 'checked', !!s.hdr);
  put('.torch', 'checked', !!s.torch);

  const lenses = LENS_ORDER.filter((l) => (t.status.lenses || ['wide']).includes(l));
  const lensEl = $('.lens', el);
  if (lensEl.dataset.k !== lenses.join()) {
    lensEl.dataset.k = lenses.join();
    seg(lensEl, lenses.map((l) => [l, LENS_LABEL[l]]), (v) => { t.touched = Date.now(); hub.call('settings', t.id, { lens: v }); });
  }
  if (fresh) segSet(lensEl, s.lens);

  const parts = [LENS_LABEL[s.lens], RES_LABEL[s.res] || s.res, s.fps && `${s.fps}p`, s.codec && (s.codec === 'hevc' ? 'HEVC' : 'H.264')];
  if (s.hdr) parts.push('HDR');
  const fmt = $('.fmt', el);
  fmt.textContent = parts.filter(Boolean).join(' · ');
  fmt.hidden = !fmt.textContent;
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
    chip(el, '.therm', th.tempC != null ? `${label} · ${Math.round(th.tempC)}°C` : label, cls);
  } else chip(el, '.therm', th?.tempC != null ? `${Math.round(th.tempC)}°C` : null);
  const lvl = th?.level || 0;
  if (lvl > t.thermLogged) toast(`${t.name} is ${THERMAL[Math.min(3, lvl)][1].toLowerCase()}${th.tempC != null ? ` (${Math.round(th.tempC)}°C)` : ''}. Shade it or give it a break.`, lvl >= 2 ? 'e' : 'w');
  t.thermLogged = lvl; // escalations only: falling back resets, so a new rise warns again
  syncControls(t);
  renderLive(t);
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
  $('#obsChip span:last-child').textContent = ok ? 'OBS connected' : msg === 'off' ? 'OBS off' : 'OBS not connected';
  $('#obsChip').classList.toggle('ok', ok);
  $('#obsChip').title = msg;
  $('#obsState').classList.toggle('ok', ok);
  $('#obsState span:last-child').textContent = ok ? 'Connected' : msg === 'off' ? 'Off' : `Not connected: ${msg}`;
});
hub.on('log', (m) => log(m, /fail|error|could not/i.test(m) ? 'e' : '', false));
hub.on('state', (s) => setRecording(s.recording, s.startedAt, s.session));

// ---------- live feeds ----------
let live = 'off', mains = 60;
const liveLabel = (k) => ({ off: 'Off', 720: `720p${mains / 2}`, 1080: `1080p${mains / 2}`, '1080hfr': `1080p${mains}` })[k];
function renderLiveSeg() {
  seg($('#liveSeg'), ['off', '720', '1080', '1080hfr'].map((k) => [k, liveLabel(k)]), async (k) => {
    live = await hub.call('live', k);
    toast(live === 'off' ? 'Live feeds to OBS off' : `Live feeds on: ${liveLabel(live)}`);
    for (const t of tiles.values()) renderLive(t);
  });
  segSet($('#liveSeg'), live);
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
    k = [ph.width && `${ph.height}p${ph.fps || ''}`, hubSide.kbps && `${(hubSide.kbps / 1000).toFixed(1)} Mb/s`, hubSide.readers && 'OBS'].filter(Boolean).join(' · ');
  } else if (ph.state === 'error') { cls = 'err'; text = 'FEED ERROR'; }
  else if (ph.state === 'connecting' || ph.state === 'live') { cls = 'wait'; text = 'CONNECTING'; }
  pill.className = `pill live ${cls}`;
  pill.title = ph.error || (hubSide.ready
    ? `${t.rtcPlaying ? 'Playing in this tile. ' : t.rtcWhy ? `Tile video: ${t.rtcWhy}. ` : ''}${hubSide.readers ? `Read by ${hubSide.readers} OBS source(s).` : role === 'live' ? 'Not in OBS yet (Add to OBS).' : 'Monitor feed for this tile.'}`
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
hub.on('liveCfg', (c) => { live = c.live; mains = c.mains; applySmooth(c); renderLiveSeg(); for (const t of tiles.values()) renderLive(t); });
function applySmooth(c) { $('#smoothIos').checked = !!c.smooth; $('#smoothAndroid').checked = !!c.smoothAndroid; }
$('#smoothIos').onchange = (e) => hub.call('smooth', { smooth: e.target.checked });
$('#smoothAndroid').onchange = (e) => hub.call('smooth', { smoothAndroid: e.target.checked });

// ---------- "no preview" state: tell the operator why instead of an endless black box ----------
hub.on('phoneError', ({ id, message }) => { const t = tiles.get(id); if (t && /preview|snapshot|frame/i.test(message)) t.previewWhy = message; });
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
async function addToObs() {
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
  if ($('dialog[open]') || ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'SUMMARY'].includes(document.activeElement?.tagName)) return;
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
$('#lockAll').onclick = () => { hub.call('lock', null, true); $$('.lock').forEach((c) => (c.checked = true)); toast('Focus, exposure and white balance locked'); };
$('#unlockAll').onclick = () => { hub.call('lock', null, false); $$('.lock').forEach((c) => (c.checked = false)); toast('Cameras back on auto'); };
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
  } else if (!r.cancelled) toast('Could not change the firewall. Allow Tally Hub in System Settings → Network → Firewall.', 'w');
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
  hub.call('obs', { enabled: $('#obsOn').checked, url: $('#obsUrl').value, password: $('#obsPw').value });
};

checkFirewall(); // again whenever the pair dialog opens and after "Allow Tally Hub"; never polled (it's a system call)
hub.call('init').then((c) => {
  cfgInfo = c;
  live = c.live || 'off'; mains = c.mains || 60;
  applySmooth(c);
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
