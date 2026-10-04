import { memo, useEffect, useMemo, useRef } from "react";
import type { Category, ContourSet, Flaw, Take } from "@/lib/types";
import { CATEGORY, CATEGORIES } from "@/lib/categories";
import { clamp, fmt } from "@/lib/format";
import { AXIS, DASH, NOW, REF, TICK, cssVar, deviationAmount, inkAlpha, severityAlpha, zAlpha } from "@/lib/grammar";
import { level as liveLevel, liveAvailable } from "@/lib/live";
import { player, usePlayerState } from "@/lib/player";
import { useUi } from "@/lib/store";
import { useTimeEffect, useWordFocus, wordNear, wordTimes } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { View } from "./store";

// The lanes of the recording stage. Each lane draws one aspect of the recording over the
// visible window [v0, v1]; x() maps seconds to pixels. Rendering rule: a lane re-renders when the
// camera (view), the selection or its data change, never per frame. What moves during playback
// (playhead, played part of the waveform) is updated imperatively through useTimeEffect, and
// what follows the playing / pointed word re-renders only when that word changes.

export type X = (t: number) => number;

function niceStep(span: number, px: number) {
  const target = span / Math.max(3, px / 96);
  return [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60].find((s) => s >= target) ?? 60;
}

// ---------------------------------------------------------------- minimap / ruler

export function Minimap({ take, view, setView, width }: { take: Take; view: View; setView: (v: View, o?: { smooth?: boolean }) => void; width: number }) {
  const d = take.duration;
  const path = useMemo(() => {
    const p = take.peaks;
    let s = "";
    for (let i = 0; i < p.bins; i += 3) {
      const xx = (i / p.bins) * width;
      const a = Math.min(1, Math.max(Math.abs(p.min[i]), Math.abs(p.max[i])) * 3.2);
      s += `M${xx.toFixed(1)},${(11 - a * 9).toFixed(1)}V${(11 + a * 9).toFixed(1)}`;
    }
    return s;
  }, [take, width]);
  const drag = useRef(false);
  const panTo = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const t = ((e.clientX - r.left) / r.width) * d;
    const span = view[1] - view[0];
    setView([t - span / 2, t + span / 2], { smooth: false });
  };
  return (
    <div
      className="relative cursor-grab overflow-hidden rounded-md bg-ink/[0.025] active:cursor-grabbing"
      style={{ width, height: 20 }}
      onPointerDown={(e) => {
        drag.current = true;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        panTo(e);
      }}
      onPointerMove={(e) => drag.current && panTo(e)}
      onPointerUp={() => (drag.current = false)}
    >
      <svg width={width} height={20} className="absolute inset-0">
        <path d={path} stroke={TICK} strokeWidth={1} />
        {take.flaws.map((f, i) => (
          <rect key={i} x={(f.start / d) * width} y={17} width={Math.max(2, ((f.end - f.start) / d) * width)} height={3}
            fill={CATEGORY[f.category].color} rx={1} />
        ))}
      </svg>
      <div
        className="absolute inset-y-0 rounded-[5px] border border-ink/40 bg-ink/[0.06]"
        style={{ left: (view[0] / d) * width, width: Math.max(4, ((view[1] - view[0]) / d) * width) }}
      />
    </div>
  );
}

