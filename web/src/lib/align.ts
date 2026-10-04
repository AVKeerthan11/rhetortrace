import type { Take } from "./types";

// The same point of the script in two deliveries. Both are force-aligned to the same words, so
// every word's start and end in this recording has a counterpart in each reference delivery
// (take.references[k].words). Between those knots time maps linearly, which covers pauses
// (a gap maps to the gap between the same two words). Exported alignments only.

interface Knots {
  take: number[];
  ref: number[];
}

const cache = new WeakMap<Take, Knots[]>();

function knots(take: Take, refIdx: number): Knots | null {
  let all = cache.get(take);
  if (!all) {
    all = take.references.map((r) => {
      const k: Knots = { take: [], ref: [] };
      take.words.forEach((w, i) => {
        const rw = r.words[i];
        if (!rw) return;
        for (const [a, b] of [[w.start, rw[0]], [w.end, rw[1]]] as const) {
          if (a === null || b === null) continue;
          // keep both series strictly increasing (alignments can touch or overlap by a frame)
          if (k.take.length && (a <= k.take[k.take.length - 1] || b <= k.ref[k.ref.length - 1])) continue;
          k.take.push(a);
          k.ref.push(b);
        }
      });
      return k;
    });
    cache.set(take, all);
  }
  const k = all[refIdx];
  return k && k.take.length >= 2 ? k : null;
}

function interp(xs: number[], ys: number[], x: number) {
  if (x <= xs[0]) return ys[0] + (x - xs[0]);
  const n = xs.length - 1;
  if (x >= xs[n]) return ys[n] + (x - xs[n]);
  let lo = 0, hi = n;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  return ys[lo] + ((x - xs[lo]) / (xs[hi] - xs[lo])) * (ys[hi] - ys[lo]);
}

/** Time in reference delivery refIdx at the point of the script this recording reaches at t. */
export function refTimeAt(take: Take, refIdx: number, t: number): number | null {
  const k = knots(take, refIdx);
  return k ? Math.max(0, interp(k.take, k.ref, t)) : null;
}

/** Inverse: time in this recording at the point of the script the reference reaches at rt. */
export function takeTimeAt(take: Take, refIdx: number, rt: number): number | null {
  const k = knots(take, refIdx);
  return k ? Math.min(take.duration, Math.max(0, interp(k.ref, k.take, rt))) : null;
}
