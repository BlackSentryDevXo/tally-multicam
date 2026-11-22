// Run: node src/layout.test.js
import assert from 'node:assert';
import { NAME_MIN, PILL_W, ROW_GAP, fitStatusPills } from './layout.js';

const all = ['timer', 'thermal', 'battery', 'left'];
const used = (keep) => NAME_MIN + keep.reduce((w, k) => w + PILL_W[k] + ROW_GAP, 0);

// Phone widths minus the 16pt side gutters the row actually gets.
for (const w of [320, 375, 390, 430]) {
  const row = w - 32;
  const keep = fitStatusPills(row, all);
  assert(used(keep) <= row || keep.length === 2, `${w}: ${keep} needs ${used(keep)} in ${row}`);
  assert(keep.includes('timer') && keep.includes('thermal'), `${w}: timer/thermal must survive`);
  for (let i = 1; i < keep.length; i++) assert(all.indexOf(keep[i - 1]) < all.indexOf(keep[i]), `${w}: order kept`);
}
assert.deepEqual(fitStatusPills(430 - 32, all), all, 'wide phones show everything');
assert.deepEqual(fitStatusPills(390 - 32, all), ['timer', 'thermal', 'battery'], '390: time-left dropped first');
assert.deepEqual(fitStatusPills(320 - 32, all), ['timer', 'thermal'], '320: battery dropped next');
assert.deepEqual(fitStatusPills(320 - 32, ['timer', 'battery', 'left']), ['timer', 'battery'], 'no thermal → battery fits');
assert.deepEqual(fitStatusPills(0, ['timer']), ['timer'], 'never drops below the essentials');
console.log('layout ok');
