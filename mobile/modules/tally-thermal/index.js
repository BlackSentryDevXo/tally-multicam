import { requireOptionalNativeModule } from 'expo';

const Native = requireOptionalNativeModule('TallyThermal');
const LABELS = ['nominal', 'fair', 'serious', 'critical'];

/**
 * Current device thermal state.
 * @returns {{ level: 0|1|2|3, label: 'nominal'|'fair'|'serious'|'critical', tempC: number|null, headroom: number|null }}
 *   level/label: OS thermal pressure. tempC: battery temperature (Android only, null on iOS).
 *   headroom: Android 11+ forecast (1.0 = throttling imminent), null elsewhere.
 * Returns a nominal reading if the native module isn't linked (e.g. Expo Go), so callers never crash.
 */
export function getThermal() {
  const r = Native?.getThermal?.() ?? { level: 0, tempC: null, headroom: null };
  const level = Math.max(0, Math.min(3, r.level | 0));
  return { level, label: LABELS[level], tempC: r.tempC ?? null, headroom: r.headroom ?? null };
}

export const isAvailable = !!Native;
