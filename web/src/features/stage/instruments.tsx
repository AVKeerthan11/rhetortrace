import { memo, useEffect, useMemo, useRef } from "react";
import { animate } from "motion";
import { CATEGORY, CATEGORIES } from "@/lib/categories";
import { clamp, fmt, fmtSigned } from "@/lib/format";
import { REF, deviationAmount } from "@/lib/grammar";
import { easeInOut, prefersReducedMotion } from "@/lib/motion";
import { scoreSteps } from "@/lib/score";
import { cursor, useTimeSelect, wordNear } from "@/lib/time";
import type { ContourSet, Take } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { X } from "./lanes";

// Instruments of the stage: the delivery score as it falls through the recording, the readout at
// the pointer, and the analysis trace played the first time a recording is opened.

// ------------------------------------------------------------------ score ribbon

/** The delivery score through time: it starts at 100 and falls across each finding by the points
 *  that finding costs (lib/score: the pipeline's own formula). Each finding's loss is a band in its
 *  colour that carries on to the end, so the stack at the right edge is where the points went. */
export const ScoreLane = memo(function ScoreLane({ take, x, v0, v1, W, h, hovered, selected, clipId }: {
  take: Take; x: X; v0: number; v1: number; W: number; h: number; hovered: number | null; selected: number | null; clipId?: string;
}) {
  const steps = useMemo(() => scoreSteps(take), [take]);
  const final = steps.length ? steps[steps.length - 1].after : 100;
  const floor = Math.min(90, Math.floor((final - 4) / 5) * 5);
  const y = (s: number) => 5 + ((100 - s) / (100 - floor)) * (h - 10);
  const end = x(take.duration);
  const shapes = useMemo(() => {
    let prev = 100, line = `M${x(0)},${y(100)}`;
    const bands = steps.map((s) => {
      const a = x(s.start), b = Math.max(x(s.end), a + 2);
      const band = `M${a},${y(prev)}L${end},${y(prev)}L${end},${y(s.after)}L${b},${y(s.after)}Z`;
      line += `L${a},${y(prev)}L${b},${y(s.after)}`;
      const out = { ...s, band, before: prev, a };
      prev = s.after;
      return out;
    });
    line += `L${end},${y(prev)}`;
    return { bands, line };
    // x is derived from v0/v1/W
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps, v0, v1, W, h, floor]);
  let lastLabel = -Infinity;
  return (
    <svg className="absolute inset-0" width={W} height={h} role="img" aria-label={`Delivery score falls from 100 to ${fmt(take.score.total, 1)} across the findings`}>
      <g clipPath={clipId ? `url(#${clipId})` : undefined}>
        {shapes.bands.map((s) => (
          <path key={s.flaw} d={s.band} fill={CATEGORY[s.category].color}
            fillOpacity={s.flaw === hovered || s.flaw === selected ? 0.42 : 0.18} className="transition-[fill-opacity] duration-150" />
        ))}
        <path d={shapes.line} fill="none" stroke="var(--ink)" strokeOpacity={0.75} strokeWidth={1.25} strokeLinejoin="round" />
        {shapes.bands.map((s) => {
          if (s.lost < 0.05 || s.a < lastLabel + 34 || s.a < -20 || s.a > W) return null;
          lastLabel = s.a;
          return (
            <text key={s.flaw} x={s.a + 3} y={Math.max(9, y(s.before) - 3)} fontSize={9.5} className="font-mono" fill={CATEGORY[s.category].color}
              stroke="var(--stage)" strokeWidth={3} paintOrder="stroke">
              −{fmt(s.lost, 1)}
            </text>
          );
        })}
      </g>
      {x(0) >= 0 && <text x={x(0) + 3} y={16} fontSize={9.5} className="font-mono" fill="var(--faint)">100</text>}
      {end <= W && end > 40 && (
        <text x={end - 4} y={Math.min(h - 3, y(final) + 12)} textAnchor="end" fontSize={10.5} fontWeight={600} className="font-mono" fill="var(--ink)"
          stroke="var(--stage)" strokeWidth={3} paintOrder="stroke">
          {fmt(take.score.total, 1)}
        </text>
      )}
    </svg>
  );
});