export function Ruler({ v0, v1, W, h, sel, x }: { v0: number; v1: number; W: number; h: number; sel: Flaw | null; x: X }) {
  const step = niceStep(v1 - v0, W);
  const ticks: number[] = [];
  for (let t = Math.ceil(v0 / step) * step; t <= v1 + 1e-9; t += step) ticks.push(t);
  return (
    <svg width={W} height={h} className="block overflow-visible">
      {ticks.map((t) => (
        <g key={t.toFixed(3)}>
          <line x1={x(t)} x2={x(t)} y1={h - 6} y2={h} stroke={TICK} />
          <text x={x(t) + 4} y={h - 8} fontSize={10} fill="var(--faint)" className="font-mono">
            {step < 1 ? t.toFixed(1) : Math.round(t)}s
          </text>
        </g>
      ))}
      {sel && (
        <>
          {[{ t: sel.start, anchor: "end" as const, dx: -2 }, { t: sel.end, anchor: "start" as const, dx: 2 }].map(({ t, anchor, dx }) => {
            const label = `${fmt(t)}s`, w = label.length * 6.2 + 8;
            const left = anchor === "end" ? x(t) + dx - w : x(t) + dx;
            return (
              <g key={anchor}>
                <rect x={left} y={0} width={w} height={14} rx={3} fill="var(--surface)" stroke={CATEGORY[sel.category].color} strokeOpacity={0.6} />
                <text x={left + w / 2} y={10.5} fontSize={10} textAnchor="middle" fill={CATEGORY[sel.category].color} className="font-mono">{label}</text>
              </g>
            );
          })}
        </>
      )}
    </svg>
  );
}

// ------------------------------------------------------------------- waveform

/** Per-word deviation colour of the waveform: inside a word, its strongest category other than
 *  pause; in the silence after a word, its pause deviation. Amount 0..1 from deviationAmount. */
const tintCache = new WeakMap<Take, { word: ({ cat: Category; amt: number } | null)[]; gap: number[] }>();
function deviationTints(take: Take) {
  let c = tintCache.get(take);
  if (c) return c;
  const { z_open } = take.detection_settings;
  const word = take.words.map((w) => {
    let best: { cat: Category; amt: number } | null = null;
    for (const cat of CATEGORIES) {
      const s = w.categories[cat];
      if (!s || cat === "pause") continue;
      const amt = deviationAmount(s.score, z_open);
      if (amt > 0 && (!best || amt > best.amt)) best = { cat, amt };
    }
    return best;
  });
  const gap = take.words.map((w) => (w.categories.pause ? deviationAmount(w.categories.pause.score, z_open) : 0));
  c = { word, gap };
  tintCache.set(take, c);
  return c;
}

/** Bars of the audio envelope, drawn twice: an idle layer and a "played" layer on top whose
 *  visible width follows the playhead (one clip-path write per frame, no redraw). Both layers
 *  are redrawn only when the camera, the selection or the hovered finding change.
 *  The waveform is the report: each bar takes the colour of how far its word deviates from the
 *  references (graphite within their range, more saturated the further out), and finding spans
 *  are washed in their category colour (stronger when hovered anywhere in the app). */
