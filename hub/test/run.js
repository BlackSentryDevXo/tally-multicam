// Tally Hub integration test. Starts its own dev hub on test ports (never 7777), drives it with simulated phones,
// checks protocol, security and upload behaviour, then shuts it down.  Run: cd hub && npm test
// Uploads go to the real recordings folder under zz-test-* and are deleted at the end.
// Optional: TALLY_E2E_BIN=/path/to/encoder pushes a real H.264 SRT stream to check tile video (WHEP); skipped if unset.
const WebSocket = require('ws');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const HUB = path.join(__dirname, '..');
const PORT = 7787, API = 9987, SRT = 8891, WEBRTC = 8899, CDP = 9223;
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-hub-test-'));
const OUT = process.platform === 'darwin' ? path.join(os.homedir(), 'Movies', 'Tally') : path.join(os.homedir(), 'Videos', 'Tally');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (m) => console.log(`✓ ${m}`);
const settings = { res: 1080, fps: 30, lens: 'wide', zoom: 1, exposure: 0, torch: false, stabilization: false, hdr: false, codec: 'hevc' };
let key, readPass, publishPass, hub;

function startHub() {
  const env = { ...process.env, TALLY_TEST: '1', TALLY_PORT: PORT, TALLY_SRT_PORT: SRT, TALLY_MTX_API: API, TALLY_WEBRTC_PORT: WEBRTC,
    TALLY_ICE_PORT: 8199, TALLY_LISTEN_HOST: '127.0.0.1', TALLY_USER_DATA: userData, TALLY_UPLOAD_IDLE_MS: 3000 };
  delete env.ELECTRON_RUN_AS_NODE; // set by some editors' terminals; would run Electron as plain Node
  hub = spawn(require('electron'), ['.', `--remote-debugging-port=${CDP}`], { cwd: HUB, env, stdio: 'ignore' });
}
async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const v = await fn(); if (v) return v; } catch {} await sleep(250); }
  throw new Error(`timed out waiting for ${what}`);
}
const getJson = (url) => new Promise((res, rej) => http.get(url, (r) => { let s = ''; r.on('data', (c) => (s += c)); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } }); }).on('error', rej));

let cdp, cdpId = 0;
const pending = new Map();
async function cdpConnect() {
  const list = await waitFor(() => getJson(`http://127.0.0.1:${CDP}/json`).then((l) => l.find((p) => p.type === 'page' && /index\.html/.test(p.url)) && l), 20000, 'hub window');
  cdp = new WebSocket(list.find((p) => p.type === 'page' && /index\.html/.test(p.url)).webSocketDebuggerUrl);
  await new Promise((r) => cdp.on('open', r));
  cdp.on('message', (d) => { const m = JSON.parse(d); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
}
const evaluate = (expression) => new Promise((res, rej) => {
  const id = ++cdpId;
  pending.set(id, (m) => (m.result?.exceptionDetails ? rej(new Error(JSON.stringify(m.result.exceptionDetails))) : res(m.result?.result?.value)));
  cdp.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
});

class Phone {
  constructor(id, name, platform = 'ios') { this.id = id; this.name = name; this.platform = platform; this.msgs = []; this.closed = null; }
  open(status = {}, k = key) {
    return new Promise((res) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      this.ws.on('open', () => { this.ws.send(JSON.stringify({ t: 'hello', key: k, id: this.id, name: this.name, platform: this.platform, status: { battery: 0.8, free: 5e10, settings, lenses: ['wide'], session: '', ...status } })); res(); });
      this.ws.on('message', (d) => { try { this.msgs.push(JSON.parse(d)); } catch {} });
      this.ws.on('close', (c) => { this.closed = c; });
      this.ws.on('error', () => {});
    });
  }
  async next(t, timeout = 4000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const i = this.msgs.findIndex((m) => m.t === t);
      if (i >= 0) return this.msgs.splice(i, 1)[0];
      await sleep(25);
    }
    throw new Error(`timeout waiting for ${t} on ${this.name} (had: ${this.msgs.map((m) => m.t).join(',')})`);
  }
  async none(t, ms = 1500) { await sleep(ms); assert(!this.msgs.some((m) => m.t === t), `${this.name} unexpectedly got ${t}`); }
  send(m) { this.ws.send(typeof m === 'string' || Buffer.isBuffer(m) ? m : JSON.stringify(m)); }
  status(extra) { this.send({ t: 'status', battery: 0.8, free: 5e10, recording: false, settings, lenses: ['wide'], session: '', ...extra }); }
  end() { try { this.ws.close(); } catch {} }
}
const req = (method, p, { headers = {}, body } = {}, port = PORT) => new Promise((res, rej) => {
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (rs) => { let s = ''; rs.on('data', (c) => (s += c)); rs.on('end', () => res([rs.statusCode, s])); });
  r.on('error', rej);
  r.end(body);
});
const raw = (text) => new Promise((res) => {
  const s = net.connect(PORT, '127.0.0.1', () => s.write(text));
  let out = ''; s.on('data', (d) => (out += d)); s.on('close', () => res(out)); s.on('error', () => res(out));
  setTimeout(() => s.destroy(), 3000);
});
const basic = (u, p) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
const hubLog = () => { try { return fs.readFileSync(path.join(userData, 'hub.log'), 'utf8'); } catch { return ''; } };

