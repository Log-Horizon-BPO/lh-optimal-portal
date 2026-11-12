// @ts-check
/**
 * Small, exact interval algebra over [start, end) ranges in epoch ms.
 * Used to turn a stream of status events into billable time.
 * @typedef {{ start: number, end: number }} Interval
 */

/**
 * Drop empty/invalid ranges and sort by start.
 * @param {Interval[]} xs
 * @returns {Interval[]}
 */
function clean(xs) {
  return xs.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
}

/**
 * Merge overlapping/adjacent intervals.
 * @param {Interval[]} xs
 * @returns {Interval[]}
 */
export function merge(xs) {
  const sorted = clean(xs);
  /** @type {Interval[]} */
  const out = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) {
      last.end = Math.max(last.end, i.end);
    } else {
      out.push({ ...i });
    }
  }
  return out;
}

/**
 * Clip every interval to the window [start, end).
 * @param {Interval[]} xs
 * @param {Interval} window
 * @returns {Interval[]}
 */
export function clip(xs, window) {
  return clean(
    xs.map((i) => ({
      start: Math.max(i.start, window.start),
      end: Math.min(i.end, window.end),
    })),
  );
}

/**
 * a minus b (remove any time covered by b from a).
 * @param {Interval[]} a
 * @param {Interval[]} b
 * @returns {Interval[]}
 */
export function subtract(a, b) {
  const holes = merge(b);
  /** @type {Interval[]} */
  let result = merge(a);
  for (const h of holes) {
    /** @type {Interval[]} */
    const next = [];
    for (const i of result) {
      if (h.end <= i.start || h.start >= i.end) {
        next.push(i); // no overlap
        continue;
      }
      if (h.start > i.start) next.push({ start: i.start, end: h.start });
      if (h.end < i.end) next.push({ start: h.end, end: i.end });
    }
    result = next;
  }
  return clean(result);
}

/**
 * Total duration in ms.
 * @param {Interval[]} xs
 * @returns {number}
 */
export function totalMs(xs) {
  return merge(xs).reduce((sum, i) => sum + (i.end - i.start), 0);
}