export const Waveform = memo(function Waveform({ take, v0, v1, W, H: h, sel, hovered }: {
  take: Take; v0: number; v1: number; W: number; H: number; sel: Flaw | null; hovered: number | null;
}) {
  const idle = useRef<HTMLCanvasElement>(null);
  const played = useRef<HTMLCanvasElement>(null);
  // canvas pixels do not follow CSS: repaint when the appearance changes
  const theme = useUi((st) => st.theme);

  useEffect(() => {
    const dpr = window.devicePixelRatio || 1;
    const p = take.peaks, n = p.bins, d = take.duration;
    const x = (t: number) => ((t - v0) / (v1 - v0)) * W;
    const bar = W < 500 ? 1.5 : 2, gap = 1, mid = h / 2;
    const scope = idle.current;
    const selColor = sel ? cssVar(`--cat-${sel.category}`, scope) : "";
    const tints = deviationTints(take);
    const wt = wordTimes(take);
    // bar heights and deviation tint once for both layers
    const bars: { px: number; amp: number; inSel: boolean; tint: string | null; amt: number }[] = [];
    for (let px = 0; px < W; px += bar + gap) {
      const ta = v0 + (px / W) * (v1 - v0), tb = v0 + ((px + bar + gap) / W) * (v1 - v0);
      const a = Math.floor((ta / d) * n), b = Math.max(a + 1, Math.floor((tb / d) * n));
      let hi = 0;
      for (let i = Math.max(0, a); i < Math.min(n, b); i++) hi = Math.max(hi, Math.abs(p.min[i]), Math.abs(p.max[i]));
      // deviation of the word (or of the pause after it) under the bar's centre
      const tc = (ta + tb) / 2;
      let tint: string | null = null, amt = 0;
      const wi = wordNear(take, tc);
      if (wi >= 0) {
        const w = take.words[wi], next = wt.nextStart[wi];
        if (w.end !== null && tc < w.end) {
          const dv = tints.word[wi];
          if (dv) [tint, amt] = [cssVar(`--cat-${dv.cat}`, scope), dv.amt];
        } else if (next !== null && tc < next && tints.gap[wi] > 0) [tint, amt] = [cssVar("--cat-pause", scope), tints.gap[wi]];
      }
      bars.push({ px, amp: Math.max(1, Math.min(mid - 2, hi * h * 1.25)), inSel: !!sel && ta >= sel.start && ta <= sel.end, tint, amt });
    }
    const draw = (c: HTMLCanvasElement | null, barColor: string, findingWash: boolean, tintAlpha: number) => {
      if (!c) return;
      c.width = W * dpr;
      c.height = h * dpr;
      const g = c.getContext("2d");
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, h);
      if (findingWash) {
        take.flaws.forEach((f, i) => {
          if (f === sel) return;
          const a = x(f.start), b = Math.max(x(f.end), a + 3);
          if (b < 0 || a > W) return;
          g.globalAlpha = hovered === i ? 0.24 : 0.1;
          g.fillStyle = cssVar(`--cat-${f.category}`, scope);
          g.beginPath();
          g.roundRect(a, 0, b - a, h, 4);
          g.fill();
        });
        g.globalAlpha = 1;
      }
      for (const { px, amp, inSel, tint, amt } of bars) {
        g.fillStyle = inSel ? selColor : barColor;
        g.beginPath();
        g.roundRect(px, mid - amp, bar, amp * 2, 1);
        g.fill();
        if (!inSel && tint && amt > 0) {
          g.globalAlpha = tintAlpha * (0.35 + 0.65 * amt);
          g.fillStyle = tint;
          g.fill();
          g.globalAlpha = 1;
        }
      }
    };
    draw(idle.current, inkAlpha(0.26, scope), true, 0.7);
    draw(played.current, inkAlpha(0.84, scope), false, 0.95);
  }, [take, v0, v1, W, h, sel, hovered, theme]);

  useTimeEffect("playhead", (t) => {
    const c = played.current;
    if (!c) return;
    const px = clamp((((t ?? 0) - v0) / (v1 - v0)) * W, 0, W);
    c.style.clipPath = `inset(0 ${W - px}px 0 0)`;
  }, [v0, v1, W]);

  return (
    <div className="relative" style={{ width: W, height: h }}>
      <canvas ref={idle} style={{ width: W, height: h }} className="absolute inset-0 block" />
      <canvas ref={played} style={{ width: W, height: h }} className="absolute inset-0 block" />
    </div>
  );
});

// ------------------------------------------------------------------- findings

