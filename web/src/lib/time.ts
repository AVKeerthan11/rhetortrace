import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { player, type Player } from "./player";
import type { Take } from "./types";

// The shared time model of a recording. Two clocks drive every time-aware surface:
//  · the playhead (player.time): what is audible
//  · the cursor (cursor.t): the instant the user points at, from any surface (the stage, a
//    transcript word, the keyboard). It is a preview: it never moves the audio by itself.
// The "focus" time is cursor ?? playhead: what readouts show.
//
// Both clocks change up to once per frame, so components must not re-render on every change.
// Two ways to listen:
//  · useTimeSelect(clock, t => value): re-renders only when the selected value changes
//    (e.g. the index of the word under the playhead changes ~3×/s, not 60×/s)
//  · useTimeEffect(clock, t => { el.style... }): imperative, no re-render at all (playheads)

type Listener = () => void;

export type CursorSource = "stage" | "scrub" | "text" | "key";

class TimeCursor {
  t: number | null = null;
  source: CursorSource | null = null;
  private listeners = new Set<Listener>();
  subscribe = (fn: Listener) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  set(t: number, source: CursorSource) {
    if (this.t === t && this.source === source) return;
    this.t = t;
    this.source = source;
    this.listeners.forEach((fn) => fn());
  }
  /** Clear the cursor; with a source, only if that source owns it (a late "leave" from one
   *  surface must not erase what another surface just set). */
  clear(source?: CursorSource) {
    if (this.t === null || (source && this.source !== source)) return;
    this.t = null;
    this.source = null;
    this.listeners.forEach((fn) => fn());
  }
}

export const cursor = new TimeCursor();

export type Clock = "playhead" | "cursor" | "focus";

function read(clock: Clock, p: Player): number | null {
  if (clock === "playhead") return p.time;
  if (clock === "cursor") return cursor.t;
  return cursor.t ?? p.time;
}

function subscribe(clock: Clock, p: Player, fn: Listener) {
  const a = clock !== "cursor" ? p.subscribe(fn) : null;
  const b = clock !== "playhead" ? cursor.subscribe(fn) : null;
  return () => {
    a?.();
    b?.();
  };
}

/** Re-render only when select(time) changes. select must return a primitive. */
export function useTimeSelect<T extends string | number | boolean | null>(clock: Clock, select: (t: number | null) => T, p: Player = player): T {
  const sub = useCallback((fn: Listener) => subscribe(clock, p, fn), [clock, p]);
  return useSyncExternalStore(sub, () => select(read(clock, p)));
}

/** Run an imperative callback on every change of a clock (and once now), without re-rendering. */
export function useTimeEffect(clock: Clock, effect: (t: number | null) => void, deps: unknown[], p: Player = player) {
  const fx = useRef(effect);
  useLayoutEffect(() => {
    fx.current = effect;
  });
  useEffect(() => {
    const run = () => fx.current(read(clock, p));
    run();
    return subscribe(clock, p, run);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clock, p, ...deps]);
}

// ------------------------------------------------------------------ words in time

export interface WordTimes {
  /** word indices that have timings, in time order */
  order: number[];
  starts: number[];
  ends: number[];
  /** per word index: start of the next timed word (for gaps), or null */
  nextStart: (number | null)[];
}

const cache = new WeakMap<Take, WordTimes>();

/** Timing index of a take's words, computed once per take. */
export function wordTimes(take: Take): WordTimes {
  let wt = cache.get(take);
  if (wt) return wt;
  const order: number[] = [], starts: number[] = [], ends: number[] = [];
  take.words.forEach((w, i) => {
    if (w.start === null || w.end === null) return;
    order.push(i);
    starts.push(w.start);
    ends.push(w.end);
  });
  const nextStart: (number | null)[] = new Array(take.words.length).fill(null);
  let next: number | null = null;
  for (let i = take.words.length - 1; i >= 0; i--) {
    nextStart[i] = next;
    const s = take.words[i].start;
    if (s !== null) next = s;
  }
  wt = { order, starts, ends, nextStart };
  cache.set(take, wt);
  return wt;
}

/** Position in wt.order of the last word starting at or before t (-1 before the first word). */
function lastStartAtOrBefore(wt: WordTimes, t: number) {
  let lo = 0, hi = wt.starts.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (wt.starts[mid] <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** Index of the word being spoken at t, or -1 in silence. */
export function wordAt(take: Take, t: number | null): number {
  if (t === null) return -1;
  const wt = wordTimes(take);
  const k = lastStartAtOrBefore(wt, t);
  return k >= 0 && t < wt.ends[k] ? wt.order[k] : -1;
}

/** Index of the word at t, or the last one before it (pauses belong to the word before). */
export function wordNear(take: Take, t: number | null): number {
  if (t === null) return -1;
  const wt = wordTimes(take);
  const k = lastStartAtOrBefore(wt, t);
  return k >= 0 ? wt.order[k] : wt.order[0] ?? -1;
}

/** Start time of the next (dir 1) or previous (dir -1) word relative to t. */
export function stepWord(take: Take, t: number, dir: 1 | -1): number | null {
  const wt = wordTimes(take);
  if (!wt.starts.length) return null;
  const k = lastStartAtOrBefore(wt, t + 1e-3);
  if (dir === 1) return wt.starts[Math.min(wt.starts.length - 1, k + 1)];
  // previous: back to this word's start if well into it, else the word before
  if (k >= 0 && t - wt.starts[k] > 0.25) return wt.starts[k];
  return wt.starts[Math.max(0, k - 1)];
}

/** Flaw index whose span contains t (the most severe if several), or -1. */
export function findingAt(take: Take, t: number | null): number {
  if (t === null) return -1;
  let best = -1;
  take.flaws.forEach((f, i) => {
    if (t >= f.start && t <= f.end && (best < 0 || f.severity.score > take.flaws[best].severity.score)) best = i;
  });
  return best;
}

/** The playing word and the pointed-at word, re-rendering only when either changes. */
export function useWordFocus(take: Take): { playing: number; pointed: number } {
  const playing = useTimeSelect("playhead", (t) => wordAt(take, t));
  const pointed = useTimeSelect("cursor", (t) => wordNear(take, t));
  return { playing, pointed };
}
