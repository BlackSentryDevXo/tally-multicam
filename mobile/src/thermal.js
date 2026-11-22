// Phone heat, from the local native module modules/tally-thermal (built by another part of the project).
// Loaded optionally: Metro allows a missing module inside try/catch, so the app still runs without it.
// → { level: 0..3, label: 'nominal'|'fair'|'serious'|'critical', tempC: number|null, headroom: number|null } | null
let mod = null;
try {
  mod = require('../modules/tally-thermal');
} catch {}
const fn = mod?.getThermal ?? mod?.default?.getThermal;

export async function readThermal() {
  if (!fn) return null;
  try {
    const t = await fn();
    return t && typeof t.level === 'number' ? t : null;
  } catch {
    return null;
  }
}

export const thermalColor = (level, C) => (level >= 2 ? C.red : level >= 1 ? C.amber : C.dim);
export const thermalText = (t) =>
  t ? (t.tempC != null ? `${Math.round(t.tempC)}°` : { 0: 'OK', 1: 'WARM', 2: 'HOT', 3: 'CRIT' }[t.level]) : '';