// --------------------------------------------------------------- crosshair readout

function frameAt(c: ContourSet, step: number, t: number) {
  const i = Math.round(t / step);
  const v = c.take[i], lo = c.band.lo[i], hi = c.band.hi[i];
  return { v: v ?? null, lo: lo ?? null, hi: hi ?? null };
}

/** One contour value against the references' range at the pointer: a mini scale with the band and
 *  this recording's value, and how far outside the range it is. */
function ContourRow({ label, unit, color, f, range }: {
  label: string; unit: string; color: string; f: { v: number | null; lo: number | null; hi: number | null }; range: [number, number];
}) {
  const X = (v: number) => `${((clamp(v, range[0], range[1]) - range[0]) / (range[1] - range[0])) * 100}%`;
  const out = f.v === null || f.lo === null || f.hi === null ? null : f.v > f.hi ? f.v - f.hi : f.v < f.lo ? f.v - f.lo : 0;
  return (
    <div className="grid grid-cols-[46px_1fr_62px] items-center gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="relative h-2.5">
        <span className="absolute inset-x-0 top-1/2 h-px bg-ink/10" />
        {f.lo !== null && f.hi !== null && (
          <span className="absolute inset-y-0 rounded-[2px]" style={{ left: X(f.lo), width: `calc(${X(f.hi)} - ${X(f.lo)})`, background: REF.band }} />
        )}
        {f.v !== null && <span className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ left: X(f.v), background: color }} />}
      </span>
      <span className={cn("text-right font-mono tabular", out ? "text-ink" : "text-muted-foreground")}>
        {f.v === null ? "—" : out ? `${fmtSigned(out, 1)} ${unit}` : "in range"}
      </span>
    </div>
  );
}

/** The instrument readout at the pointer over the stage: pitch and energy against the references'
 *  range at that instant, and how far the word there deviates in each aspect (bar = |z|, tick =
 *  the detector's threshold). Content re-renders per contour frame; position is imperative. */