export function FindingRegion({ f, x, h, selected, hovered, rank, dim }: {
  f: Flaw; x: X; h: number; selected: boolean; hovered: boolean; rank?: number; dim?: boolean;
}) {
  const c = CATEGORY[f.category].color;
  const a = x(f.start), b = Math.max(x(f.end), a + 6);
  const lvl = f.severity.level;
  const fill = severityAlpha(lvl) + (hovered ? 0.12 : 0);
  const ua = x(f.start - f.start_uncertainty_s), ub = x(f.end + f.end_uncertainty_s);
  const Icon = CATEGORY[f.category].icon;
  return (
    <g className="cursor-pointer transition-opacity duration-200" opacity={dim && !hovered ? 0.45 : 1}>
      {/* uncertainty of the boundaries: dashed */}
      <line x1={ua} x2={a} y1={h / 2} y2={h / 2} stroke={c} strokeOpacity={0.5} strokeDasharray={DASH.uncertainty} />
      <line x1={b} x2={ub} y1={h / 2} y2={h / 2} stroke={c} strokeOpacity={0.5} strokeDasharray={DASH.uncertainty} />
      <rect x={a} y={5} width={b - a} height={h - 10} rx={5} fill={c} fillOpacity={fill}
        stroke={selected ? NOW : c} strokeOpacity={selected ? 0.9 : 0.55 + lvl * 0.1} strokeWidth={selected || hovered ? 1.5 : 1} />
      {rank !== undefined && (
        <g className="pointer-events-none">
          <circle cx={a} cy={h / 2} r={hovered || selected ? 9.5 : 8.5} fill={selected || hovered ? c : "var(--surface)"} stroke={c} strokeWidth={1.25} />
          <text x={a} y={h / 2 + 3.5} textAnchor="middle" fontSize={10} fontWeight={600} fill={selected || hovered ? "var(--on-category)" : c} className="font-mono">{rank}</text>
        </g>
      )}
      {b - a > 92 ? (
        <foreignObject x={a + (rank !== undefined ? 13 : 6)} y={5} width={b - a - 18} height={h - 10} className="pointer-events-none">
          <div className="flex h-full items-center gap-1.5 overflow-hidden text-[11px] whitespace-nowrap text-ink/90">
            {rank === undefined && <Icon className="size-3 shrink-0" style={{ color: c }} strokeWidth={2} />}
            <span className="font-medium">{CATEGORY[f.category].label}</span>
            <span className="text-ink/55">{f.severity.label}</span>
          </div>
        </foreignObject>
      ) : null}
    </g>
  );
}

// ---------------------------------------------------------------------- words

/** The words where they were spoken. Layout is computed when the camera moves; the playing word
 *  (highlighter) and the pointed word (outline) re-render the lane only when they change. */
