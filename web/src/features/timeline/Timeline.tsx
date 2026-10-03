import { useEffect, useMemo, useRef, useState } from "react";
import type { Category, ContourSet, Flaw, Take, Word } from "@/lib/types";
import { CATEGORY, CATEGORIES } from "@/lib/categories";
import { clamp, fmt } from "@/lib/format";
import { cn } from "@/lib/utils";
import { usePlayerTime, type Player } from "@/lib/player";
import type { Layers } from "@/lib/store";
import type { View } from "./useView";


const GUTTER = 76;
const H = { minimap: 20, ruler: 20, wave: 78, findings: 32, truth: 16, words: 28, pitch: 62, energy: 48, deviation: 44 };

interface Props {
  take: Take;
  view: View;
  setView: (v: View, smooth?: boolean) => void;
  player: Player;
  selected: number | null;
  onSelect: (i: number) => void;
  onWord: (w: Word) => void;
  layers: Layers;
  /** Close-up of one finding: no minimap and no findings lane. */
  compact?: boolean;
  /** Finding number (importance rank, 1-based) per flaw index, drawn on the findings lane. */
  ranks?: number[];
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(800);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function niceStep(span: number, px: number) {
  const target = span / Math.max(3, px / 96);
  return [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60].find((s) => s >= target) ?? 60;
}

export function Timeline({ take, view, setView, player, selected, onSelect, onWord, layers, compact = false, ranks }: Props) {
  const [wrap, width] = useWidth<HTMLDivElement>();
  const W = Math.max(100, width - GUTTER);
  const [v0, v1] = view;
  const x = (t: number) => ((t - v0) / (v1 - v0)) * W;
  const tAt = (px: number) => v0 + (px / W) * (v1 - v0);
  const sel = selected !== null ? take.flaws[selected] : null;
  const [hover, setHover] = useState<number | null>(null);

  // vertical layout
  const showTruth = layers.truth && !!take.ground_truth && !compact;
  const lanes = [
    { key: "wave", h: H.wave, label: "Audio" },
    ...(showTruth ? [{ key: "truth", h: H.truth, label: "Injected" }] : []),
    ...(compact ? [] : [{ key: "findings", h: H.findings, label: "Findings" }]),
    { key: "words", h: H.words, label: "Words" },
    ...(layers.pitch ? [{ key: "pitch", h: compact ? 104 : H.pitch, label: "Pitch" }] : []),
    ...(layers.energy ? [{ key: "energy", h: compact ? 90 : H.energy, label: "Energy" }] : []),
    ...(layers.deviation ? [{ key: "deviation", h: H.deviation, label: "Deviation" }] : []),
  ];
  let y = 0;
  const pos: Record<string, { y: number; h: number }> = {};
  for (const l of lanes) {
    pos[l.key] = { y, h: l.h };
    y += l.h;
  }
  const bodyH = y;

  // ---------------------------------------------------------- pointer handling
  const drag = useRef<{ x0: number; v: View; moved: boolean } | null>(null);
  const localX = (e: React.PointerEvent | React.WheelEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return e.clientX - r.left;
  };
  const localY = (e: React.PointerEvent) => e.clientY - (e.currentTarget as HTMLElement).getBoundingClientRect().top;

  const onPointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x0: localX(e), v: [v0, v1], moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const px = localX(e);
    setHover(tAt(px));
    const d = drag.current;
    if (!d) return;
    const dx = px - d.x0;
    if (Math.abs(dx) > 3) d.moved = true;
    if (d.moved) {
      const dt = (dx / W) * (d.v[1] - d.v[0]);
      setView([d.v[0] - dt, d.v[1] - dt], false);
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved) return;
    const px = localX(e);
    const py = localY(e);
    const t = tAt(px);
    const f = pos.findings;
    if (f && py >= f.y && py <= f.y + f.h) {
      const hit = take.flaws.findIndex((fl) => x(fl.start) - 3 <= px && px <= Math.max(x(fl.end), x(fl.start) + 6) + 3);
      if (hit >= 0) return onSelect(hit);
    }
    const w = pos.words;
    if (py >= w.y && py <= w.y + w.h) {
      const word = take.words.find((wd) => wd.start !== null && wd.end !== null && x(wd.start) <= px && px <= x(wd.end) + 2);
      if (word) return onWord(word);
    }
    player.seek(t);
  };
  // In the close-up (a scrolling page) a plain wheel scrolls the page; Ctrl/⌘ + wheel zooms.
  const wheelZooms = (e: { ctrlKey: boolean; metaKey: boolean }) => !compact || e.ctrlKey || e.metaKey;
  const onWheel = (e: React.WheelEvent) => {
    if (!wheelZooms(e)) return;
    const px = localX(e);
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && !e.ctrlKey) {
      const dt = (e.deltaX / W) * (v1 - v0);
      setView([v0 + dt, v1 + dt], false);
      return;
    }
    const k = Math.exp(e.deltaY * (e.ctrlKey && !compact ? 0.01 : 0.0018));
    const c = tAt(px);
    setView([c - (c - v0) * k, c + (v1 - c) * k], false);
  };

  // native wheel listener so the page does not scroll while zooming
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const stop = (e: WheelEvent) => {
      if (!compact || e.ctrlKey || e.metaKey) e.preventDefault();
    };
    el.addEventListener("wheel", stop, { passive: false });
    return () => el.removeEventListener("wheel", stop);
  }, [compact]);

  return (
    <div ref={wrap} className="relative select-none">
      {!compact && <Minimap take={take} view={view} setView={setView} width={W} />}
      <Ruler v0={v0} v1={v1} W={W} sel={sel} x={x} />

      <div className="relative flex">
        {/* lane labels */}
        <div className="shrink-0" style={{ width: GUTTER }}>
          {lanes.map((l) => (
            <div key={l.key} className="flex items-center pr-3 text-[10.5px] font-medium uppercase tracking-[0.1em] text-faint" style={{ height: l.h }}>
              {l.label}
            </div>
          ))}
        </div>

        <div
          ref={body}
          className="relative cursor-crosshair overflow-hidden"
          style={{ width: W, height: bodyH }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => setHover(null)}
          onWheel={onWheel}
        >
          {/* lane separators */}
          {lanes.slice(1).map((l) => (
            <div key={l.key} className="absolute inset-x-0 border-t border-hairline" style={{ top: pos[l.key].y }} />
          ))}

          {/* selected finding region across all lanes */}
          {sel && (
            <div
              className="pointer-events-none absolute top-0 bottom-0 transition-[left,width] duration-75"
              style={{
                left: x(sel.start),
                width: Math.max(2, x(sel.end) - x(sel.start)),
                background: `color-mix(in oklab, ${CATEGORY[sel.category].color} 9%, transparent)`,
                boxShadow: `inset 1px 0 0 color-mix(in oklab, ${CATEGORY[sel.category].color} 70%, transparent), inset -1px 0 0 color-mix(in oklab, ${CATEGORY[sel.category].color} 70%, transparent)`,
              }}
            />
          )}

          <div className="absolute inset-x-0" style={{ top: pos.wave.y, height: H.wave }}>
            <Waveform take={take} player={player} v0={v0} v1={v1} W={W} H={H.wave} sel={sel} />
          </div>

          {showTruth && (
            <svg className="absolute inset-x-0" style={{ top: pos.truth.y }} width={W} height={H.truth}>
              {take.ground_truth!.map((g, i) => {
                const a = x(g.start), b = Math.max(x(g.end), a + 4);
                return (
                  <g key={i}>
                    <path d={`M${a},${H.truth - 2}V4H${b}V${H.truth - 2}`} fill="none" stroke="var(--truth)" strokeWidth={1.25} strokeDasharray="3 2" />
                    {b - a > 70 && (
                      <text x={a + 5} y={12} fontSize={9.5} fill="var(--truth)" className="font-mono">
                        injected {g.kind.replace("_", " ")}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          )}

          {!compact && (
            <svg className="absolute inset-x-0" style={{ top: pos.findings.y }} width={W} height={H.findings}>
              {take.flaws.map((f, i) => (
                <FindingRegion key={i} f={f} x={x} h={H.findings} selected={i === selected} rank={ranks?.[i]} />
              ))}
            </svg>
          )}

          <WordsLane take={take} x={x} W={W} h={H.words} sel={sel} player={player} top={pos.words.y} />

          {layers.pitch && (
            <ContourLane top={pos.pitch.y} h={pos.pitch.h} W={W} data={take.contours.pitch} step={take.contours.step} n={take.contours.n}
              v0={v0} v1={v1} x={x} range={[-9, 11]} color="var(--cat-pitch)" unit="st" showRef={layers.reference} />
          )}
          {layers.energy && (
            <ContourLane top={pos.energy.y} h={pos.energy.h} W={W} data={take.contours.energy} step={take.contours.step} n={take.contours.n}
              v0={v0} v1={v1} x={x} range={[-24, 10]} color="var(--cat-energy)" unit="dB" showRef={layers.reference} />
          )}
          {layers.deviation && <DeviationLane top={pos.deviation.y} h={H.deviation} take={take} x={x} W={W} />}

          {hover !== null && (
            <div className="pointer-events-none absolute top-0 bottom-0 w-px bg-ink/25" style={{ left: x(hover) }}>
              <span className="absolute -top-0 left-1.5 rounded bg-popover px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
                {fmt(hover)}s
              </span>
            </div>
          )}
          <Playhead player={player} x={x} W={W} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- minimap/ruler

function Minimap({ take, view, setView, width }: { take: Take; view: View; setView: Props["setView"]; width: number }) {
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
    setView([t - span / 2, t + span / 2], false);
  };
  return (
    <div className="mb-1 flex items-center">
      <div className="shrink-0 pr-3 text-[10.5px] font-medium uppercase tracking-[0.1em] text-faint" style={{ width: GUTTER }}>
        Take
      </div>
      <div
        className="relative cursor-grab overflow-hidden rounded-md bg-ink/[0.025] active:cursor-grabbing"
        style={{ width, height: H.minimap }}
        onPointerDown={(e) => {
          drag.current = true;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          panTo(e);
        }}
        onPointerMove={(e) => drag.current && panTo(e)}
        onPointerUp={() => (drag.current = false)}
      >
        <svg width={width} height={H.minimap} className="absolute inset-0">
          <path d={path} stroke="rgba(27,26,23,0.22)" strokeWidth={1} />
          {take.flaws.map((f, i) => (
            <rect key={i} x={(f.start / d) * width} y={H.minimap - 3} width={Math.max(2, ((f.end - f.start) / d) * width)} height={3}
              fill={CATEGORY[f.category].color} rx={1} />
          ))}
        </svg>
        <div
          className="absolute inset-y-0 rounded-[5px] border border-ink/40 bg-ink/[0.06]"
          style={{ left: (view[0] / d) * width, width: Math.max(4, ((view[1] - view[0]) / d) * width) }}
        />
      </div>
    </div>
  );
}

function Ruler({ v0, v1, W, sel, x }: { v0: number; v1: number; W: number; sel: Flaw | null; x: (t: number) => number }) {
  const step = niceStep(v1 - v0, W);
  const ticks: number[] = [];
  for (let t = Math.ceil(v0 / step) * step; t <= v1 + 1e-9; t += step) ticks.push(t);
  return (
    <div className="flex">
      <div className="shrink-0" style={{ width: GUTTER }} />
      <svg width={W} height={H.ruler} className="overflow-visible">
        {ticks.map((t) => (
          <g key={t.toFixed(3)}>
            <line x1={x(t)} x2={x(t)} y1={H.ruler - 6} y2={H.ruler} stroke="rgba(27,26,23,0.22)" />
            <text x={x(t) + 4} y={H.ruler - 8} fontSize={10} fill="var(--faint)" className="font-mono">
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
    </div>
  );
}

// ------------------------------------------------------------------- lanes

function Waveform({ take, player, v0, v1, W, H: h, sel }: { take: Take; player: Player; v0: number; v1: number; W: number; H: number; sel: Flaw | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const time = usePlayerTime(player);
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = W * dpr;
    c.height = h * dpr;
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, h);
    const p = take.peaks, n = p.bins, d = take.duration;
    const bar = 2, gap = 1, mid = h / 2;
    const selColor = sel ? getComputedStyle(document.documentElement).getPropertyValue(`--cat-${sel.category}`).trim() : "";
    for (let px = 0; px < W; px += bar + gap) {
      const ta = v0 + (px / W) * (v1 - v0), tb = v0 + ((px + bar + gap) / W) * (v1 - v0);
      const a = Math.floor((ta / d) * n), b = Math.max(a + 1, Math.floor((tb / d) * n));
      let hi = 0;
      for (let i = Math.max(0, a); i < Math.min(n, b); i++) hi = Math.max(hi, Math.abs(p.min[i]), Math.abs(p.max[i]));
      const amp = Math.max(1, Math.min(mid - 2, hi * h * 1.25));
      const inSel = sel && ta >= sel.start && ta <= sel.end;
      g.fillStyle = inSel ? selColor : ta <= time ? "rgba(27,26,23,0.82)" : "rgba(27,26,23,0.26)";
      g.beginPath();
      g.roundRect(px, mid - amp, bar, amp * 2, 1);
      g.fill();
    }
  }, [take, v0, v1, W, h, time, sel]);
  return <canvas ref={canvas} style={{ width: W, height: h }} className="block" />;
}

function FindingRegion({ f, x, h, selected, rank }: { f: Flaw; x: (t: number) => number; h: number; selected: boolean; rank?: number }) {
  const c = CATEGORY[f.category].color;
  const a = x(f.start), b = Math.max(x(f.end), a + 6);
  const lvl = f.severity.level;
  const fill = [0.1, 0.14, 0.2, 0.3, 0.42][lvl];
  const ua = x(f.start - f.start_uncertainty_s), ub = x(f.end + f.end_uncertainty_s);
  const Icon = CATEGORY[f.category].icon;
  return (
    <g className="cursor-pointer">
      <line x1={ua} x2={a} y1={h / 2} y2={h / 2} stroke={c} strokeOpacity={0.5} strokeDasharray="2 2" />
      <line x1={b} x2={ub} y1={h / 2} y2={h / 2} stroke={c} strokeOpacity={0.5} strokeDasharray="2 2" />
      <rect x={a} y={6} width={b - a} height={h - 12} rx={5} fill={c} fillOpacity={fill}
        stroke={selected ? "var(--ink)" : c} strokeOpacity={selected ? 0.9 : 0.55 + lvl * 0.1} strokeWidth={selected ? 1.5 : 1} />
      {rank !== undefined && (
        <g className="pointer-events-none">
          <circle cx={a} cy={h / 2} r={8} fill={selected ? c : "var(--surface)"} stroke={c} strokeWidth={1.25} />
          <text x={a} y={h / 2 + 3.5} textAnchor="middle" fontSize={10} fontWeight={600} fill={selected ? "#fff" : c} className="font-mono">{rank}</text>
        </g>
      )}
      {b - a > 92 ? (
        <foreignObject x={a + (rank !== undefined ? 12 : 6)} y={6} width={b - a - 16} height={h - 12} className="pointer-events-none">
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

function WordsLane({ take, x, W, h, sel, player, top }: { take: Take; x: (t: number) => number; W: number; h: number; sel: Flaw | null; player: Player; top: number }) {
  const time = usePlayerTime(player);
  const words = take.words;
  return (
    <div className="absolute inset-x-0 overflow-hidden" style={{ top, height: h }}>
      {words.map((w, i) => {
        if (w.start === null || w.end === null) return null;
        const a = x(w.start), b = x(w.end);
        if (b < -40 || a > W + 40) return null;
        const next = words.slice(i + 1).find((u) => u.start !== null);
        const avail = (next && next.start !== null ? x(next.start) : W) - a - 2;
        const inSel = sel && w.idx >= sel.start_idx && w.idx <= sel.end_idx;
        const playing = time >= w.start && time < w.end;
        if (avail < 34 && !inSel)
          return <div key={w.idx} className={cn("absolute top-[9px] h-[10px] w-px", playing ? "bg-ink" : "bg-ink/20")} style={{ left: a }} />;
        return (
          <div
            key={w.idx}
            className={cn(
              "absolute top-[5px] flex h-[20px] items-center truncate rounded-[4px] px-1 text-[12px] leading-none transition-colors",
              inSel ? "bg-highlight-soft text-ink" : "text-ink/60",
              playing && "text-ink",
              w.low_confidence && "underline decoration-ink/30 decoration-dotted underline-offset-[3px]",
            )}
            style={{ left: a, maxWidth: avail, background: playing ? "var(--highlight)" : undefined }}
          >
            {w.text}
          </div>
        );
      })}
    </div>
  );
}

function ContourLane({ top, h, W, data, step, n, v0, v1, x, range, color, unit, showRef }: {
  top: number; h: number; W: number; data: ContourSet; step: number; n: number; v0: number; v1: number;
  x: (t: number) => number; range: [number, number]; color: string; unit: string; showRef: boolean;
}) {
  const [lo, hi] = range;
  const y = (v: number) => h - 6 - ((clamp(v, lo, hi) - lo) / (hi - lo)) * (h - 12);
  const i0 = Math.max(0, Math.floor(v0 / step) - 1), i1 = Math.min(n - 1, Math.ceil(v1 / step) + 1);
  const xs = (i: number) => x(i * step).toFixed(1);
  let band = "";
  if (showRef) {
    let seg: number[] = [];
    const flush = () => {
      if (seg.length > 1)
        band += "M" + seg.map((i) => `${xs(i)},${y(data.band.hi[i]!).toFixed(1)}`).join("L") + "L" +
          [...seg].reverse().map((i) => `${xs(i)},${y(data.band.lo[i]!).toFixed(1)}`).join("L") + "Z";
      seg = [];
    };
    for (let i = i0; i <= i1; i++) data.band.lo[i] === null || data.band.hi[i] === null ? flush() : seg.push(i);
    flush();
  }
  const line = (arr: (number | null)[]) => {
    let d = "", pen = false;
    for (let i = i0; i <= i1; i++) {
      const v = arr[i];
      if (v === null) { pen = false; continue; }
      d += `${pen ? "L" : "M"}${xs(i)},${y(v).toFixed(1)}`;
      pen = true;
    }
    return d;
  };
  return (
    <svg className="absolute inset-x-0" style={{ top }} width={W} height={h}>
      <line x1={0} x2={W} y1={y(0)} y2={y(0)} stroke="rgba(27,26,23,0.12)" strokeDasharray="2 4" />
      {showRef && <path d={band} fill="rgba(27,26,23,0.1)" />}
      {showRef && <path d={line(data.band.median)} fill="none" stroke="rgba(27,26,23,0.4)" strokeWidth={1} strokeDasharray="3 3" />}
      <path d={line(data.take)} fill="none" stroke={color} strokeOpacity={v1 - v0 > 20 ? 0.75 : 0.95} strokeWidth={v1 - v0 > 20 ? 1.1 : 1.6}
        strokeLinejoin="round" strokeLinecap="round" />
      <text x={W - 6} y={11} textAnchor="end" fontSize={9.5} fill="var(--faint)" stroke="var(--paper)" strokeWidth={3} paintOrder="stroke" className="font-mono">
        {unit} re speaker median{showRef ? " · band = references" : ""}
      </text>
    </svg>
  );
}

function DeviationLane({ top, h, take, x, W }: { top: number; h: number; take: Take; x: (t: number) => number; W: number }) {
  const row = (h - 6) / CATEGORIES.length;
  const zOpen = take.detection_settings.z_open;
  return (
    <svg className="absolute inset-x-0" style={{ top }} width={W} height={h}>
      {CATEGORIES.map((cat: Category, r) =>
        take.words.map((w, i) => {
          const c = w.categories[cat];
          if (!c || w.start === null || c.score < 1) return null;
          const next = take.words.slice(i + 1).find((u) => u.start !== null);
          const a = x(w.start), b = next && next.start !== null ? x(next.start) : x(w.end ?? w.start);
          if (b < 0 || a > W) return null;
          return (
            <rect key={`${cat}-${w.idx}`} x={a} y={3 + r * row} width={Math.max(1, b - a - 1)} height={row - 2} rx={1.5}
              fill={CATEGORY[cat].color} fillOpacity={Math.min(0.9, c.score / (zOpen + 2))} />
          );
        }),
      )}
    </svg>
  );
}

function Playhead({ player, x, W }: { player: Player; x: (t: number) => number; W: number }) {
  const t = usePlayerTime(player);
  const px = x(t);
  if (px < 0 || px > W) return null;
  return (
    <div className="pointer-events-none absolute top-0 bottom-0 w-[1.5px] bg-ink" style={{ left: px }}>
      <div className="absolute -top-px -left-[4px] size-[9.5px] rotate-45 rounded-[2px] bg-ink" />
    </div>
  );
}
