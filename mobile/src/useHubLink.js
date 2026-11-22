import { useEffect, useRef, useState } from 'react';
import { Alert, Platform } from 'react-native';
import { File, UploadType } from 'expo-file-system';
import { Asset } from 'expo-media-library';
import { computeOffset } from '../clock';
import { clipName, clipsDir, fileUri, jobIsForHub, sentDir, sessionFromClip } from './config';
import { candidates } from './pairing';

// A clip that fails to copy waits before its next try, so it never blocks the others: 5 s, 30 s, 2 min, then 5 min.
const UPLOAD_BACKOFF_MS = [5000, 30000, 120000, 300000];
const UPLOAD_RETRY_TICK_MS = 5000;
const plain = (uri) => decodeURI(String(uri).replace(/^file:\/\//, ''));
const inClipsDir = (path) => plain(path).startsWith(`${plain(clipsDir.uri).replace(/\/$/, '')}/`);

// After the hub confirms a clip, move it into Tally/sent/ (never deleted). Only clips in our own folder move;
// anything else (older temp paths) is left where it is.
function moveToSent(path) {
  try {
    if (!inClipsDir(path)) return;
    const f = new File(fileUri(path));
    if (!f.exists) return;
    if (!sentDir.exists) sentDir.create({ intermediates: true, idempotent: true });
    const dest = new File(sentDir, clipName(path));
    if (dest.exists) return; // never overwrite; the clip simply stays where it is
    f.moveSync(dest);
  } catch (e) {
    console.warn('move to sent/ failed', e);
  }
}

/**
 * Connection to Tally Hub: WebSocket with auto-reconnect, clock sync, status heartbeat and the clip upload queue.
 *
 * cfgRef/commit: the config source of truth (commit persists and re-renders).
 * handlers.current = { onMessage(m), getStatus(): Promise<object>, isBusy(): boolean, onForget() }, read through a ref.
 *
 * Hub control messages handled here: `close` (hub closed this camera: stop reconnecting until the user taps
 * Reconnect) and `forget` (clear the pairing; deferred until a running take is saved; clips are never deleted).
 */
export function useHubLink({ cfgRef, commit, handlers }) {
  const ws = useRef(null);
  const samples = useRef([]);
  const offset = useRef(0); // hubTime = Date.now() + offset
  const rejected = useRef(false); // hub refused our key during a take: re-pair once the take is saved
  const forgetLater = useRef(false); // hub said forget during a take: do it once the take is saved
  // The hub closed this camera. While a take is running we keep reconnecting quietly (so the hub's stop can
  // still reach us) and only close for good once the take is saved (see takeEnded).
  const closedByHub = useRef(false);
  const closeLater = useRef(false);
  const actions = useRef({}); // { attempt } from the live connection effect, for reconnect()
  const [online, setOnline] = useState(false);
  // 'searching' | 'online' | 'unreachable' (8 s+) | 'rejected' | 'closed' (by the hub; user taps Reconnect)
  const [state, setState] = useState('searching');
  const c0 = cfgRef.current;
  const key = c0.key;
  // Reconnect only when the set of addresses changes, not when the winning address is remembered.
  const candKey = c0.hosts?.length ? `${c0.hosts.join(',')}:${c0.port || 7777}` : c0.host || '';

  const send = (m) => {
    if (ws.current?.readyState !== 1) return false;
    ws.current.send(JSON.stringify(m));
    return true;
  };
  const sendBinary = (buf) => ws.current?.readyState === 1 && ws.current.send(buf);
  const report = (message) => { const m = String(message).slice(0, 500); console.warn(m); send({ t: 'error', message: m }); };
  const pushStatus = () => handlers.current.getStatus().then(send).catch(() => {});

  // Copy finished clips to the hub, oldest first. A clip leaves the queue only after the hub confirms it, and is
  // then moved to Tally/sent/ (never deleted; the gallery backup stays too). A clip that fails goes to the back
  // of the queue with a backoff, so one bad clip never blocks the rest. Clips recorded for another hub (a
  // previous pairing) stay queued untouched until that hub is paired again.
  const uploading = useRef(false);
  async function flush() {
    if (uploading.current) return;
    uploading.current = true;
    try {
      for (;;) {
        const c = cfgRef.current;
        if (!ws.current) break;
        const now = Date.now();
        const job = (c.pending || []).find((j) => jobIsForHub(j, c.key) && !(j.nextAt > now));
        if (!job) break;
        const f = new File(fileUri(job.path));
        if (!f.exists) {
          report(`clip missing, skipped: ${job.path}`);
          commit({ ...cfgRef.current, pending: (cfgRef.current.pending || []).filter((p) => p.path !== job.path) });
          continue;
        }
        try {
          const q = new URLSearchParams({ key: c.key, session: job.session, cam: c.name, id: c.id, ext: job.ext });
          const r = await f.upload(`http://${c.host}/upload?${q}`, {
            httpMethod: 'POST',
            uploadType: UploadType.BINARY_CONTENT,
            mimeType: job.ext === 'mov' ? 'video/quicktime' : 'video/mp4',
          });
          if (r.status !== 200) throw new Error(`hub replied ${r.status} ${r.body}`);
        } catch (e) {
          const attempts = (job.attempts || 0) + 1;
          const wait = UPLOAD_BACKOFF_MS[Math.min(attempts - 1, UPLOAD_BACKOFF_MS.length - 1)];
          report(`upload of ${clipName(job.path)} failed (try ${attempts}), retrying in ${Math.round(wait / 1000)} s: ${e.message}`);
          const cur = cfgRef.current;
          const rest = (cur.pending || []).filter((p) => p.path !== job.path);
          commit({ ...cur, pending: [...rest, { ...job, attempts, nextAt: Date.now() + wait }] });
          continue;
        }
        const cur = cfgRef.current;
        commit({ ...cur, pending: (cur.pending || []).filter((p) => p.path !== job.path) });
        moveToSent(job.path);
      }
    } finally {
      uploading.current = false;
    }
  }

  // A finished recording: gallery backup first (data safety), then queue for the hub it was recorded for.
  async function enqueue(path, session, hubKey = cfgRef.current.key) {
    if (cfgRef.current.pending?.some((p) => p.path === path)) return;
    try { await Asset.create(fileUri(path)); } catch (e) { report(`gallery backup failed: ${e.message}`); }
    const job = { path, session, ext: path.toLowerCase().endsWith('.mov') ? 'mov' : 'mp4', hubKey: hubKey || null };
    commit({ ...cfgRef.current, pending: [...(cfgRef.current.pending || []), job] });
    flush();
  }

  // Crash / kill recovery: any clip in the recordings folder that is neither queued nor already copied
  // goes back in the queue. A clip cut off mid-take may be incomplete, but it's never silently lost.
  useEffect(() => {
    try {
      if (!clipsDir.exists) return;
      const c = cfgRef.current;
      // One-time migration: clips the old builds recorded as copied (the `uploaded` name list) move to sent/.
      if (c.uploaded?.length) {
        const base = plain(clipsDir.uri).replace(/\/$/, '');
        for (const name of c.uploaded) moveToSent(`${base}/${name}`);
        const { uploaded: _uploaded, ...rest } = cfgRef.current;
        commit(rest);
      }
      const queued = new Set((cfgRef.current.pending || []).map((p) => clipName(p.path)));
      // Only the top level: sent/ (and any other folder) is never re-queued.
      for (const rec of clipsDir.listAsRecords()) {
        if (rec.isDirectory) continue;
        const name = clipName(rec.uri);
        if (!/\.(mov|mp4)$/i.test(name) || queued.has(name)) continue;
        const f = new File(rec.uri);
        if (!f.exists || !f.size) continue;
        enqueue(decodeURI(rec.uri.replace(/^file:\/\//, '')), sessionFromClip(name));
      }
    } catch (e) {
      console.warn('clip recovery failed', e);
    }
  }, []);

  function rejectNow() {
    rejected.current = false;
    Alert.alert('Hub rejected this camera', 'Tally Hub was found, but its pairing key changed. Scan the QR code in Tally Hub again.');
    commit({ ...cfgRef.current, host: null });
  }
  // Clear the pairing but keep everything recorded: queued clips stay, tagged with the hub they belong to.
  function forgetNow() {
    forgetLater.current = false;
    const c = cfgRef.current;
    commit({ ...c, host: null, hosts: [], key: null, hubName: null, previousHubKey: c.key || c.previousHubKey || null });
    handlers.current.onForget?.();
  }

  // Try every candidate address in parallel (Mac .local name + each LAN IP); the first to connect wins.
  useEffect(() => {
    if (!candKey) return;
    closedByHub.current = false; // a new pairing / address set starts fresh
    let closed = false, retry = 0, pinger, statusTimer, flushTimer, retryTimer, searchTimer, socks = [];
    const searching = () => {
      setState((st) => (st === 'unreachable' ? st : 'searching'));
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { if (!ws.current && !closed) setState('unreachable'); }, 8000);
    };
    const scheduleRetry = () => {
      if (closed || closedByHub.current) return;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(attempt, Math.min(8000, 500 * 2 ** retry++));
    };

    function adopt(sock, addr) {
      ws.current = sock;
      retry = 0;
      clearTimeout(searchTimer);
      samples.current = [];
      if (addr !== cfgRef.current.host) commit({ ...cfgRef.current, host: addr }); // remember the winner (also used for uploads)
      const ping = () => sock.readyState === 1 && sock.send(JSON.stringify({ t: 'ping', t0: Date.now() }));
      sock.onmessage = (e) => {
        if (typeof e.data !== 'string') return;
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.t === 'pong') {
          const list = samples.current;
          list.push({ t0: m.t0, t1: Date.now(), hubT: m.hubT });
          if (list.length > 16) list.shift();
          offset.current = computeOffset(list);
          return;
        }
        if (m.t === 'close') { // the hub closed this camera: no auto-reconnect until the user asks
          handlers.current.onClose?.(); // stop publishing the live feed to it
          if (handlers.current.isBusy?.()) {
            closeLater.current = true; // finish the take first; keep the link so the hub's stop still arrives
          } else {
            closedByHub.current = true;
            try { sock.close(); } catch {}
          }
          return;
        }
        if (m.t === 'forget') {
          if (handlers.current.isBusy?.()) forgetLater.current = true; // never tear down the camera mid-take
          else forgetNow();
          return;
        }
        handlers.current.onMessage(m);
      };
      sock.onclose = (e) => {
        if (ws.current === sock) ws.current = null;
        setOnline(false);
        clearInterval(pinger);
        clearInterval(statusTimer);
        clearInterval(flushTimer);
        if (closedByHub.current) { setState('closed'); return; } // uploads resume when the user reconnects
        if (e.code === 4003) {
          closed = true; // a wrong key won't fix itself: stop retrying
          setState('rejected');
          // Never tear down the camera mid-take: re-pair after the clip is saved (see takeEnded).
          if (handlers.current.isBusy?.()) rejected.current = true;
          else rejectNow();
          return;
        }
        searching();
        scheduleRetry();
      };
      (async () => {
        const c = cfgRef.current;
        const status = await handlers.current.getStatus({ forHello: true }).catch(() => ({}));
        if (sock.readyState !== 1) return;
        sock.send(JSON.stringify({ t: 'hello', key: c.key, id: c.id, name: c.name, platform: Platform.OS, status }));
        setOnline(true);
        setState('online');
        for (let i = 0; i < 8; i++) setTimeout(ping, i * 120);
        pinger = setInterval(ping, 10000);
        statusTimer = setInterval(pushStatus, 2000);
        flushTimer = setInterval(flush, UPLOAD_RETRY_TICK_MS); // retries backed-off clips while connected
        flush();
      })();
    }

    function attempt() {
      if (closed || closedByHub.current) return;
      const list = candidates(cfgRef.current);
      let won = false, failed = 0;
      socks = list.map((addr) => {
        const sock = new WebSocket(`ws://${addr}`);
        sock.onopen = () => {
          if (won || closed) { sock.close(); return; }
          won = true;
          socks.forEach((o) => o !== sock && o.close());
          adopt(sock, addr);
        };
        sock.onerror = () => {};
        sock.onclose = () => { if (!won && ++failed === list.length) scheduleRetry(); };
        return sock;
      });
      if (!list.length) scheduleRetry();
    }
    actions.current = {
      attempt: () => { closedByHub.current = false; if (!ws.current) { retry = 0; searching(); attempt(); } },
      closeForGood: () => {
        closedByHub.current = true;
        clearTimeout(retryTimer);
        clearTimeout(searchTimer);
        if (ws.current) { try { ws.current.close(); } catch {} } else setState('closed');
      },
    };

    searching();
    attempt();
    return () => {
      closed = true;
      actions.current = {};
      clearTimeout(retryTimer);
      clearTimeout(searchTimer);
      clearInterval(pinger);
      clearInterval(statusTimer);
      clearInterval(flushTimer);
      socks.forEach((o) => { try { o.close(); } catch {} });
      ws.current?.close();
    };
  }, [candKey, key]);

  return {
    online,
    state,
    send,
    sendBinary,
    report,
    pushStatus,
    enqueue,
    reconnect: () => actions.current.attempt?.(),
    takeEnded: () => {
      if (rejected.current) rejectNow();
      else if (forgetLater.current) forgetNow();
      else if (closeLater.current) {
        // The take is saved and queued; let the queue copy it before closing (bounded), then close for good.
        closeLater.current = false;
        const done = Date.now() + 120000;
        const tick = () => {
          const left = (cfgRef.current.pending || []).some((j) => jobIsForHub(j, cfgRef.current.key) && !(j.nextAt > Date.now()));
          if ((left || uploading.current) && ws.current && Date.now() < done) { flush(); setTimeout(tick, 1000); return; }
          actions.current.closeForGood?.();
        };
        setTimeout(tick, 500);
      }
    },
    isOpen: () => ws.current?.readyState === 1,
    toLocal: (hubMs) => hubMs - offset.current,
  };
}
