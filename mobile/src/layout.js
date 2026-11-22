// Pure layout math (no React Native imports) so it can be unit-tested with plain node.

// Status row: [name chip (shrinks, min NAME_MIN)] [gap] [fixed-width pills…]. Pills never overlap: when the
// row is too narrow, the lowest-priority pills are dropped (time-left first, then battery). The timer and a
// thermal warning always stay. Widths are in pt (measured with the 12-13pt tabular fonts the row uses).
export const NAME_MIN = 96;
export const ROW_GAP = 8;
export const PILL_W = { timer: 80, thermal: 56, battery: 54, left: 66, live: 44 };
const PRIORITY = ['live', 'timer', 'thermal', 'battery', 'left']; // keep order; drop from the end

export function fitStatusPills(rowWidth, wanted) {
  const keep = PRIORITY.filter((k) => wanted.includes(k));
  const width = (list) => list.reduce((w, k) => w + PILL_W[k] + ROW_GAP, 0);
  while (keep.length > 2 && NAME_MIN + width(keep) > rowWidth) {
    const i = Math.max(keep.lastIndexOf('left'), keep.lastIndexOf('battery'));
    if (i < 0) break;
    keep.splice(i, 1);
  }
  return keep;
}