export function CrosshairReadout({ take, v0, v1, W }: { take: Take; v0: number; v1: number; W: number }) {
  const onStage = useTimeSelect("cursor", () => cursor.source === "stage" || cursor.source === "scrub");
  const step = take.contours.step;
  // one render per contour frame the pointer crosses (20 ms of audio), not per mouse event
  const frame = useTimeSelect("cursor", (t) => (t === null ? -1 : Math.round(t / step)));
  if (!onStage || frame < 0) return null;
  const t = frame * step;
  const px = ((t - v0) / (v1 - v0)) * W;
  const w = take.words[wordNear(take, t)];
  const { z_open } = take.detection_settings;
  const zTop = z_open + 3;
  return (
    <div data-testid="crosshair-readout" style={{ transform: `translateX(${px > W - 250 ? px - 236 : px + 14}px)` }}
      className="pointer-events-none absolute top-1 left-0 z-20 w-[222px] rounded-lg bg-popover/95 px-2.5 py-2 text-[11px] shadow-float backdrop-blur-[2px]">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="truncate font-medium text-ink">{w ? `“${w.text}”` : "—"}</span>
        <span className="font-mono text-[10px] text-faint">{fmt(t)} s</span>
      </div>
      <div className="space-y-1">
        <ContourRow label="Pitch" unit="st" color="var(--cat-pitch)" f={frameAt(take.contours.pitch, step, t)} range={[-9, 11]} />
        <ContourRow label="Energy" unit="dB" color="var(--cat-energy)" f={frameAt(take.contours.energy, step, t)} range={[-24, 10]} />
      </div>
      {w && (
        <div className="mt-2 border-t border-hairline pt-1.5">
          <div className="mb-1 text-[9.5px] tracking-[0.1em] text-faint uppercase">This word vs the references</div>
          {CATEGORIES.map((c) => {
            const s = w.categories[c];
            const z = s ? Math.abs(s.score) : null;
            const amt = z === null ? 0 : deviationAmount(z, z_open);
            return (
              <div key={c} className="grid grid-cols-[46px_1fr_34px] items-center gap-2 leading-[15px]">
                <span className="text-muted-foreground">{CATEGORY[c].label}</span>
                <span className="relative h-[5px] rounded-full bg-ink/[0.05]">
                  {z !== null && (
                    <span className="absolute inset-y-0 left-0 rounded-full"
                      style={{ width: `${Math.min(100, (z / zTop) * 100)}%`, background: amt > 0 ? CATEGORY[c].color : REF.line, opacity: amt > 0 ? 0.45 + 0.55 * amt : 0.5 }} />
                  )}
                  <span className="absolute -top-[2px] -bottom-[2px] w-px bg-ink/45" style={{ left: `${(z_open / zTop) * 100}%` }} />
                </span>
                <span className={cn("text-right font-mono tabular", amt > 0 ? "text-ink" : "text-faint")}>{z === null ? "—" : `${fmt(z, 1)}σ`}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ analysis trace

const TRACED = "rhetortrace:traced";

/** True the first time this recording is opened in this browser (and motion is allowed). */
export function shouldTrace(id: string): boolean {
  if (prefersReducedMotion() || typeof window === "undefined" || navigator.webdriver) return false;
  try {
    return !(JSON.parse(localStorage.getItem(TRACED) ?? "[]") as string[]).includes(id);
  } catch {
    return false;
  }
}

function markTraced(id: string) {
  try {
    const seen = JSON.parse(localStorage.getItem(TRACED) ?? "[]") as string[];
    localStorage.setItem(TRACED, JSON.stringify([...seen.filter((s) => s !== id), id].slice(-200)));
  } catch {
    /* fine: it plays again next time */
  }
}

/** A scan line sweeps the recording once and the findings (and the score) appear as it passes
 *  their time: detection is temporal. Any pointer or key press finishes it at once. The findings
 *  and score lanes clip to the clipPath `id` while it runs. */
export function AnalysisTrace({ id, takeId, W, onDone }: { id: string; takeId: string; W: number; onDone: () => void }) {
  const rect = useRef<SVGRectElement>(null);
  const line = useRef<HTMLDivElement>(null);
  useEffect(() => {
    markTraced(takeId);
    const set = (k: number) => {
      rect.current?.setAttribute("width", String(k * W));
      if (line.current) {
        line.current.style.transform = `translateX(${k * W}px)`;
        line.current.style.opacity = String(k < 0.92 ? 1 : (1 - k) / 0.08);
      }
    };
    const run = animate(0, 1, { duration: 1.8, ease: easeInOut as unknown as [number, number, number, number], onUpdate: set, onComplete: onDone });
    const skip = () => {
      run.stop();
      onDone();
    };
    window.addEventListener("pointerdown", skip, { once: true, capture: true });
    window.addEventListener("keydown", skip, { once: true, capture: true });
    return () => {
      run.stop();
      window.removeEventListener("pointerdown", skip, { capture: true });
      window.removeEventListener("keydown", skip, { capture: true });
    };
  }, [takeId, W, onDone]);
  const ink = "var(--now)";
  return (
    <>
      <svg width={0} height={0} className="absolute" aria-hidden>
        <defs>
          <clipPath id={id}>
            <rect ref={rect} x={-20} y={-20} width={0} height={2000} />
          </clipPath>
        </defs>
      </svg>
      <div ref={line} aria-hidden className="pointer-events-none absolute top-[20px] bottom-0 left-0 w-[64px] -translate-x-full"
        style={{ background: `linear-gradient(90deg, transparent, color-mix(in oklab, ${ink} 7%, transparent) 75%, color-mix(in oklab, ${ink} 55%, transparent) 99%, ${ink})`, marginLeft: 0 }} />
    </>
  );
}