async function main() {
  startHub();
  const cfg = await waitFor(() => JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8')), 20000, 'hub config');
  key = cfg.key;
  readPass = await waitFor(() => JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8')).mtxReadPass, 10000, 'read password');
  publishPass = crypto.createHmac('sha256', key).update('tally-srt-publish').digest('hex').slice(0, 24);
  await cdpConnect();
  await waitFor(() => raw('GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'), 10000, 'hub port');
  await evaluate(`Promise.all([hub.call('live','off'), hub.call('mains',60), hub.call('smooth',{smooth:true,smoothAndroid:false})])`);
  const silent = new WebSocket(`ws://127.0.0.1:${PORT}`); let silentClosed = null; const silentAt = Date.now();
  silent.on('close', () => { silentClosed = Date.now() - silentAt; }); silent.on('error', () => {});

  // Input hardening
  const r1 = await raw('GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
  assert(/^HTTP\/1\.1 400/.test(r1), `GET // → ${r1.slice(0, 40)}`); ok('GET // → 400');
  const pre = new Phone('pre', 'Pre');
  await new Promise((r) => { pre.ws = new WebSocket(`ws://127.0.0.1:${PORT}`); pre.ws.on('open', r); pre.ws.on('close', (c) => (pre.closed = c)); pre.ws.on('error', () => {}); });
  pre.ws.send('null'); pre.ws.send('[1,2]'); pre.ws.send('42'); pre.ws.send(JSON.stringify({ t: 'ping', t0: 1 }));
  await sleep(400); assert(!pre.msgs.length && pre.closed == null, 'pre-hello junk must be ignored');
  pre.ws.send(Buffer.from([1, 2, 3])); await sleep(400);
  assert(pre.closed != null, 'binary before hello must close the socket'); ok('before hello: junk ignored, binary closes the socket');
  const bad = new Phone('bad', 'Bad');
  await bad.open({}, 'wrong-key'); await sleep(500); assert.equal(bad.closed, 4003); ok('wrong pairing key rejected (4003)');

  const A = new Phone('camA', 'Cam A');
  await A.open(); await A.next('stream');
  A.send({ t: 'ping', t0: 5 });
  assert.equal((await A.next('pong')).t0, 5); ok('iPhone gets its monitor stream on hello; ping answered');
  const G = new Phone('camG', 'Cam G', 'android');
  await G.open(); assert.equal((await G.next('stream')).on, false); ok('Android is told no monitor stream by default');

  // MediaMTX lockdown
  let [st] = await req('GET', '/v3/paths/list', {}, API); assert.equal(st, 401);
  [st] = await req('GET', '/v3/paths/list', { headers: { authorization: basic('hubread', readPass) } }, API); assert.equal(st, 200);
  [st] = await req('PATCH', '/v3/config/global/patch', { headers: { 'content-type': 'application/json' }, body: '{"logLevel":"debug"}' }, API); assert.equal(st, 401);
  [st] = await req('GET', '/v3/paths/list', { headers: { authorization: basic('tally', publishPass) } }, API); assert.equal(st, 401);
  ok('MediaMTX API: anonymous 401, publish user 401, hub user 200');
  [st] = await req('POST', '/cam-camA/whep', { headers: { 'content-type': 'application/sdp' }, body: 'v=0' }, WEBRTC); assert.equal(st, 401);
  ok('WHEP without credentials: 401');

  if (process.env.TALLY_E2E_BIN) {
    A.status({ stream: { state: 'live', width: 1280, height: 720, fps: 30, kbps: 2500 }, preview: 'ok' });
    const enc = spawn(process.env.TALLY_E2E_BIN, [`srt://127.0.0.1:${SRT}?streamid=publish:cam-camA:tally:${publishPass}&latency=120`, 'main', 'off', '0', 'on', '25'], { stdio: 'ignore' });
    await waitFor(() => evaluate(`!!tiles.get('camA')?.rtcPlaying`), 20000, 'tile video');
    ok('tile plays the phone feed over WebRTC');
    enc.kill();
  } else console.log('- skipped tile video check (set TALLY_E2E_BIN to run it)');

  // Live presets and roles
  const streamWhere = async (p, test, ms = 4000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const m = await p.next('stream', ms); if (test(m)) return m; }
    throw new Error(`${p.name}: expected stream message not received`);
  };
  A.msgs = []; G.msgs = [];
  await evaluate(`hub.call('live','1080hfr')`);
  await streamWhere(A, (m) => m.on && m.role === 'live' && m.fps === 60);
  await streamWhere(G, (m) => m.on && m.role === 'live');
  await evaluate(`hub.call('live','off')`);
  await streamWhere(A, (m) => m.on && m.role === 'monitor');
  await streamWhere(G, (m) => m.on === false);
  ok('LIVE on → both phones live; LIVE off → iPhone back to monitor, Android off');

  // Reconnect stop rules
  const S = new Phone('camS', 'Standalone');
  await S.open({ recording: true, session: '' }); await S.none('stop'); S.end();
  const S2 = new Phone('camS2', 'Standalone2');
  await S2.open({ recording: true, session: 'standalone_2026-01-01_0915' }); await S2.none('stop'); S2.end();
  ok('standalone takes are never stopped by reconnecting');
  let s = await evaluate(`hub.call('record','zz-test stale')`);
  const staleSession = s.session; await A.next('record'); await sleep(1700);
  await evaluate(`hub.call('stop')`); await A.next('stop');
  const T = new Phone('camT', 'Late');
  await T.open({ recording: true, session: staleSession }); await T.next('stop', 3000); T.end();
  ok('a phone still on a finished hub take is stopped when it reconnects');
  s = await evaluate(`hub.call('record','zz-test current')`); const cur = s.session; await A.next('record'); await sleep(1700);
  const C = new Phone('camC', 'Current');
  await C.open({ recording: true, session: cur }); await C.none('stop');
  ok('a phone on the current take keeps recording when it reconnects');
  C.status({ recording: true, session: cur }); await sleep(300); C.msgs = [];
  await evaluate(`hub.call('close','camC')`);
  await C.next('stop'); await C.next('close'); ok('Close camera on a recording phone: stop, then close');
  await evaluate(`hub.call('stop')`); await A.next('stop');

  // Uploads
  const sess = 'zz-test-upload', dir = path.join(OUT, sess);
  const up = (name, body) => req('POST', `/upload?key=${key}&session=${sess}&cam=${encodeURIComponent(name)}&id=camA&ext=mp4`, { headers: { 'content-length': body.length }, body });
  const [u1, u2] = await Promise.all([up('Pastor', Buffer.alloc(800_000, 1)), up('Pastor', Buffer.alloc(900_000, 2))]);
  assert.equal(u1[0], 200); assert.equal(u2[0], 200);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['Pastor-2.mp4', 'Pastor.mp4']);
  ok('two uploads with the same camera name → Pastor.mp4 + Pastor-2.mp4');
  [st] = await req('POST', `/upload?key=nope&session=${sess}&cam=X&id=camA&ext=mp4`, { headers: { 'content-length': 3 }, body: 'abc' });
  assert.equal(st, 403); ok('upload with the wrong key → 403');
  const t0 = Date.now();
  await new Promise((res) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, method: 'POST', path: `/upload?key=${key}&session=${sess}&cam=Stall&id=camA&ext=mp4`, headers: { 'content-length': 5_000_000 } }, () => res());
    r.on('error', () => res());
    r.write(Buffer.alloc(200_000, 3));
  });
  await sleep(500);
  assert(!fs.readdirSync(dir).some((f) => /^Stall/.test(f)), 'stalled upload leftovers');
  ok(`stalled upload dropped after ${((Date.now() - t0) / 1000).toFixed(1)} s, partial file removed`);
  fs.rmSync(dir, { recursive: true, force: true });

  for (let i = 0; i < 30 && silentClosed == null; i++) await sleep(500);
  assert(silentClosed != null && silentClosed >= 9000 && silentClosed < 13000, `silent socket closed after ${silentClosed} ms`);
  ok('a socket that never says hello is dropped after 10 s');
  assert(!/uncaught|unhandled|Internal error/.test(hubLog()), 'hub.log has internal errors');
  ok('no internal errors in hub.log');
  [A, G].forEach((p) => p.end());
  console.log('\nALL PASSED');
}

function cleanup(code) {
  try { cdp?.close(); } catch {}
  try { hub?.kill(); } catch {}
  // The dev hub's MediaMTX runs from hub/bin; stop it too (an installed Tally Hub's copy lives elsewhere and is untouched).
  if (process.platform !== 'win32') spawn('pkill', ['-f', path.join(HUB, 'bin')], { stdio: 'ignore' });
  for (const d of fs.existsSync(OUT) ? fs.readdirSync(OUT) : []) if (/^\d{4}-\d{2}-\d{2}_zz-test/.test(d) || d.startsWith('zz-test')) fs.rmSync(path.join(OUT, d), { recursive: true, force: true });
  setTimeout(() => { fs.rmSync(userData, { recursive: true, force: true }); process.exit(code); }, 1500);
}
main().then(() => cleanup(0)).catch((e) => { console.error('FAIL', e); cleanup(1); });
