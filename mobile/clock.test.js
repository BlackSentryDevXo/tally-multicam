// Run: node clock.test.js
import assert from 'node:assert';
import { computeOffset, waitUntil, srtLatency } from './clock.js';

const OFFSET = 5000;
const samples = [];
for (let i = 0, t = 1e6; i < 16; i++, t += 1000) {
  const up = i % 4 === 0 ? 150 : 4 + (i % 3); // every 4th ping hits a 150 ms Wi-Fi stall on the way up
  const down = 4 + ((i + 1) % 3);
  samples.push({ t0: t, hubT: t + up + OFFSET, t1: t + up + down });
}
const est = computeOffset(samples);
assert(Math.abs(est - OFFSET) <= 2, `offset off by ${est - OFFSET} ms`);
assert.equal(computeOffset([{ t0: 0, t1: 10, hubT: 105 }]), 100);

const target = Date.now() + 60;
await waitUntil(target);
const late = Date.now() - target;
assert(late >= 0 && late <= 2, `waitUntil late by ${late} ms`);

const rt = (ms) => Array.from({ length: 10 }, (_, i) => ({ t0: 0, t1: i === 9 ? ms * 3 : ms }));
assert.equal(srtLatency([]), 120); // not measured yet
assert.equal(srtLatency(rt(5)), 120); // clean LAN: floor
assert.equal(srtLatency(rt(30)), 120); // the median ignores the one 90 ms spike
assert.equal(srtLatency(rt(80)), 250); // slow link: cap
console.log(`clock ok (offset error ${est - OFFSET} ms, wait error ${late} ms)`);
