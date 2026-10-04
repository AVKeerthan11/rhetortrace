import type { Category } from "./types";

// The visual grammar of a recording. Every drawing of time-based data follows the same rules,
// so a mark means the same thing on the stage, in a plot and in the transcript:
//
//   category                → hue            (catColor)
//   severity / deviation    → opacity        (severityAlpha, zAlpha; wash() mixes it in)
//   reference deliveries    → graphite ghost (REF)
//   deviation               → a filled area  (between this recording and the reference)
//   uncertainty, ground truth → dashed       (DASH)
//   current time            → ink            (NOW: the playhead, the playing word)
//   the pointer             → faint ink      (POINTER: a preview, never audible by itself)
//
// Canvas code cannot read CSS variables per frame: use cssVar() (cached).

export const catColor = (c: Category) => `var(--cat-${c})`;

/** A category colour mixed into a surface: strength 0..1. */
export const wash = (c: Category | string, strength: number, base = "transparent") =>
  `color-mix(in oklab, ${c.startsWith("var(") || c.startsWith("#") ? c : catColor(c as Category)} ${Math.round(Math.min(1, Math.max(0, strength)) * 100)}%, ${base})`;

/** Fill opacity of a finding by severity level 0..4. */
export const severityAlpha = (level: number) => [0.1, 0.14, 0.2, 0.3, 0.42][Math.max(0, Math.min(4, level))];

/** Opacity of a per-word deviation of size |z| given the detection threshold. */
export const zAlpha = (z: number, zOpen: number) => Math.min(0.9, Math.abs(z) / (zOpen + 2));

export const REF = { band: "var(--ref-band)", line: "var(--ref-line)", ghost: "var(--ref-ghost)" } as const;
export const NOW = "var(--now)";
export const POINTER = "var(--pointer)";
export const AXIS = "var(--axis)";
export const TICK = "var(--tick)";

export const DASH = {
  /** where a finding may start / end */
  uncertainty: "2 2",
  /** injected edits (demo answer key) */
  truth: "3 2",
} as const;

const cssVarCache = new Map<string, string>();
/** Resolved value of a CSS custom property for canvas drawing, in the theme of `el` (the stage
 *  is the dark "studio" theme inside the light page), cached per theme. Use it for the plain
 *  colours (--ink, --now, --cat-*); derive tints with inkAlpha, since canvas cannot read the
 *  color-mix() roles. */
export function cssVar(name: string, el?: Element | null): string {
  const theme = el?.closest("[data-theme]")?.getAttribute("data-theme") ?? "root";
  const key = `${theme}:${name}`;
  if (!cssVarCache.has(key)) {
    const v = typeof document !== "undefined" ? getComputedStyle(el ?? document.documentElement).getPropertyValue(name).trim() : "";
    cssVarCache.set(key, v || "#888");
  }
  return cssVarCache.get(key)!;
}

/** The theme's ink at an opacity, as rgba() for canvas (mirrors the CSS ink-mix roles, e.g.
 *  --wave-idle = ink 26%). */
export function inkAlpha(alpha: number, el?: Element | null): string {
  const hex = cssVar("--ink", el).replace("#", "");
  const n = parseInt(hex.length === 3 ? hex.replace(/./g, (c) => c + c) : hex.slice(0, 6), 16);
  if (Number.isNaN(n)) return `rgba(128,128,128,${alpha})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** How far a per-word deviation (|z|, words[].categories[c].score) is beyond the detector's
 *  threshold, 0..1: 0 up to z_open (where the analysis starts flagging), 1 at z_open + 3. Colour
 *  therefore means "past where RhetorTrace flags"; within it, marks stay graphite. */
export const deviationAmount = (score: number, zOpen: number) => Math.min(1, Math.max(0, (Math.abs(score) - zOpen) / 3));
