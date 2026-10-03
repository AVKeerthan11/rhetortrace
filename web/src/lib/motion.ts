import type { Transition } from "motion/react";

// Shared motion vocabulary. Motion follows state (selection, playback, panels), never decoration.
export const ease = [0.22, 1, 0.36, 1] as const;

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