export function WordsLane({ take, x, v0, v1, W, h, sel }: { take: Take; x: X; v0: number; v1: number; W: number; h: number; sel: Flaw | null }) {
  const { playing, pointed } = useWordFocus(take);
  const layout = useMemo(() => {
    const { nextStart } = wordTimes(take);
    return take.words.map((w, i) => {
      if (w.start === null || w.end === null) return null;
      const a = x(w.start), b = x(w.end);
      if (b < -40 || a > W + 40) return null;
      const avail = (nextStart[i] !== null ? x(nextStart[i]!) : W) - a - 2;
      return { w, a, avail, inSel: !!sel && w.idx >= sel.start_idx && w.idx <= sel.end_idx };
    });
    // x is derived from v0/v1/W
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [take, v0, v1, W, sel]);
  return (
    <div className="absolute inset-0 overflow-hidden" style={{ height: h }}>
      {layout.map((l) => {
        if (!l) return null;
        const { w, a, avail, inSel } = l;
        const isPlaying = w.idx === playing, isPointed = w.idx === pointed;
        if (avail < 34 && !inSel)
          return (
            <div key={w.idx} className={cn("absolute w-px", isPlaying ? "bg-ink" : isPointed ? "bg-ink/60" : "bg-ink/20")}
              style={{ left: a, top: h / 2 - 5, height: isPlaying || isPointed ? 14 : 10, marginTop: isPlaying || isPointed ? -2 : 0 }} />
          );
        return (
          <div
            key={w.idx}
            className={cn(
              "absolute flex items-center truncate rounded-[4px] px-1 text-[12px] leading-none transition-colors duration-100",
              inSel ? "bg-highlight-soft text-ink" : "text-ink/60",
              isPlaying && "text-[var(--on-highlight)]",
              isPointed && !isPlaying && "text-ink shadow-[inset_0_0_0_1px_var(--pointer)]",
              w.low_confidence && "underline decoration-ink/30 decoration-dotted underline-offset-[3px]",
            )}
            style={{ left: a, top: h / 2 - 10, height: 20, maxWidth: avail, background: isPlaying ? "var(--highlight)" : undefined }}
          >
            {w.text}
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------- contours

/** A contour of this recording (category colour) over the references: their range (graphite
 *  band), their median (graphite line) and each reference delivery's own contour (faint
 *  ghosts). Where this recording leaves the references' range, the gap to the band is filled in
 *  its colour: deviation as an area. Paths are rebuilt only when the camera or the data change. */
export const ContourLane = memo(function ContourLane({ h, W, data, step, n, v0, v1, range, color, unit, showRef }: {
  h: number; W: number; data: ContourSet; step: number; n: number; v0: number; v1: number;
  range: [number, number]; color: string; unit: string; showRef: boolean;
}) {
  const [lo, hi] = range;
  const y = (v: number) => h - 6 - ((clamp(v, lo, hi) - lo) / (hi - lo)) * (h - 12);
  const paths = useMemo(() => {
    const yy = (v: number) => (h - 6 - ((clamp(v, lo, hi) - lo) / (hi - lo)) * (h - 12)).toFixed(1);
    const i0 = Math.max(0, Math.floor(v0 / step) - 1), i1 = Math.min(n - 1, Math.ceil(v1 / step) + 1);
    const xs = (i: number) => (((i * step - v0) / (v1 - v0)) * W).toFixed(1);
    /** closed areas between two series, over the runs where both exist */
    const area = (top: (i: number) => number | null, bottom: (i: number) => number | null) => {
      let d = "", seg: number[] = [];
      const flush = () => {
        if (seg.length > 1)
          d += "M" + seg.map((i) => `${xs(i)},${yy(top(i)!)}`).join("L") + "L" + [...seg].reverse().map((i) => `${xs(i)},${yy(bottom(i)!)}`).join("L") + "Z";
        seg = [];
      };
      for (let i = i0; i <= i1; i++) {
        if (top(i) === null || bottom(i) === null) flush();
        else seg.push(i);
      }
      flush();
      return d;
    };
    const line = (arr: (number | null)[]) => {
      let d = "", pen = false;
      for (let i = i0; i <= i1; i++) {
        const v = arr[i];
        if (v === null || v === undefined) { pen = false; continue; }
        d += `${pen ? "L" : "M"}${xs(i)},${yy(v)}`;
        pen = true;
      }
      return d;
    };
    const { take: tk, band: b } = data;
    const above = (i: number) => (tk[i] !== null && b.hi[i] !== null && tk[i]! > b.hi[i]! ? tk[i] : null);
    const below = (i: number) => (tk[i] !== null && b.lo[i] !== null && tk[i]! < b.lo[i]! ? tk[i] : null);
    if (!showRef) return { band: "", median: "", ghosts: [] as string[], excursion: "", take: line(tk) };
    return {
      band: area((i) => b.hi[i], (i) => b.lo[i]),
      median: line(b.median),
      ghosts: Object.keys(data).filter((k) => k !== "take" && k !== "band" && Array.isArray(data[k])).map((k) => line(data[k] as (number | null)[])),
      excursion: area(above, (i) => (above(i) !== null ? b.hi[i] : null)) + area((i) => (below(i) !== null ? b.lo[i] : null), below),
      take: line(tk),
    };
  }, [data, step, n, v0, v1, W, h, lo, hi, showRef]);
  const wide = v1 - v0 > 20;
  return (
    <svg className="absolute inset-0" width={W} height={h}>
      <line x1={0} x2={W} y1={y(0)} y2={y(0)} stroke={AXIS} />
      {showRef && <path d={paths.band} fill={REF.band} />}
      {paths.ghosts.map((d, k) => <path key={k} d={d} fill="none" stroke={REF.ghost} strokeOpacity={0.3} strokeWidth={0.8} strokeLinejoin="round" />)}
      {showRef && <path d={paths.median} fill="none" stroke={REF.line} strokeWidth={1} />}
      {showRef && <path d={paths.excursion} fill={color} fillOpacity={0.34} data-excursion="" />}
      <path d={paths.take} fill="none" stroke={color} strokeOpacity={wide ? 0.75 : 0.95} strokeWidth={wide ? 1.1 : 1.6}
        strokeLinejoin="round" strokeLinecap="round" />
      {W > 420 && (
        <text x={W - 6} y={11} textAnchor="end" fontSize={9.5} fill="var(--faint)" stroke="var(--stage)" strokeWidth={3} paintOrder="stroke" className="font-mono">
          {unit} re speaker median{showRef ? " · band = references · fill = outside their range" : ""}
        </text>
      )}
    </svg>
  );
});

/** Per-word distance from the references, one row per category: opacity is |z|. */
export const DeviationLane = memo(function DeviationLane({ h, take, x, v0, v1, W }: { h: number; take: Take; x: X; v0: number; v1: number; W: number }) {
  const row = (h - 6) / CATEGORIES.length;
  const zOpen = take.detection_settings.z_open;
  const rects = useMemo(() => {
    const { nextStart } = wordTimes(take);
    return CATEGORIES.flatMap((cat: Category, r) =>
      take.words.map((w, i) => {
        const c = w.categories[cat];
        if (!c || w.start === null || c.score < 1) return null;
        const a = x(w.start), b = nextStart[i] !== null ? x(nextStart[i]!) : x(w.end ?? w.start);
        if (b < 0 || a > W) return null;
        return { key: `${cat}-${w.idx}`, x: a, y: 3 + r * row, w: Math.max(1, b - a - 1), fill: CATEGORY[cat].color, alpha: zAlpha(c.score, zOpen) };
      }),
    ).filter((r) => r !== null);
    // x is derived from v0/v1/W
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [take, v0, v1, W, row, zOpen]);
  return (
    <svg className="absolute inset-0" width={W} height={h}>
      {rects.map((r) => <rect key={r.key} x={r.x} y={r.y} width={r.w} height={row - 2} rx={1.5} fill={r.fill} fillOpacity={r.alpha} />)}
    </svg>
  );
});

export function TruthLane({ take, x, h, W }: { take: Take; x: X; h: number; W: number }) {
  return (
    <svg className="absolute inset-0" width={W} height={h}>
      {take.ground_truth!.map((g, i) => {
        const a = x(g.start), b = Math.max(x(g.end), a + 4);
        return (
          <g key={i}>
            <path d={`M${a},${h - 2}V4H${b}V${h - 2}`} fill="none" stroke="var(--truth)" strokeWidth={1.25} strokeDasharray={DASH.truth} />
            {b - a > 70 && (
              <text x={a + 5} y={12} fontSize={9.5} fill="var(--truth)" className="font-mono">
                injected {g.kind.replace("_", " ")}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------- time overlays (imperative)

const TRAIL_S = 1.4;

/** The live level of what is audible (Web Audio, lib/live), drawn as an ink envelope trailing
 *  the playhead while the recording plays: the bars being heard, lit up. It fades within TRAIL_S
 *  seconds and disappears when playback stops. Only this small canvas redraws per frame. */
export function LiveTrace({ v0, v1, W, h }: { v0: number; v1: number; W: number; h: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const samples = useRef<{ t: number; v: number; at: number }[]>([]);
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = W * dpr;
    c.height = h * dpr;
    c.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }, [W, h]);
  useTimeEffect("playhead", (t) => {
    const g = canvas.current?.getContext("2d");
    if (!g) return;
    g.clearRect(0, 0, W, h);
    const now = performance.now();
    const s = samples.current;
    if (!player.playing || t === null || !liveAvailable()) {
      s.length = 0;
      return;
    }
    // a seek or a loop jump starts a new trail
    if (s.length && Math.abs(t - s[s.length - 1].t) > 0.3) s.length = 0;
    s.push({ t, v: liveLevel(), at: now });
    while (s.length && now - s[0].at > TRAIL_S * 1000) s.shift();
    if (s.length < 2) return;
    const mid = h / 2, x = (tt: number) => ((tt - v0) / (v1 - v0)) * W;
    const amp = (v: number) => Math.min(mid - 1, v * h * 3.2);
    // "now": ink on the report, signal lime on the instrument
    g.strokeStyle = g.fillStyle = cssVar("--now", canvas.current);
    g.lineWidth = 1.5;
    g.lineCap = "round";
    for (let k = 1; k < s.length; k++) {
      g.globalAlpha = Math.max(0, 0.7 * (1 - (now - s[k].at) / (TRAIL_S * 1000)));
      for (const sign of [-1, 1]) {
        g.beginPath();
        g.moveTo(x(s[k - 1].t), mid + sign * amp(s[k - 1].v));
        g.lineTo(x(s[k].t), mid + sign * amp(s[k].v));
        g.stroke();
      }
    }
    // the head: a bar at the playhead as tall as what is audible now
    const last = s[s.length - 1];
    g.globalAlpha = 0.9;
    g.beginPath();
    g.roundRect(x(last.t) - 1.5, mid - amp(last.v) - 1, 3, amp(last.v) * 2 + 2, 1.5);
    g.fill();
    g.globalAlpha = 1;
  }, [v0, v1, W, h]);
  return <canvas ref={canvas} aria-hidden style={{ width: W, height: h }} className="pointer-events-none absolute inset-0" />;
}

/** The playhead: ink, moved by a style write per frame (no React render). While the reference
 *  is held it turns graphite and names it: it is then where the reference speaker is in the
 *  script, mapped onto this recording. */
export function Playhead({ v0, v1, W }: { v0: number; v1: number; W: number }) {
  const el = useRef<HTMLDivElement>(null);
  const { ghost } = usePlayerState();
  useTimeEffect("playhead", (t) => {
    const n = el.current;
    if (!n) return;
    const px = (((t ?? 0) - v0) / (v1 - v0)) * W;
    n.style.visibility = px < 0 || px > W ? "hidden" : "visible";
    n.style.transform = `translateX(${px}px)`;
  }, [v0, v1, W]);
  const c = ghost ? REF.ghost : NOW;
  return (
    <div ref={el} className="pointer-events-none absolute top-0 bottom-0 left-0 w-[1.5px] will-change-transform" style={{ background: c }} data-ghost={ghost ? "" : undefined}>
      <div className="absolute -top-px -left-[4px] size-[9.5px] rotate-45 rounded-[2px]" style={{ background: ghost ? "var(--stage)" : c, boxShadow: ghost ? `inset 0 0 0 1.5px ${c}` : undefined }} />
      {ghost && (
        <span className="absolute top-3 left-1.5 rounded bg-highlight-soft px-1.5 py-0.5 text-[10.5px] font-medium whitespace-nowrap text-ink shadow-[0_0_0_1px_var(--hairline)]">
          {ghost}
        </span>
      )}
    </div>
  );
}

/** The shared pointer (cursor.t from any surface: the stage, a transcript word, the keyboard):
 *  a faint line with the time and the word there. Imperative, like the playhead. */
export function PointerLine({ take, v0, v1, W }: { take: Take; v0: number; v1: number; W: number }) {
  const el = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  useTimeEffect("cursor", (t) => {
    const n = el.current;
    if (!n) return;
    const px = t === null ? -1 : ((t - v0) / (v1 - v0)) * W;
    if (t === null || px < 0 || px > W) {
      n.style.visibility = "hidden";
      return;
    }
    n.style.visibility = "visible";
    n.style.transform = `translateX(${px}px)`;
    if (label.current) {
      const wi = wordNear(take, t), w = take.words[wi];
      label.current.textContent = `${fmt(t)}s${w ? ` · ${w.text}` : ""}`;
      // keep the label inside the stage near the right edge
      label.current.style.transform = px > W - 120 ? "translateX(calc(-100% - 12px))" : "";
    }
  }, [take, v0, v1, W]);
  return (
    <div ref={el} className="pointer-events-none invisible absolute top-0 bottom-0 left-0 w-px" style={{ background: "var(--pointer)" }}>
      <span ref={label} className="absolute top-0 left-1.5 rounded bg-popover px-1 py-0.5 font-mono text-[10px] whitespace-nowrap text-muted-foreground shadow-[0_0_0_1px_var(--hairline)]" />
    </div>
  );
}
