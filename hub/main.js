const { app, BrowserWindow, ipcMain, shell, dialog, clipboard, powerSaveBlocker } = require('electron');
const http = require('node:http');
const { execFileSync, execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const execFileP = promisify(execFile);
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const { OBSWebSocket } = require('obs-websocket-js');

const VERSION = app.getVersion();
const MAC = process.platform === 'darwin', WIN = process.platform === 'win32';
const PORT = +process.env.TALLY_PORT || 7777;
// A dev copy never shares settings or the single-instance lock with the installed app.
if (!app.isPackaged) app.setPath('userData', process.env.TALLY_USER_DATA || path.join(app.getPath('appData'), 'Tally Hub Dev'));
const START_DELAY_MS = 1500; // time for every phone to receive the command before the shared start moment
const OUT_ROOT = MAC ? path.join(os.homedir(), 'Movies', 'Tally') : path.join(app.getPath('videos') || path.join(os.homedir(), 'Videos'), 'Tally');
// MediaMTX ports: phones publish SRT here; OBS reads SRT and the hub's tiles read WebRTC, both on localhost only.
const SRT_PORT = +process.env.TALLY_SRT_PORT || 8890;
const MTX_API = +process.env.TALLY_MTX_API || 9997;
const WEBRTC_PORT = +process.env.TALLY_WEBRTC_PORT || 8889;
const ICE_PORT = +process.env.TALLY_ICE_PORT || 8189;
// Dev/test runs can stay on loopback so they never trigger the OS firewall prompt (packaged builds ignore this).
const LISTEN_HOST = (!app.isPackaged && process.env.TALLY_LISTEN_HOST) || undefined;
// Files shipped next to the app: hub/ in dev, Contents/Resources/ (mac) or resources/ (win) when packaged.
const resource = (...p) => (app.isPackaged ? path.join(process.resourcesPath, ...p) : path.join(__dirname, ...p));
const MTX_PLATFORM = `${WIN ? 'windows' : process.platform}_${process.arch === 'arm64' ? 'arm64' : 'amd64'}`;
const MTX_BIN = () => {
  const name = WIN ? 'mediamtx.exe' : 'mediamtx';
  const p = resource('bin', MTX_PLATFORM, name);
  return fs.existsSync(p) ? p : resource('bin', name); // older packages shipped a flat bin/mediamtx
};
// Live feed presets; the frame rate follows the mains frequency so lights don't flicker on camera.
// kbps per live quality (cfg.liveQuality, global): the phone's thermal step-down still caps it when hot.
const LIVE = {
  720: { w: 1280, h: 720, fps: { 60: 30, 50: 25 }, kbps: { standard: 4000, high: 6000, max: 8000 } },
  1080: { w: 1920, h: 1080, fps: { 60: 30, 50: 25 }, kbps: { standard: 8000, high: 12000, max: 16000 } },
  '1080hfr': { w: 1920, h: 1080, fps: { 60: 60, 50: 50 }, kbps: { standard: 12000, high: 20000, max: 30000 } },
};
const QUALITIES = ['standard', 'high', 'max'];
// Hub tile preview: a light monitor feed, hardware-encoded on the phone, played back as real video in the tile.
const MONITOR = { w: 1280, h: 720, fps: { 60: 30, 50: 25 }, kbps: 2500 };
const PROFILE = 'main'; // Chromium's WebRTC decoder is safe with Baseline/Main; OBS accepts anything

let win;
let cfg;
const cfgPath = () => path.join(app.getPath('userData'), 'config.json');
const saveCfg = () => fs.writeFileSync(cfgPath(), JSON.stringify(cfg, null, 2));

const phones = new Map(); // deviceId -> { ws, host, name, platform, status, preview }
const inspecting = new Set(); // phones whose inspector is open in the hub (they send 1 Hz auto readouts)
const state = { recording: false, session: '', startedAt: 0, nextSession: '' };
const obs = new OBSWebSocket();
let obsOk = false;
let obsStartTimer = null; // pending OBS StartRecord during the pre-roll
let obsStarted = false;
let uploadsInFlight = 0;

// ---------- log file: everything the activity bar shows, plus MediaMTX and internal errors ----------
const logPath = () => path.join(app.getPath('userData'), 'hub.log');
let logStream = null;
const LOG_MAX = 5 * 1024 * 1024;
function trimLog() { // keep the newest 1 MB once the file passes 5 MB
  const p = logPath();
  if (!fs.existsSync(p) || fs.statSync(p).size <= LOG_MAX) return;
  const fd = fs.openSync(p, 'r'), size = fs.statSync(p).size, keep = Buffer.alloc(1024 * 1024);
  fs.readSync(fd, keep, 0, keep.length, size - keep.length);
  fs.closeSync(fd);
  fs.writeFileSync(p, keep);
}
function openLog() {
  try {
    trimLog();
    logStream = fs.createWriteStream(logPath(), { flags: 'a' });
    logStream.on('error', () => { logStream = null; });
  } catch {}
}
// A long service must not grow the log without bound: re-check every 10 minutes.
function rotateLogIfBig() {
  try {
    if (!fs.existsSync(logPath()) || fs.statSync(logPath()).size <= LOG_MAX) return;
    const old = logStream;
    logStream = null;
    old?.end(() => { try { trimLog(); } catch {} openLog(); flog('log trimmed'); });
  } catch {}
}
const flog = (line) => { try { logStream?.write(`${new Date().toISOString()} ${line}\n`); } catch {} };

const ui = (ch, data) => {
  if (ch === 'log') flog(data);
  return win && !win.isDestroyed() && win.webContents.send(ch, data);
};
const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
const broadcast = (msg) => phones.forEach((p) => p.ws && send(p.ws, msg));
// File/folder-safe on macOS and Windows: no dots, slashes or reserved device names (CON, NUL, COM1…), no trailing spaces.
const clean = (s) => {
  const v = String(s || '').replace(/[^\w\- ]+/g, '').trim().slice(0, 60).replace(/[ .]+$/, '');
  if (!v) return 'untitled';
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(v) ? `_${v}` : v;
};
const pushState = () => ui('state', state);
const keyOk = (k) => {
  const a = Buffer.from(String(k ?? '')), b = Buffer.from(cfg.key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const pathOf = (id) => `cam-${String(id).replace(/[^\w-]/g, '_')}`; // MediaMTX path for a phone
const publishPass = () => crypto.createHmac('sha256', cfg.key).update('tally-srt-publish').digest('hex').slice(0, 24);
// The hub's own MediaMTX user (read + API, localhost only). Random per install, never shown to phones.
const READ_USER = 'hubread';
const readPass = () => cfg.mtxReadPass;
const mtxAuth = () => ({ authorization: `Basic ${Buffer.from(`${READ_USER}:${readPass()}`).toString('base64')}` });
const obsReadUrl = (id) => `srt://127.0.0.1:${SRT_PORT}?streamid=read:${pathOf(id)}:${READ_USER}:${readPass()}`;
const obsViewUrl = (id) => `http://127.0.0.1:${PORT}/obs/${pathOf(id)}?k=${cfg.obsToken}`;

// OBS browser sources play each camera over WebRTC, the same route as the hub's tiles: no SRT receive buffer and
// no FFmpeg demux/probe buffer, so OBS shows the camera about as fast as the hub does.
const OBS_PAGE = `<!doctype html><meta charset="utf-8"><title>Tally camera</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}video{width:100%;height:100%;object-fit:contain;display:block;transition:transform .15s ease-out}
#s{position:fixed;left:0;right:0;top:45%;text-align:center;font:600 28px -apple-system,system-ui,sans-serif;color:#888}</style>
<video autoplay muted playsinline></video><div id="s">Waiting for camera…</div>
<script>
const v = document.querySelector('video');
const whep = location.pathname + '/whep' + location.search;
let pc = null, timer = null;
function retry() { clearTimeout(timer); timer = setTimeout(start, 1000); }
async function start() {
  try { pc && pc.close(); } catch {}
  pc = new RTCPeerConnection({ iceServers: [] });
  const me = pc;
  const tr = pc.addTransceiver('video', { direction: 'recvonly' });
  try { tr.receiver.jitterBufferTarget = 0; } catch {} // play frames as soon as they arrive
  pc.ontrack = (e) => { v.srcObject = new MediaStream([e.track]); v.play().catch(() => {}); };
  pc.onconnectionstatechange = () => { if (me === pc && ['failed', 'disconnected', 'closed'].includes(pc.connectionState)) retry(); };
  try {
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((r) => { if (pc.iceGatheringState === 'complete') return r(); pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && r(); setTimeout(r, 1500); });
    const res = await fetch(whep, { method: 'POST', headers: { 'content-type': 'application/sdp' }, body: pc.localDescription.sdp });
    if (res.status !== 201) throw new Error('feed not ready');
    await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
  } catch { if (me === pc) retry(); }
}
// Stalled video (phone paused or reconnected): start over.
let lastT = -1;
setInterval(() => { if (v.currentTime === lastT && pc && pc.connectionState === 'connected') start(); lastT = v.currentTime; }, 5000);
const st = document.getElementById('s');
setInterval(() => {
  const ok = v.readyState >= 2 && v.videoWidth > 0;
  st.style.display = ok ? 'none' : 'block';
  if (!ok) st.textContent = 'Waiting for camera… ' + (pc ? pc.connectionState : '') + (location.search.includes('debug') ? ' rs=' + v.readyState + ' t=' + v.currentTime.toFixed(1) + ' ' + v.videoWidth + 'x' + v.videoHeight : '');
}, 500);
start();
// Framing: a digital pan + zoom of this camera, set in the hub's inspector. Pushed live (SSE), never reloads the page.
function frame(f) {
  const z = +f.zoom || 1, x = f.x ?? 0.5, y = f.y ?? 0.5;
  v.style.transform = z === 1 ? '' : 'scale(' + z + ') translate(' + (0.5 - x) * 100 + '%,' + (0.5 - y) * 100 + '%)';
}
const fr = new EventSource(location.pathname + '/framing' + location.search);
fr.onmessage = (e) => { try { frame(JSON.parse(e.data)); } catch {} };
</script>`;
function obsPage(req, res, u) {
  const loopback = /^(127\.|::1$|::ffff:127\.)/.test(req.socket.remoteAddress || '');
  const m = u.pathname.match(/^\/obs\/(cam-[\w-]+)(\/whep|\/framing)?$/);
  const k = String(u.searchParams.get('k') || '');
  const tokOk = k.length === cfg.obsToken.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(cfg.obsToken));
  if (!loopback || !m || !tokOk) return res.writeHead(404).end();
  if (!m[2]) {
    if (req.method !== 'GET') return res.writeHead(405).end();
    return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(OBS_PAGE);
  }
  if (m[2] === '/framing') { // the camera's framing: JSON, or a live stream of it (SSE) for the OBS page
    if (req.method !== 'GET') return res.writeHead(405).end();
    const f = JSON.stringify(framingOf(idOfPath(m[1])));
    if (!/text\/event-stream/.test(req.headers.accept || '')) return res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(f);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    res.write(`retry: 1000\ndata: ${f}\n\n`);
    const subs = framingSubs.get(m[1]) || new Set();
    framingSubs.set(m[1], subs.add(res));
    req.on('close', () => subs.delete(res));
    return;
  }
  if (req.method !== 'POST') return res.writeHead(405).end();
  const chunks = [];
  let size = 0;
  req.on('data', (c) => { size += c.length; if (size > 64 * 1024) req.destroy(); else chunks.push(c); });
  req.on('error', () => {});
  req.on('end', async () => {
    try {
      const r = await fetch(whepUrl(m[1]), { method: 'POST', headers: { 'content-type': 'application/sdp', ...mtxAuth() }, body: Buffer.concat(chunks).toString(), signal: AbortSignal.timeout(8000) });
      res.writeHead(r.status === 201 ? 201 : 503, { 'content-type': 'application/sdp' }).end(r.status === 201 ? await r.text() : '');
    } catch { res.writeHead(503).end(); }
  });
}

// ---------- framing: per-camera digital pan + zoom of the live view (OBS page + hub tile), never the recording ----------
// zoom 1–3, x/y = normalised centre of the crop (kept inside the frame); portraitX = centre of the hub's 9:16 guide
// within the framed picture. Stored in cfg.framing[id].
const PORTRAIT_W = (9 / 16) / (16 / 9); // a full-height 9:16 box in a 16:9 picture
const framingSubs = new Map(); // MediaMTX path -> open SSE responses (OBS pages)
const idOfPath = (p) => [...new Set([...phones.keys(), ...Object.keys(cfg.framing || {})])].find((id) => pathOf(id) === p);
function clampFraming(f = {}) {
  const num = (v, d) => (Number.isFinite(+v) && v !== null && v !== '' ? +v : d);
  const zoom = Math.min(3, Math.max(1, num(f.zoom, 1))), h = 0.5 / zoom, pw = PORTRAIT_W / 2;
  const c = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  return { zoom, x: c(num(f.x, 0.5), h, 1 - h), y: c(num(f.y, 0.5), h, 1 - h), portraitX: c(num(f.portraitX, 0.5), pw, 1 - pw) };
}
const framingOf = (id) => clampFraming(id && cfg.framing?.[id]);
let framingSave = null;
function setFraming(id, f) {
  const next = clampFraming({ ...framingOf(id), ...f });
  cfg.framing = { ...cfg.framing, [id]: next };
  clearTimeout(framingSave);
  framingSave = setTimeout(saveCfg, 400); // drags send many updates; write the file once they settle
  const data = `data: ${JSON.stringify(next)}\n\n`;
  for (const res of framingSubs.get(pathOf(id)) || []) { try { res.write(data); } catch {} }
  return next;
}

// Keep the computer awake while it matters: a take, a clip copying, or any camera connected.
let powerId = null;
function updatePower() {
  const need = state.recording || uploadsInFlight > 0 || [...phones.values()].some((p) => p.ws);
  if (need && powerId == null) { powerId = powerSaveBlocker.start('prevent-app-suspension'); flog('sleep prevention on'); }
  else if (!need && powerId != null) { powerSaveBlocker.stop(powerId); powerId = null; flog('sleep prevention off'); }
}
const pushPhones = () =>
  ui('phones', [...phones].filter(([, p]) => !p.hidden).map(([id, p]) => ({ id, name: p.name, online: !!p.ws, platform: p.platform, status: p.status })));

// Every usable IPv4 interface, labelled the way the OS names it, likely LAN first.
function networks() {
  let ports = {};
  if (MAC) {
    try { // "Hardware Port: Wi-Fi\nDevice: en0" -> { en0: 'Wi-Fi' }
      const out = execFileSync('networksetup', ['-listallhardwareports'], { encoding: 'utf8', timeout: 2000 });
      for (const m of out.matchAll(/Hardware Port: (.+)\nDevice: (\S+)/g)) ports[m[2]] = m[1];
    } catch {}
  }
  const label = (dev) => ports[dev] || (/^bridge1\d\d$/.test(dev) ? 'Hotspot' : /^(en|eth)/.test(dev) ? 'Ethernet' : /^wl|Wi-?Fi/i.test(dev) ? 'Wi-Fi' : dev);
  const virtual = /^(utun|awdl|llw|vmnet|vboxnet|docker|tailscale|zt|anpi|ap\d|gif|stf|bridge0$|vEthernet|VirtualBox|VMware)/i; // VPNs, VMs, internal links
  const score = (dev, ip) => (/^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 0 : 10) + (label(dev) === 'Wi-Fi' ? 0 : 1);
  return Object.entries(os.networkInterfaces())
    .filter(([dev]) => !virtual.test(dev))
    .flatMap(([dev, list]) => (list || [])
      .filter((i) => i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')) // self-assigned: phones can't reach it
      .map((i) => ({ dev, ip: i.address, name: label(dev) })))
    .sort((a, b) => score(a.dev, a.ip) - score(b.dev, b.ip));
}

// A phone that dialled the Bonjour name may arrive over IPv6 link-local (fe80::…%en0), which the SRT feed
// can't use. Swap it for the IPv4 address on the same interface, else the best LAN address.
function ipv4Of(addr) {
  if (!addr.includes(':')) return addr;
  const bare = addr.split('%')[0];
  const ifs = os.networkInterfaces();
  const dev = Object.keys(ifs).find((d) => (ifs[d] || []).some((i) => i.address.split('%')[0] === bare));
  return (ifs[dev] || []).find((i) => i.family === 'IPv4' && !i.internal)?.address || networks()[0]?.ip || addr;
}

// Bonjour name first (survives DHCP address changes), then every LAN address. The phone tries them in order.
function hubNames() {
  let local = os.hostname(), name = local.replace(/\.local$/, '');
  if (MAC) {
    try { local = execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', timeout: 2000 }).trim(); } catch {}
    try { name = execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2000 }).trim(); } catch {}
  }
  if (!local.endsWith('.local')) local += '.local';
  return { mdns: local, name };
}

// ---------- macOS Application Firewall (Windows shows its own Defender prompt on first launch) ----------
// --getappblocked says "permitted" even for apps that aren't listed, so read --listapps instead.
const FW = '/usr/libexec/ApplicationFirewall/socketfilterfw';
const appBundle = () => process.execPath.match(/^(.*?\.app)\//)?.[1] || process.execPath;
// Both the app (camera control, uploads) and MediaMTX (live feed over UDP) need incoming connections.
const fwTargets = () => [appBundle(), MTX_BIN()].filter((p) => fs.existsSync(p));
async function codesignInfo(p) { // codesign prints its details on stderr
  try { const r = await execFileP('codesign', ['-dv', p], { encoding: 'utf8', timeout: 5000 }); return `${r.stdout}${r.stderr}`; }
  catch (e) { return `${e.stdout || ''}${e.stderr || ''}`; }
}
// Async: socketfilterfw can take a second or two and must never stall OBS starts or clock pongs.
// Checked at startup, when the pair dialog opens, and after a fix; not polled.
async function firewall() {
  if (!MAC || !fs.existsSync(FW)) return { ok: true, platform: process.platform };
  if (!app.isPackaged) return { ok: true, dev: true }; // rules for the dev Electron binary are pointless
  const run = async (arg) => { try { return (await execFileP(FW, [arg], { encoding: 'utf8', timeout: 5000 })).stdout; } catch { return ''; } };
  const bundle = appBundle();
  const state = await run('--getglobalstate');
  if (!/State = [12]/.test(state)) return { ok: true, app: bundle };
  if (/State = 2/.test(state) || /block all state set to enabled/i.test(await run('--getblockall'))) return { ok: false, blockAll: true, app: bundle };
  const lines = (await run('--listapps')).split('\n');
  // Allowed entries as listed: path → rule. macOS matches signed code by its signature (identifier + team), not
  // its path, so a moved or updated binary with the same signature is covered by the old entry and `--add` won't
  // list it again. Compare signatures for signed targets; fall back to the path for ad-hoc/unsigned code.
  const allowedPaths = [];
  lines.forEach((l, i) => {
    const m = l.match(/^\s*\d+\s*:\s*(.+?)\s*$/);
    if (m && /Allow incoming/i.test(lines[i + 1] || '')) allowedPaths.push(m[1]);
  });
  const sig = async (p) => {
    const info = await codesignInfo(p);
    const id = info.match(/^Identifier=(.+)$/m)?.[1];
    const team = info.match(/^TeamIdentifier=(.+)$/m)?.[1];
    return id && team && team !== 'not set' ? `${id}|${team}` : null;
  };
  const allowedSigs = new Set((await Promise.all(allowedPaths.filter((p) => fs.existsSync(p)).map(sig))).filter(Boolean));
  const blocked = [];
  for (const p of fwTargets()) {
    if (allowedPaths.includes(p)) continue;
    const s = await sig(p);
    if (s && allowedSigs.has(s)) continue;
    // The old entry may point at a path an update removed (macOS keeps its signature internally, we can't read
    // it). A signed binary with the same name inside this same app bundle is what macOS matched it to.
    if (s && allowedPaths.some((a) => !fs.existsSync(a) && a.startsWith(`${bundle}/`) && path.basename(a) === path.basename(p))) continue;
    blocked.push(p);
  }
  return { ok: !blocked.length, blocked, app: bundle };
}
// Adds and unblocks the app and MediaMTX via the standard macOS administrator prompt; never sudo silently.
async function fixFirewall() {
  if (!MAC) return firewall();
  // Only touch what is actually blocked. socketfilterfw exits non-zero for "already added", so each step runs on
  // its own (';' and '|| true', never '&&'); success is judged by re-reading --listapps afterwards, not exit codes.
  const before = await firewall();
  const targets = before.blocked?.length ? before.blocked : fwTargets();
  const sh = (v) => `'${v.replace(/'/g, `'\\''`)}'`;
  const cmd = targets.map((t) => `${FW} --add ${sh(t)} || true; ${FW} --unblockapp ${sh(t)} || true`).join('; ');
  const script = `do shell script "${cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" with administrator privileges`;
  return new Promise((res) => execFile('osascript', ['-e', script], async (err) => {
    const after = await firewall();
    // macOS only keeps rules for properly signed code; an ad-hoc signed build never appears in the list.
    const stuck = [];
    if (!err && !after.ok) for (const p of after.blocked || []) if (/Signature=adhoc/.test(await codesignInfo(p))) stuck.push(p);
    res({ ...after, cancelled: !!err, adhoc: stuck.map((p) => path.basename(p)) });
  }));
}

// ---------- upload endpoint (phones POST finished clips here) ----------
// A phone that stops sending for a minute (left Wi-Fi) is dropped; it retries later. (Dev tests may shorten it.)
const UPLOAD_IDLE_MS = (!app.isPackaged && +process.env.TALLY_UPLOAD_IDLE_MS) || 60000;
const isMedia = (f) => /\.(mp4|mov)$/i.test(f);
// Moves a finished .part to the first free "<cam>.mp4", "<cam>-2.mp4"... atomically (link fails if the name exists),
// so concurrent uploads never share a file and no empty placeholder ever carries a real clip name.
function claimName(part, dir, base, ext) {
  for (let n = 1; n < 1000; n++) {
    const f = path.join(dir, `${base}${n > 1 ? `-${n}` : ''}.${ext}`);
    try { fs.linkSync(part, f); fs.unlinkSync(part); return f; }
    catch (e) {
      if (e.code === 'EEXIST') continue;
      if (['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS'].includes(e.code)) { // no hard links on this volume: check-then-rename
        if (fs.existsSync(f)) continue;
        fs.renameSync(part, f);
        return f;
      }
      throw e;
    }
  }
  throw new Error('too many clips with this name');
}
function handleUpload(req, res) {
  let u;
  try { u = new URL(req.url, 'http://x'); } catch { return res.writeHead(400).end(); } // e.g. "GET //": never throw on network input
  if (u.pathname.startsWith('/obs/')) return obsPage(req, res, u);
  if (req.method !== 'POST' || u.pathname !== '/upload') return res.writeHead(404).end();
  if (!keyOk(u.searchParams.get('key'))) return res.writeHead(403).end();

  const ext = u.searchParams.get('ext') === 'mov' ? 'mov' : 'mp4';
  const dir = path.join(OUT_ROOT, clean(u.searchParams.get('session')));
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return res.writeHead(500).end(e.message); }
  const base = clean(u.searchParams.get('cam'));
  const part = path.join(dir, `${base}.${crypto.randomBytes(4).toString('hex')}.part`); // unique per upload

  const expected = Number(req.headers['content-length']);
  const id = u.searchParams.get('id');
  let got = 0, finished = false;
  uploadsInFlight++;
  updatePower();
  const out = fs.createWriteStream(part, { flags: 'wx' });
  const done = () => { finished = true; uploadsInFlight--; updatePower(); };
  const fail = (why) => {
    if (finished) return;
    done();
    req.unpipe(out);
    req.destroy();
    // The phone still has the clip and retries the whole upload, so a partial copy is useless here.
    // Remove it once the file handle is closed (Windows refuses to delete an open file).
    const rm = () => fs.rm(part, { force: true }, () => {});
    if (out.closed) rm(); else { out.once('close', rm); out.destroy(); }
    ui('upload', { id, error: why });
    ui('log', `Copy of ${base} failed: ${why}. The phone keeps the clip and will retry.`);
    if (!res.headersSent) { try { res.writeHead(500).end(why); } catch {} }
  };
  req.setTimeout(UPLOAD_IDLE_MS, () => fail(`stalled for ${UPLOAD_IDLE_MS / 1000} s`));
  req.on('error', (e) => fail(e.message));
  req.on('close', () => { if (!req.complete) fail('connection closed'); });
  req.on('data', (c) => {
    got += c.length;
    ui('upload', { id, got, expected });
  });
  req.pipe(out);
  out.on('error', (e) => fail(e.message));
  out.on('finish', () => {
    if (finished) return;
    if (expected && got !== expected) return fail(`size mismatch ${got}/${expected}`);
    let file;
    try { file = claimName(part, dir, base, ext); } catch (e) { return fail(`could not save: ${e.message}`); }
    done();
    ui('upload', { id, done: file });
    ui('log', `Saved ${file}`);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, bytes: got }));
  });
}

// Startup tidy-up after a crash or force-quit. Nothing can be uploading yet: the single-instance lock means no
// other hub, and our server isn't listening. Empty files (0-byte .part, or 0-byte name placeholders left by older
// versions) are removed; non-empty .part files are kept and logged so nothing with data is ever deleted.
function tidyRecordings() {
  let removed = 0;
  const keep = [];
  try {
    for (const d of fs.readdirSync(OUT_ROOT, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dir = path.join(OUT_ROOT, d.name);
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.part') && !isMedia(f)) continue;
        const p = path.join(dir, f);
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        if (!st.isFile()) continue;
        if (st.size === 0) { try { fs.unlinkSync(p); removed++; } catch {} }
        else if (f.endsWith('.part')) keep.push(`${d.name}/${f} (${st.size >= 1e6 ? `${(st.size / 1e6).toFixed(1)} MB` : `${Math.ceil(st.size / 1024)} KB`})`);
      }
    }
  } catch {}
  if (removed) flog(`startup: removed ${removed} empty leftover file(s) from interrupted copies`);
  if (keep.length) ui('log', `Interrupted copies kept (phones will re-send these clips): ${keep.join(', ')}`);
}

// ---------- phone connections ----------
const MAX_PAYLOAD = 16 * 1024 * 1024; // guard only; previews are ~30-80 KB
const DEFAULT_PREVIEW = { fps: 12, maxWidth: 640 };

// Should a reconnecting phone that says it is recording be stopped? Only if it is still running a take that THIS hub
// started and that is no longer the current one (it missed the STOP). Standalone takes (recorded while the phone had
// no hub) and takes from another hub are never touched.
function staleTake(st) {
  if (!st?.recording) return false;
  const s = typeof st.session === 'string' ? st.session : '';
  if (!s || s.startsWith('standalone_')) return false;
  if (!(cfg.sessions || []).includes(s)) return false;
  return !(state.recording && s === state.session);
}

const HELLO_TIMEOUT_MS = 10000;
function onPhone(ws, req) {
  let id = null;
  const host = ipv4Of((req.socket.localAddress || '').replace(/^::ffff:/, '')); // the hub address this phone reached
  // Unauthenticated sockets get 10 s to say hello, then they're dropped without a word in the log.
  const helloTimer = setTimeout(() => { if (!id) { try { ws.terminate(); } catch {} } }, HELLO_TIMEOUT_MS);
  // Network input must never crash the hub: log, drop this socket, the phone reconnects.
  ws.on('error', (e) => {
    if (id) ui('log', `${phones.get(id)?.name || 'A camera'} connection dropped: ${e.message}`);
    try { ws.terminate(); } catch {}
  });
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (!id) { try { ws.terminate(); } catch {} return; } // nothing binary before a valid hello
      if (data.length > 2e6) ui('log', `${phones.get(id)?.name || 'A camera'} sent a ${(data.length / 1e6).toFixed(1)} MB preview frame (expected < 0.1 MB)`);
      return ui('frame', { id, jpg: data });
    }
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== 'object' || Array.isArray(m)) return; // "null", numbers, arrays: ignore
    if (m.t === 'hello') {
      if (!keyOk(m.key)) return ws.close(4003, 'bad key');
      clearTimeout(helloTimer);
      id = clean(m.id);
      const prev = phones.get(id);
      if (prev?.ws && prev.ws !== ws) prev.ws.close();
      const platform = m.platform === 'ios' || m.platform === 'android' ? m.platform : prev?.platform || 'unknown';
      phones.set(id, { ws, host, name: clean(m.name), platform, status: m.status || {}, preview: prev?.preview || DEFAULT_PREVIEW, hidden: false });
      // A phone that dropped off mid-take missed the STOP for a take this hub started: stop it now.
      if (staleTake(m.status)) { send(ws, { t: 'stop', atHubMs: Date.now() }); ui('log', `${clean(m.name)} was still recording an earlier take: stopped it`); }
      // After the phone's first clock pings (8 × 120 ms): it sizes the SRT buffer from that measured round trip.
      setTimeout(() => { if (phones.get(id)?.ws === ws) send(ws, streamMsg(id)); }, 1000);
      send(ws, { t: 'preview', ...phones.get(id).preview });
      if (inspecting.has(id)) send(ws, { t: 'inspect', on: true }); // the hub's inspector is still open on it
      updatePower();
      return pushPhones();
    }
    if (!id) return; // nothing, not even ping, before a valid hello
    if (m.t === 'ping') return send(ws, { t: 'pong', t0: m.t0, hubT: Date.now() });
    if (m.t === 'level') return ui('level', { id, db: +m.db }); // ~5 Hz per phone, straight to the meter
    const p = phones.get(id);
    if (m.t === 'requestRecord') { if (!state.recording) ui('log', `${p.name} started the take`); return startAll(); }
    if (m.t === 'requestStop') { if (state.recording) ui('log', `${p.name} stopped the take`); return stopAll(); }
    if (m.t === 'status') {
      const was = p.status?.stream?.state;
      p.status = m;
      ui('status', { id, status: m });
      if (m.stream?.state !== was) pollLive(); // the tile switches to video as soon as MediaMTX has the feed
    }
    if (m.t === 'error') { // first line only: older phone builds send whole native stack traces
      const msg = String(m.message || '').split('\n')[0].replace(/\s+at \S+\(r8-map-id.*$/, '').slice(0, 300);
      ui('log', `${p.name}: ${msg}`); ui('phoneError', { id, message: msg });
    }
    if (m.t === 'started') ui('log', `${p.name} started (${m.lateMs} ms after target)`);
  });
  ws.on('close', () => {
    clearTimeout(helloTimer);
    const p = id && phones.get(id);
    if (p && p.ws === ws) { p.ws = null; pushPhones(); updatePower(); }
  });
}

// ---------- OBS ----------
// Always connected when OBS is reachable ("Add cameras" needs it); the switch only controls record sync.
let obsBusy = false, obsLastErr = '';
async function obsConnect() {
  if (obsBusy) return;
  obsBusy = true; obsOk = false;
  try { await obs.disconnect(); } catch {}
  try {
    await obs.connect(cfg.obs.url, cfg.obs.password || undefined);
    obsOk = true; obsLastErr = '';
    ui('obs', { ok: true, msg: 'connected' });
    obsRefreshSources().catch((e) => flog(`OBS source refresh: ${e.message}`));
  } catch (e) {
    const msg = /auth/i.test(e.message) ? 'wrong password' : 'OBS not found. Is OBS open with its WebSocket server enabled?';
    if (msg !== obsLastErr) flog(`OBS: ${e.message || e.code || e}`);
    obsLastErr = msg;
    ui('obs', { ok: false, msg });
  } finally { obsBusy = false; }
}
setInterval(() => { if (cfg?.obs && !obsOk && obsLastErr !== 'wrong password') obsConnect(); }, 5000); // picks OBS up when it's opened later
// Sources made by an earlier version (or with an old read password) are rewritten to the current credentials,
// so they keep playing without the operator re-running "Add to OBS".
async function obsRefreshSources() {
  const want = (url) => url.replace(/streamid=read:(cam-[\w-]+)(:[^&]*)?/, (_m, p) => `streamid=read:${p}:${READ_USER}:${readPass()}`);
  for (const { inputName, inputKind } of (await obs.call('GetInputList')).inputs) {
    if (inputKind !== 'ffmpeg_source' || !inputName.startsWith('Tally · ')) continue;
    const url = (await obs.call('GetInputSettings', { inputName })).inputSettings?.input || '';
    if (!/^srt:\/\/127\.0\.0\.1:\d+\?streamid=read:cam-/.test(url)) continue;
    const fixed = want(url).replace(/^srt:\/\/127\.0\.0\.1:\d+/, `srt://127.0.0.1:${SRT_PORT}`);
    if (fixed !== url) await obs.call('SetInputSettings', { inputName, inputSettings: { input: fixed }, overlay: true });
  }
}
obs.on('ConnectionClosed', () => { if (obsOk) ui('obs', { ok: false, msg: 'disconnected' }); obsOk = false; }); // failed attempts report via obsConnect
const obsCall = (req) => obsOk && obs.call(req).catch((e) => ui('log', `OBS ${req}: ${e.message}`));

// ---------- live feed: phones push hardware H.264 over SRT to MediaMTX here; OBS and the tiles read it on localhost ----------
// Which feed a phone should send: the LIVE preset for OBS, else a light monitor feed for the hub's tiles, else nothing.
function streamRole(p) {
  if (LIVE[cfg.live]) return 'live';
  const smooth = p.platform === 'ios' ? cfg.smooth : p.platform === 'android' ? cfg.smoothAndroid : false;
  return smooth ? 'monitor' : 'off';
}
function streamMsg(id) {
  const p = phones.get(id);
  if (!p) return { t: 'stream', on: false };
  const role = streamRole(p), preset = role === 'live' ? LIVE[cfg.live] : MONITOR;
  if (role === 'off') return { t: 'stream', on: false, role };
  const ip = p.host.includes(':') ? `[${p.host}]` : p.host;
  return {
    t: 'stream', on: true, role, width: preset.w, height: preset.h, fps: preset.fps[cfg.mains],
    bitrateKbps: role === 'live' ? preset.kbps[cfg.liveQuality] || preset.kbps.standard : preset.kbps, profile: PROFILE,
    url: `srt://${ip}:${SRT_PORT}?streamid=publish:${pathOf(id)}:tally:${publishPass()}&pkt_size=1316`,
  };
}
const pushStreams = () => phones.forEach((p, id) => p.ws && send(p.ws, streamMsg(id)));

let mtx = null, mtxQuitting = false, mtxFails = 0;
const mtxPidFile = () => path.join(app.getPath('userData'), 'mediamtx.pid');
// A crash or force-quit of the hub can leave MediaMTX holding the SRT port: kill our own leftover first.
function killStaleMediaMTX() {
  try {
    const pid = +fs.readFileSync(mtxPidFile(), 'utf8');
    if (!pid) return;
    const cmd = WIN
      ? execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
      : execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
    if (WIN ? /mediamtx\.exe/i.test(cmd) : cmd.includes(MTX_BIN())) process.kill(pid);
  } catch {}
}
function startMediaMTX() {
  const bin = MTX_BIN();
  if (!fs.existsSync(bin)) return ui('log', `Live feed unavailable: MediaMTX is missing. Run: node build/fetch-mediamtx.js ${MTX_PLATFORM}`);
  killStaleMediaMTX();
  const started = Date.now();
  mtx = spawn(bin, [resource('mediamtx.yml')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env, MTX_AUTHINTERNALUSERS_0_PASS: publishPass(), MTX_AUTHINTERNALUSERS_1_PASS: readPass(),
      MTX_SRTADDRESS: `${LISTEN_HOST || ''}:${SRT_PORT}`, MTX_APIADDRESS: `127.0.0.1:${MTX_API}`,
      MTX_WEBRTCADDRESS: `127.0.0.1:${WEBRTC_PORT}`, MTX_WEBRTCLOCALUDPADDRESS: `127.0.0.1:${ICE_PORT}`,
    },
  });
  const out = (d) => String(d).split('\n').filter(Boolean).forEach((l) => {
    flog(`[mediamtx] ${l}`);
    if (/ ERR |failed to authenticate/.test(l)) ui('log', `Live server: ${l.replace(/^\S+ \S+ (ERR|WAR) /, '')}`);
  });
  try { fs.writeFileSync(mtxPidFile(), String(mtx.pid)); } catch {}
  mtx.stdout.on('data', out);
  mtx.stderr.on('data', out);
  mtx.on('error', (e) => ui('log', `Live server could not start: ${e.message}`));
  mtx.on('exit', (code) => {
    mtx = null;
    if (mtxQuitting) return;
    if (Date.now() - started > 30000) mtxFails = 0;
    const delay = Math.min(30000, 1000 * 2 ** mtxFails++);
    ui('log', `Live server stopped (code ${code}). Restarting in ${delay / 1000} s.`);
    setTimeout(startMediaMTX, delay);
  });
}

// Hub-side truth for each feed: is MediaMTX receiving it, at what bitrate, which role, and is OBS reading it?
const lastBytes = new Map();
let polling = false;
async function pollLive() {
  if (!mtx || polling) return;
  polling = true;
  try {
    const r = await fetch(`http://127.0.0.1:${MTX_API}/v3/paths/list`, { headers: mtxAuth(), signal: AbortSignal.timeout(1500) });
    if (!r.ok) throw new Error(`MediaMTX API ${r.status}`);
    const items = (await r.json()).items || [];
    const now = Date.now();
    for (const [id, p] of phones) {
      const it = items.find((x) => x.name === pathOf(id));
      const prev = lastBytes.get(id);
      const bytes = it?.bytesReceived || 0;
      const kbps = prev && it ? Math.max(0, Math.round(((bytes - prev.bytes) * 8) / (now - prev.at))) : 0;
      lastBytes.set(id, { bytes, at: now });
      // Readers other than our own tiles' WebRTC sessions are OBS (it reads SRT on localhost).
      const readers = (it?.readers || []).filter((x) => x.type !== 'webRTCSession').length;
      ui('live', { id, role: p.ws ? streamRole(p) : 'off', ready: !!it?.ready, kbps, readers, tracks: it?.tracks || [], path: pathOf(id) });
    }
  } catch {} finally { polling = false; }
}

// Creates or updates one OBS Media Source per phone: a "Tally Cameras" multiview scene plus one full-frame scene each.
async function obsAddCameras() {
  if (!obsOk) await obsConnect();
  if (!obsOk) throw new Error(obsLastErr || 'OBS is not connected.');
  const cams = [...phones].map(([id, p]) => ({ id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name));
  if (!cams.length) throw new Error('Pair a camera first.');
  const { baseWidth: W, baseHeight: H } = await obs.call('GetVideoSettings');
  const scenes = new Set((await obs.call('GetSceneList')).scenes.map((x) => x.sceneName));
  const inputs = new Map((await obs.call('GetInputList')).inputs.map((x) => [x.inputName, x.inputKind]));
  const livePreset = LIVE[cfg.live] || LIVE[1080];
  const scene = async (sceneName) => { if (!scenes.has(sceneName)) { await obs.call('CreateScene', { sceneName }); scenes.add(sceneName); } };
  const item = async (sceneName, sourceName) => {
    try { return (await obs.call('GetSceneItemId', { sceneName, sourceName })).sceneItemId; }
    catch { return (await obs.call('CreateSceneItem', { sceneName, sourceName })).sceneItemId; }
  };
  const fit = (sceneName, sceneItemId, x, y, w, h) => obs.call('SetSceneItemTransform', {
    sceneName, sceneItemId,
    sceneItemTransform: { positionX: x, positionY: y, alignment: 5, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsAlignment: 0, boundsWidth: w, boundsHeight: h },
  });
  const MAIN = 'Tally Cameras', OBS_FILTER = 'Tally colour';
  await scene(MAIN);
  const cols = Math.ceil(Math.sqrt(cams.length)), rows = Math.ceil(cams.length / cols);
  for (const [i, c] of cams.entries()) {
    const inputName = `Tally · ${c.name}`;
    // Sized like the live feed; the page letterboxes a portrait phone. Kept running when off-screen for instant cuts.
    const inputSettings = { url: obsViewUrl(c.id), width: livePreset.w, height: livePreset.h, // renders at OBS's own frame rate
      shutdown: false, restart_when_active: false, reroute_audio: true, css: '' };
    if (inputs.get(inputName) && inputs.get(inputName) !== 'browser_source') { // an older SRT media source: replace it
      // Rename first: OBS frees a removed source's name only once its SRT reader lets go, which can take a while.
      const old = `${inputName} (old ${crypto.randomBytes(2).toString('hex')})`;
      await obs.call('SetInputName', { inputName, newInputName: old });
      await obs.call('RemoveInput', { inputName: old }); inputs.delete(inputName);
    }
    if (inputs.has(inputName)) await obs.call('SetInputSettings', { inputName, inputSettings, overlay: true });
    else { await obs.call('CreateInput', { sceneName: MAIN, inputName, inputKind: 'browser_source', inputSettings }); inputs.set(inputName, 'browser_source'); }
    await fit(MAIN, await item(MAIN, inputName), (i % cols) * (W / cols), Math.floor(i / cols) * (H / rows), W / cols, H / rows);
    // OBS's own Color Correction, attached but off: ready for matching cameras where the feeds are mixed.
    try {
      const { filters } = await obs.call('GetSourceFilterList', { sourceName: inputName });
      if (!filters.some((f) => f.filterName === OBS_FILTER)) {
        await obs.call('CreateSourceFilter', { sourceName: inputName, filterName: OBS_FILTER, filterKind: 'color_filter_v2', filterSettings: {} });
        await obs.call('SetSourceFilterEnabled', { sourceName: inputName, filterName: OBS_FILTER, filterEnabled: false });
      }
    } catch (e) { ui('log', `OBS: could not add the colour filter to ${inputName}: ${e.message}`); }
    const solo = `Tally – ${c.name}`;
    await scene(solo);
    await fit(solo, await item(solo, inputName), 0, 0, W, H);
  }
  return cams.length;
}

// ---------- record control ----------
const at = (atHubMs, fn) => setTimeout(fn, Math.max(0, atHubMs - Date.now()));

// Single path for every start/stop, whether the hub button or a phone's record button triggered it.
// Local calendar date (an evening service in the Americas must not be filed under tomorrow's UTC date).
const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// The running take is saved, so a hub restart mid-take keeps the phones recording and the REC state.
function persistTake() {
  cfg.active = state.recording ? { session: state.session, startedAt: state.startedAt, obs: obsStarted } : null;
  saveCfg();
}
function startAll(session = state.nextSession) {
  if (state.recording) return state;
  const atHubMs = Date.now() + START_DELAY_MS;
  // Same name twice in one day: add the time so takes don't mix in one folder or look stale to each other.
  let name = `${localDate()}_${clean(session)}`;
  if ((cfg.sessions || []).includes(name)) {
    const d = new Date();
    name += `_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
  }
  Object.assign(state, { recording: true, session: name, startedAt: atHubMs });
  cfg.sessions = [...(cfg.sessions || []).filter((x) => x !== name), name].slice(-50); // takes this hub started
  broadcast({ t: 'record', session: state.session, atHubMs });
  obsStarted = false;
  obsStartTimer = at(atHubMs, () => {
    obsStartTimer = null;
    if (!obsOk || !cfg.obs.enabled) return;
    obsStarted = true;
    obsCall('StartRecord');
    persistTake();
  });
  persistTake();
  updatePower();
  pushState();
  return state;
}
function stopAll() {
  if (!state.recording) return state;
  // Never schedule the stop before the start: a STOP during the 1.5 s pre-roll must still land after it.
  const atHubMs = Math.max(Date.now() + 300, state.startedAt + 200);
  state.recording = false;
  broadcast({ t: 'stop', atHubMs });
  if (obsStartTimer) { clearTimeout(obsStartTimer); obsStartTimer = null; } // OBS never started: nothing to stop
  else if (obsStarted) at(atHubMs, () => obsCall('StopRecord'));
  obsStarted = false;
  persistTake();
  updatePower();
  pushState();
  return state;
}
ipcMain.handle('record', (_e, session) => startAll(session));
ipcMain.handle('stop', () => stopAll());
ipcMain.handle('session', (_e, name) => { state.nextSession = name; }); // used when a phone starts the take
ipcMain.handle('settings', (_e, id, s) => {
  phones.forEach((p, pid) => (!id || id === pid) && p.ws && send(p.ws, { t: 'settings', ...s }));
});
ipcMain.handle('focus', (_e, id, x, y) => { const p = phones.get(id); p?.ws && send(p.ws, { t: 'focus', x, y }); });
ipcMain.handle('lock', (_e, id, on) => {
  phones.forEach((p, pid) => (!id || id === pid) && p.ws && send(p.ws, { t: 'lock', on }));
});
// Manual 3A: only the keys given are sent; null = back to auto for that control. The phone clamps to its ranges.
const MANUAL_KEYS = ['iso', 'shutter', 'wbTemp', 'wbTint', 'focus'];
ipcMain.handle('manual', (_e, id, m) => {
  const msg = { t: 'manual' };
  for (const k of MANUAL_KEYS) if (m && k in m && (m[k] === null || Number.isFinite(m[k]))) msg[k] = m[k];
  if (Object.keys(msg).length === 1) return;
  phones.forEach((p, pid) => (!id || id === pid) && p.ws && send(p.ws, msg));
});
// The hub's inspector opened/closed on this camera: the phone sends live auto readouts (ISO, shutter) only meanwhile.
ipcMain.handle('inspect', (_e, id, on) => {
  if (on) inspecting.add(id); else inspecting.delete(id);
  const p = phones.get(id);
  if (p?.ws) send(p.ws, { t: 'inspect', on: !!on });
});
// Thumbnail rate per phone, decided by the renderer from what is actually on screen.
ipcMain.handle('preview', (_e, id, fps, maxWidth) => {
  const p = phones.get(id);
  if (!p) return;
  p.preview = { fps: Math.min(15, Math.max(0.5, +fps || 1)), maxWidth: Math.min(1280, Math.max(160, +maxWidth || 640)) };
  if (p.ws) send(p.ws, { t: 'preview', ...p.preview });
});
// Close: disconnect now, keep the pairing; the phone waits for a tap before reconnecting, so the tile stays gone.
ipcMain.handle('close', (_e, id) => {
  const p = phones.get(id);
  if (!p) return;
  const ws = p.ws;
  if (ws) {
    // A recording phone is stopped first, so its clip is finished and queued before it goes (it keeps reconnecting
    // quietly until that take is saved, then waits for a tap).
    if (p.status?.recording) send(ws, { t: 'stop', atHubMs: Date.now() });
    send(ws, { t: 'close', reason: 'closed by hub' });
    setTimeout(() => { try { ws.close(1000, 'closed by hub'); } catch {} }, 300);
  }
  p.ws = null; p.hidden = true; // stays in the list (hidden) so a manual reconnect re-creates the tile
  pushPhones();
  updatePower();
});
// Forget: the phone clears its pairing and goes back to the pair screen.
ipcMain.handle('forget', (_e, id) => {
  const p = phones.get(id);
  const ws = p?.ws;
  if (ws) { send(ws, { t: 'forget' }); setTimeout(() => { try { ws.close(1000, 'forgotten'); } catch {} }, 300); }
  phones.delete(id); inspecting.delete(id); pushPhones(); updatePower();
  if (cfg.framing?.[id]) { delete cfg.framing[id]; saveCfg(); }
});
ipcMain.handle('obs', (_e, o) => { cfg.obs = { ...cfg.obs, ...o }; saveCfg(); return obsConnect(); });
ipcMain.handle('openFolder', () => { fs.mkdirSync(OUT_ROOT, { recursive: true }); shell.openPath(OUT_ROOT); });
// WHEP signalling for the tiles. Done here, not in the renderer: MediaMTX's HTTP server refuses cross-site browser
// POSTs (the page is file://), and this keeps the renderer off the network entirely.
const whepUrl = (p) => `http://127.0.0.1:${WEBRTC_PORT}/${encodeURIComponent(String(p).replace(/[^\w-]/g, '_'))}/whep`;
ipcMain.handle('whep', async (_e, mtxPath, sdp) => {
  try {
    const r = await fetch(whepUrl(mtxPath), { method: 'POST', headers: { 'content-type': 'application/sdp', ...mtxAuth() }, body: String(sdp).slice(0, 64 * 1024), signal: AbortSignal.timeout(8000) });
    const body = await r.text();
    if (r.status !== 201) return { ok: false, error: `WHEP ${r.status}${body ? `: ${body.slice(0, 160)}` : ''}` };
    const loc = r.headers.get('location');
    return { ok: true, sdp: body, session: loc ? new URL(loc, whepUrl(mtxPath)).href : null };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('whepEnd', (_e, session) => {
  if (typeof session === 'string' && session.startsWith(`http://127.0.0.1:${WEBRTC_PORT}/`)) fetch(session, { method: 'DELETE', headers: mtxAuth(), signal: AbortSignal.timeout(3000) }).catch(() => {});
});
ipcMain.handle('rlog', (_e, line) => flog(`[ui] ${String(line).slice(0, 500)}`)); // activity log mirrored into the file
ipcMain.handle('openLog', () => { flog('log opened by the operator'); return shell.openPath(logPath()); });
ipcMain.handle('copy', (_e, text) => clipboard.writeText(String(text)));
ipcMain.handle('pairing', async () => {
  const nets = networks(), { mdns, name } = hubNames();
  const hosts = [mdns, ...nets.map((n) => n.ip)];
  const text = `tally://${hosts.join(',')}:${PORT}?key=${cfg.key}&name=${encodeURIComponent(name)}`;
  return { text, nets, mdns, name, port: PORT, key: cfg.key,
    img: await QRCode.toDataURL(text, { margin: 0, width: 440, errorCorrectionLevel: 'M' }) };
});
ipcMain.handle('firewall', () => firewall());
ipcMain.handle('firewallFix', () => fixFirewall());
ipcMain.handle('firewallSettings', () => shell.openExternal(MAC ? 'x-apple.systempreferences:com.apple.preference.security?Firewall' : 'ms-settings:windowsdefender'));
const liveKbps = Object.fromEntries(Object.entries(LIVE).map(([k, v]) => [k, v.kbps]));
const liveCfg = () => ({ live: cfg.live, mains: cfg.mains, smooth: cfg.smooth, smoothAndroid: cfg.smoothAndroid, liveQuality: cfg.liveQuality, liveKbps });
ipcMain.handle('framing', (_e, id, f) => (typeof id === 'string' && phones.has(id) ? setFraming(id, f || {}) : null));
ipcMain.handle('portraitGuide', (_e, on) => { cfg.portraitGuide = !!on; saveCfg(); return cfg.portraitGuide; });
const pushLiveCfg = () => ui('liveCfg', liveCfg());
ipcMain.handle('live', (_e, preset) => { cfg.live = LIVE[preset] ? String(preset) : 'off'; saveCfg(); pushStreams(); pushLiveCfg(); return cfg.live; });
ipcMain.handle('liveQuality', (_e, q) => {
  cfg.liveQuality = QUALITIES.includes(q) ? q : 'standard';
  saveCfg(); pushStreams(); pushLiveCfg();
  return cfg.liveQuality;
});
ipcMain.handle('mains', (_e, hz) => { cfg.mains = +hz === 50 ? 50 : 60; saveCfg(); pushStreams(); pushLiveCfg(); return cfg.mains; });
ipcMain.handle('smooth', (_e, o) => {
  if (typeof o.smooth === 'boolean') cfg.smooth = o.smooth;
  if (typeof o.smoothAndroid === 'boolean') cfg.smoothAndroid = o.smoothAndroid;
  saveCfg(); pushStreams(); pushLiveCfg();
  return liveCfg();
});
ipcMain.handle('obsAddCameras', async () => {
  try { return { ok: true, n: await obsAddCameras() }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('init', () => {
  setTimeout(() => { pushPhones(); pushState(); pollLive(); }, 0); // a reloaded renderer gets the current phones back
  for (const id of inspecting) { const p = phones.get(id); if (p?.ws) send(p.ws, { t: 'inspect', on: false }); } // a fresh page has no inspector open
  inspecting.clear();
  return {
  key: cfg.key, port: PORT, obs: cfg.obs, state, out: OUT_ROOT, ...liveCfg(), srtPort: SRT_PORT, webrtcPort: WEBRTC_PORT,
  framing: Object.fromEntries(Object.keys(cfg.framing).map((id) => [id, framingOf(id)])), portraitGuide: !!cfg.portraitGuide,
  platform: process.platform, version: VERSION, logPath: logPath(), mediamtx: fs.existsSync(MTX_BIN()),
  };
});
// Dev-only hooks for the end-to-end test (never present in a packaged app).
if (!app.isPackaged && process.env.TALLY_TEST) {
  ipcMain.handle('__test', (_e, what) => {
    if (what === 'minimize') win.minimize();
    if (what === 'restore') win.restore();
    if (what === 'hide') win.hide();
    if (what === 'show') win.show();
    if (what === 'close') { setTimeout(() => win?.close(), 50); return { closing: true }; }
    return { visible: win.isVisible(), minimized: win.isMinimized(), phones: [...phones].map(([id, p]) => ({ id, preview: p.preview, role: streamRole(p), hidden: !!p.hidden })) };
  });
}

// ---------- boot ----------
// Last-resort guard: log, never a crash dialog in the middle of a service.
process.on('uncaughtException', (e) => { flog(`uncaught: ${e?.stack || e}`); ui('log', `Internal error (recovered): ${e.message}`); });
process.on('unhandledRejection', (e) => { flog(`unhandled: ${e?.stack || e}`); ui('log', `Internal error (recovered): ${e?.message || e}`); });

// One hub per computer (it owns port 7777). A second copy only hands focus to the first and exits: it must not
// touch MediaMTX, the config or the ports.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return; // CommonJS module scope: stop here
}
app.on('second-instance', () => {
  if (!app.isReady()) return;
  if (!win || win.isDestroyed()) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

let visTimer = null, logTimer = null;
function createWindow() {
  const icon = path.join(__dirname, WIN ? 'icon.ico' : 'icon.png');
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 600, title: 'Tally Hub', icon: fs.existsSync(icon) ? icon : undefined,
    backgroundColor: '#0b0b0d', titleBarStyle: MAC ? 'hiddenInset' : 'default',
    webPreferences: { preload: path.join(__dirname, 'preload.js') }, // contextIsolation + sandbox are Electron's defaults
  });
  // The window only ever shows index.html: no navigation, no new windows (a file dropped on the window is ignored).
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('will-redirect', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadFile('index.html');
  win.webContents.once('did-finish-load', () => { if (!obsOk) obsConnect(); });
  // The renderer can't always tell when it is hidden; the window knows. Hidden tiles drop to a trickle of snapshots.
  let wasVisible = true;
  const vis = () => {
    if (!win || win.isDestroyed()) return;
    const v = win.isVisible() && !win.isMinimized();
    if (v !== wasVisible) { wasVisible = v; ui('winVisible', v); }
  };
  for (const ev of ['show', 'hide', 'minimize', 'restore', 'maximize', 'unmaximize']) win.on(ev, vis);
  clearInterval(visTimer);
  visTimer = setInterval(vis, 1000); // belt and braces: some hide paths don't emit events
  win.webContents.on('render-process-gone', (_e, d) => flog(`renderer gone: ${d.reason}`));
  // Closing the window quits Tally Hub (on macOS too: it's a single-window control app). Ask first if that would
  // interrupt a take or a copy.
  win.on('close', (e) => {
    if (quitting || !quitIssues().length) { quitting = true; return; }
    e.preventDefault();
    confirmQuit();
  });
  win.on('closed', () => { clearInterval(visTimer); visTimer = null; win = null; });
}

app.whenReady().then(() => {
  openLog();
  flog(`Tally Hub ${VERSION} started (${process.platform} ${process.arch}, Electron ${process.versions.electron})`);
  logTimer = setInterval(rotateLogIfBig, 10 * 60 * 1000);
  try { cfg = JSON.parse(fs.readFileSync(cfgPath(), 'utf8')); } catch { cfg = {}; }
  if (!cfg || typeof cfg !== 'object') cfg = {};
  cfg.key ||= crypto.randomBytes(8).toString('hex'); // stable, so paired phones reconnect after a restart
  cfg.mtxReadPass ||= crypto.randomBytes(24).toString('hex'); // the hub's own local read/API password
  cfg.obsToken ||= crypto.randomBytes(16).toString('hex'); // lets OBS browser sources open the camera pages
  cfg.obs ||= { enabled: false, url: 'ws://127.0.0.1:4455', password: '' };
  cfg.live ||= 'off';
  cfg.mains ||= 60;
  if (!QUALITIES.includes(cfg.liveQuality)) cfg.liveQuality = 'standard';
  cfg.smooth ??= true; // iPhones send a light monitor feed so the tiles show real video
  cfg.framing = cfg.framing && typeof cfg.framing === 'object' ? cfg.framing : {};
  cfg.smoothAndroid ??= false; // on Android the extra camera stream can affect 4K recording on some phones
  cfg.sessions = Array.isArray(cfg.sessions) ? cfg.sessions.slice(-50) : [];
  // Restarted mid-take (crash, or "Quit anyway" while recording)? Carry on with that take, so phones aren't stopped.
  const a = cfg.active;
  if (a && typeof a.session === 'string' && Date.now() - a.startedAt < 12 * 3600 * 1000) {
    Object.assign(state, { recording: true, session: a.session, startedAt: a.startedAt });
    obsStarted = !!a.obs;
    flog(`resumed take ${a.session} after a restart`);
  } else cfg.active = null;
  saveCfg();
  startMediaMTX();
  setInterval(pollLive, 2000);
  setImmediate(tidyRecordings);

  const server = http.createServer(handleUpload);
  const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD });
  wss.on('connection', onPhone);
  wss.on('error', (e) => ui('log', `Camera server error: ${e.message}`));
  server.requestTimeout = 0; // big 4K clips take minutes over Wi-Fi; stalls are caught per upload (60 s idle)
  server.on('clientError', (_e, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {} });
  server.on('error', (e) => {
    flog(`server error: ${e.stack || e}`);
    dialog.showErrorBox('Tally Hub can\'t start', e.code === 'EADDRINUSE'
      ? `Port ${PORT} is already in use. Close any other copy of Tally Hub (or an older hub app) and open it again.`
      : e.message);
    quitting = true;
    app.quit();
  });
  server.listen(PORT, LISTEN_HOST);

  if (MAC && !app.isPackaged) app.dock?.setIcon(path.join(__dirname, 'icon.png')); // packaged app uses icon.icns
  createWindow();
  if (state.recording) ui('log', `Resumed the running take “${state.session}” after a restart`);
  updatePower();
});

// ---------- shutdown: never lose a clip that is still copying ----------
let quitting = false, asking = false;
function quitIssues() {
  const issues = [];
  if (uploadsInFlight) issues.push(`${uploadsInFlight} clip${uploadsInFlight > 1 ? 's are' : ' is'} still copying from the phones.`);
  if (state.recording) issues.push('A take is still recording. Press STOP first. If you quit anyway, the phones keep recording and Tally Hub picks the take up again when you reopen it.');
  return issues;
}
function confirmQuit() {
  if (asking) return;
  asking = true;
  const parent = win && !win.isDestroyed() ? win : undefined;
  const opts = {
    type: 'warning', buttons: ['Wait', 'Quit anyway'], defaultId: 0, cancelId: 0, title: 'Tally Hub',
    message: 'Quit now?', detail: `${quitIssues().join('\n')}\n\n"Wait" keeps Tally Hub open (copies get up to 10 s to finish, then it quits if nothing is recording).`,
  };
  (parent ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts)).then(({ response }) => {
    asking = false;
    if (response === 1) { quitting = true; return app.quit(); }
    if (state.recording) return; // stay open: the operator has to STOP first
    const until = Date.now() + 10000;
    const tick = () => {
      if (state.recording) return;
      if (!uploadsInFlight || Date.now() > until) { quitting = true; app.quit(); }
      else setTimeout(tick, 250);
    };
    tick();
  }).catch(() => { asking = false; });
}
app.on('before-quit', (e) => {
  if (quitting || !quitIssues().length) { quitting = true; return; }
  e.preventDefault(); // Cmd+Q / menu Quit while busy: same question as closing the window
  confirmQuit();
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  mtxQuitting = true;
  mtx?.kill();
  obs.disconnect().catch(() => {});
  clearInterval(logTimer);
  if (powerId != null) { try { powerSaveBlocker.stop(powerId); } catch {} powerId = null; }
  flog('quit');
  logStream?.end();
});
process.on('exit', () => mtx?.kill());
// The OS asking us to stop (logout, shutdown, Ctrl+C in a terminal) is not a question: quit straight away.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { quitting = true; app.quit(); });
