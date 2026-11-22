// Pure helpers (no React Native imports) so they can be tested with plain node.

// tally://<host1>,<host2>,...:<port>?key=<key>&name=<hubName>   (a single "host:port" still works)
export function parsePairUrl(text) {
  const m = /^tally:\/\/([^?\s]+)\?(\S*)$/.exec(String(text || '').trim());
  if (!m) return null;
  let hostsPart = m[1];
  let port = 7777;
  const pm = /:(\d{2,5})$/.exec(hostsPart);
  if (pm) { port = +pm[1]; hostsPart = hostsPart.slice(0, pm.index); }
  const hosts = [...new Set(hostsPart.split(',').map((h) => h.trim()).filter((h) => /^[\w.-]+$/.test(h)))];
  const q = {};
  for (const kv of m[2].split('&')) {
    const i = kv.indexOf('=');
    if (i > 0) { try { q[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' ')); } catch {} }
  }
  if (!hosts.length || !/^\w{4,}$/.test(q.key || '') || port < 1 || port > 65535) return null;
  return { hosts, port, key: q.key, hubName: (q.name || '').slice(0, 40) || null };
}

// Every address worth trying, last winner first.
export function candidates(cfg) {
  const port = cfg?.port || 7777;
  const list = [cfg?.host, ...(cfg?.hosts || []).map((h) => `${h}:${port}`)].filter(Boolean);
  return [...new Set(list)];
}

// Light flicker: under mains lighting at f Hz, light pulses at 2f. A shutter is flicker-free when it spans
// a whole number of pulses (1/50, 1/100 at 50 Hz; 1/60, 1/120 at 60 Hz).
export function shutterFlickers(sec, mains) {
  if (!sec) return false;
  const pulses = sec * 2 * mains;
  return pulses < 0.97 || Math.abs(pulses - Math.round(pulses)) > 0.03;
}
// Frame rates that beat against the mains (e.g. 30/60 fps under 50 Hz lights).
export const fpsBeats = (fps, mains) => (mains === 50 ? [30, 60].includes(fps) : [25, 50].includes(fps));
export const shutterAngle = (sec, fps) => Math.round(sec * fps * 360);
