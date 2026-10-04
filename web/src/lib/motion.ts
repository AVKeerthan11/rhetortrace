import type { Transition } from "motion/react";

// Shared motion vocabulary. Motion follows state (selection, playback, zoom), never decoration:
//  · continuity: an object present in two views morphs between them instead of fading out and in
//  · hierarchy: going deeper into a recording is a zoom of the time axis; siblings move sideways;
//    new context (sheets) rises from below
//  · playback is the only motion that keeps running
// Respect for prefers-reduced-motion: <MotionConfig reducedMotion="user"> at the root turns
// movement into fades; imperative animations check prefersReducedMotion().

export const ease = [0.22, 1, 0.36, 1] as const; // out-quint: arrivals, settles
export const easeInOut = [0.65, 0, 0.35, 1] as const; // camera moves: leave and land gently

/** Seconds. instant: hover/press · quick: chips, toggles · standard: panels, content swaps ·
 *  deliberate: camera moves on the recording stage. */
export const duration = { instant: 0.12, quick: 0.2, standard: 0.32, deliberate: 0.6 } as const;

export const spring = {
  /** buttons, pills, small toggles */
  snappy: { type: "spring", stiffness: 520, damping: 38, mass: 0.7 },
  /** panels, drawers, sidebar width */
  smooth: { type: "spring", stiffness: 300, damping: 34 },
  /** page / tab content */
  gentle: { type: "spring", stiffness: 180, damping: 28 },
} satisfies Record<string, Transition>;

export const fadeUp = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: { duration: 0.22, ease },
};

/** Staggered entrance for the blocks of a reading page. */
export const rise = (i: number) => ({
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  transition: { delay: 0.05 * i, duration: 0.4, ease },
});

/** Content under the recording stage when the zoom level changes: deeper levels arrive from
 *  below (the stage opened up above them), shallower ones from above. */
export const levelSwap = {
  initial: (dir: number) => ({ opacity: 0, y: 18 * dir }),
  animate: { opacity: 1, y: 0, transition: { duration: duration.standard, ease } },
  exit: (dir: number) => ({ opacity: 0, y: -10 * dir, transition: { duration: duration.quick * 0.75, ease } }),
};

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}
