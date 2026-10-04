import { create } from "zustand";
import { animate, type AnimationPlaybackControls } from "motion";
import { duration as durations, ease, prefersReducedMotion } from "@/lib/motion";
import type { Flaw } from "@/lib/types";

// State of the recording stage, shared by every screen of one recording (overview, finding,
// explorer). It outlives route changes, so the camera, the hovered finding and the chosen
// reference delivery carry over when the user moves between zoom levels.

export type View = [number, number];
/** Zoom levels of one recording: the whole recording, one moment, every measurement. */
export type Level = "overview" | "finding" | "explore";
export const LEVEL_ORDER: Record<Level, number> = { overview: 0, finding: 1, explore: 2 };

const MIN_SPAN = 0.8;

interface StageState {
  takeId: string | null;
  duration: number;
  /** visible time window, seconds */
  view: View;
  /** flaw index under the pointer anywhere (linked highlighting) */
  hovered: number | null;
  /** flaw index selected in the explorer (its summary sheet) */
  selected: number | null;
  /** reference delivery used for comparisons */
  refIdx: number;
  /** last finding number visited (the "Finding" tab returns to it) */
  lastRank: number;
  reset: (takeId: string, duration: number) => void;
  setView: (v: View, opts?: { smooth?: boolean; seconds?: number; curve?: readonly number[] }) => void;
  zoom: (factor: number, center?: number) => void;
  fit: () => void;
  setHovered: (i: number | null) => void;
  setSelected: (i: number | null) => void;
  setRefIdx: (i: number) => void;
  setLastRank: (r: number) => void;
}

let camera: AnimationPlaybackControls | null = null;

export const useStage = create<StageState>()((set, get) => {
  const normalize = ([a, b]: View): View => {
    const d = get().duration || 1;
    const span = Math.min(d, Math.max(MIN_SPAN, b - a));
    const start = Math.max(0, Math.min(d - span, a));
    return [start, start + span];
  };
  return {
    takeId: null,
    duration: 1,
    view: [0, 1],
    hovered: null,
    selected: null,
    refIdx: 0,
    lastRank: 1,
    reset: (takeId, duration) => {
      if (get().takeId === takeId) return;
      camera?.stop();
      set({ takeId, duration, view: [0, duration], hovered: null, selected: null, refIdx: 0, lastRank: 1 });
    },
    setView: (target, { smooth = true, seconds = 0.42, curve = ease } = {}) => {
      const to = normalize(target);
      camera?.stop();
      const from = get().view;
      if (!smooth || prefersReducedMotion() || (from[0] === to[0] && from[1] === to[1])) {
        set({ view: to });
        return;
      }
      // interpolate in log-span so zooming in and out feel equally fast
      const c0 = (from[0] + from[1]) / 2, c1 = (to[0] + to[1]) / 2;
      const s0 = Math.log(from[1] - from[0]), s1 = Math.log(to[1] - to[0]);
      camera = animate(0, 1, {
        duration: seconds,
        ease: curve as [number, number, number, number],
        onUpdate: (k) => {
          const span = Math.exp(s0 + (s1 - s0) * k), c = c0 + (c1 - c0) * k;
          set({ view: k === 1 ? to : [c - span / 2, c + span / 2] });
        },
        onComplete: () => set({ view: to }),
      });
    },
    zoom: (factor, center) => {
      const [a, b] = get().view;
      const c = center ?? (a + b) / 2;
      get().setView([c - (c - a) * factor, c + (b - c) * factor]);
    },
    fit: () => get().setView([0, get().duration]),
    setHovered: (hovered) => get().hovered !== hovered && set({ hovered }),
    setSelected: (selected) => set({ selected }),
    setRefIdx: (refIdx) => set({ refIdx }),
    setLastRank: (lastRank) => set({ lastRank }),
  };
});

/** The window a finding is shown in: the finding plus context on both sides. */
export function findingWindow(f: Pick<Flaw, "start" | "end">): View {
  const pad = Math.max(1.2, (f.end - f.start) * 0.6);
  return [f.start - pad, f.end + pad];
}

/** Camera move between zoom levels: slower than a pan, eased at both ends. */
export const LEVEL_MOVE = { seconds: durations.deliberate, curve: [0.65, 0, 0.35, 1] as const };
