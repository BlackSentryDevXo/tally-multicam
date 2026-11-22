// Clock sync with the hub. offset is such that hubTime ≈ Date.now() + offset.
// Each sample: t0 = local send time, t1 = local receive time, hubT = hub time in the reply.
export function computeOffset(samples) {
  // Lowest round-trip samples are the least skewed by Wi-Fi jitter; take the median of those.
  const best = [...samples]
    .sort((a, b) => a.t1 - a.t0 - (b.t1 - b.t0))
    .slice(0, Math.ceil(samples.length / 2));
  const offs = best.map((s) => s.hubT - (s.t0 + s.t1) / 2).sort((a, b) => a - b);
  const m = offs.length >> 1;
  return offs.length % 2 ? offs[m] : (offs[m - 1] + offs[m]) / 2;
}

// Resolve at local time `at` (ms). Sleeps most of the way, spins the last ~20 ms for accuracy.
export async function waitUntil(at) {
  const lead = at - Date.now() - 20;
  if (lead > 0) await new Promise((r) => setTimeout(r, lead));
  while (Date.now() < at) {} // ponytail: busy-wait blocks JS for ≤20 ms, fine before a record start
}

// SRT receive buffer for the live feed, sized from the measured link: ~4× the typical (median) round trip, as SRT
// recommends, so a clean LAN gets the minimum delay and a busy Wi-Fi keeps enough room to retransmit.
// Median, not p90: these are JS-timed pings, whose slow end is app scheduling, not the network.
// ponytail: fixed at connect; re-measure mid-stream only if links change a lot during a service.
export function srtLatency(samples) {
  if (samples.length < 4) return 120;
  const rtts = samples.map((s) => s.t1 - s.t0).sort((a, b) => a - b);
  const mid = rtts[rtts.length >> 1];
  // Floor 120 ms: at 60 ms a busy Wi-Fi (15–45 ms RTT) lost ~2 packets/s for good; at 120 ms none.
  return Math.min(250, Math.max(120, Math.round(mid * 4)));
}
