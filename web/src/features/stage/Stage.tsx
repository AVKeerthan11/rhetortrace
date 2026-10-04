import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CATEGORY } from "@/lib/categories";
import { evidenceSpan } from "@/lib/evidence";
import { fmt } from "@/lib/format";
import { wash } from "@/lib/grammar";
import { duration, ease } from "@/lib/motion";
import { useProofPhase, usePlayerState, type Player } from "@/lib/player";
import type { Layers } from "@/lib/store";
import { referenceName } from "@/lib/takes";
import { cursor } from "@/lib/time";
import type { Flaw, Take, Word } from "@/lib/types";
import {
  ContourLane, DeviationLane, FindingRegion, LiveTrace, Minimap, Playhead, PointerLine, Ruler, TruthLane, Waveform, WordsLane,
} from "./lanes";
import { AnalysisTrace, CrosshairReadout, ScoreLane, shouldTrace } from "./instruments";
import { ThreadsLane } from "./threads";
import { useStage, type Level } from "./store";

// The recording stage: one waveform and its lanes, shown on every screen of a recording. The
// zoom level decides the lanes (overview: audio, findings and the words' rhythm; a finding: plus
// the words, the reference deliveries' timing and the measurement it is about; explorer: every
// lane), and the camera (useStage().view) decides the time window. Lanes open and close in
// place, so going deeper reads as the stage unfolding.
//
// Time: the pointer over the stage sets the shared cursor (lib/time), which every time-aware
// surface follows; dragging on the ruler or the waveform scrubs the playhead; dragging elsewhere
// pans. The playhead and pointer line are imperative overlays: the stage re-renders when the
// camera moves, not during playback.

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

type LaneKey = "ruler" | "wave" | "truth" | "findings" | "score" | "words" | "threads" | "pitch" | "energy" | "deviation";

interface Lane {
  key: LaneKey;
  label: string;
  h: number;
}

/** Lanes a drag scrubs the playhead on (elsewhere a drag pans the camera). */
const SCRUB_LANES = new Set<string>(["ruler", "wave"]);

const isTiming = (f: Flaw | null) => !!f && (f.category === "pause" || f.category === "pacing");

function lanesFor(take: Take, level: Level, layers: Layers, sel: Flaw | null, narrow: boolean): Lane[] {
  const explore = level === "explore";
  const contour = (k: "pitch" | "energy") => (explore ? layers[k] : level === "finding" && sel?.category === k);
  // threads: on a timing finding, and in the explorer as a lane of its own
  const threads = take.references.length > 0 && ((level === "finding" && isTiming(sel)) || (explore && layers.threads));
  return [
    { key: "ruler" as const, label: "", h: 20 },
    { key: "wave" as const, label: "Audio", h: level === "overview" ? (narrow ? 96 : 136) : narrow ? 64 : 84 },
    ...(explore && layers.truth && take.ground_truth ? [{ key: "truth" as const, label: "Injected", h: 16 }] : []),
    { key: "findings" as const, label: "Findings", h: level === "overview" ? 40 : narrow ? 30 : 34 },
    ...(level !== "finding" && take.flaws.length ? [{ key: "score" as const, label: "Score", h: level === "overview" ? 40 : 34 }] : []),
    { key: "words" as const, label: "Words", h: level === "overview" ? 24 : 28 },
    ...(threads ? [{ key: "threads" as const, label: "Threads", h: 26 + 30 * take.references.length }] : []),
    ...(contour("pitch") ? [{ key: "pitch" as const, label: "Pitch", h: explore ? 62 : narrow ? 64 : 92 }] : []),
    ...(contour("energy") ? [{ key: "energy" as const, label: "Energy", h: explore ? 48 : narrow ? 56 : 80 }] : []),
    ...(explore && layers.deviation ? [{ key: "deviation" as const, label: "Deviation", h: 44 }] : []),
  ];
}

export function Stage({ take, level, player, ranks, focus, layers, onFinding, onWord }: {
  take: Take;
  level: Level;
  player: Player;
  /** finding number per flaw index */
  ranks: number[];
  /** flaw index of the finding open at the "finding" level */
  focus: number | null;
  layers: Layers;
  onFinding: (flawIndex: number) => void;
  onWord: (w: Word) => void;
}) {
  const [wrap, width] = useWidth<HTMLDivElement>();
  const narrow = width > 0 && width < 640;
  const GUTTER = narrow ? 0 : 84;
  const W = Math.max(100, width - GUTTER);
  const view = useStage((s) => s.view);
  const hovered = useStage((s) => s.hovered);
  const selected = useStage((s) => s.selected);
  const refIdx = useStage((s) => s.refIdx);
  const proof = useProofPhase(player);
  const [v0, v1] = view;
  const x = (t: number) => ((t - v0) / (v1 - v0)) * W;
  const tAt = (px: number) => v0 + (px / W) * (v1 - v0);
  const selIdx = level === "finding" ? focus : level === "explore" ? selected : null;
  const sel = selIdx !== null ? take.flaws[selIdx] : null;
  const lanes = lanesFor(take, level, layers, sel, narrow);
  const freeZoom = level === "explore";
  const refLabel = (id: string) => referenceName(take, id);

  // the analysis trace, once per recording (first opened on its overview)
  const traceId = `trace-${useId().replace(/:/g, "")}`;
  const [tracing, setTracing] = useState(() => level === "overview" && shouldTrace(take.id));
  const endTrace = useCallback(() => setTracing(false), []);
  const clip = tracing ? traceId : undefined;

  // ---------------------------------------------------------- pointer handling
  const stack = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: "pan" | "scrub"; x0: number; v: [number, number]; moved: boolean } | null>(null);
  const localX = (clientX: number) => clientX - (stack.current?.getBoundingClientRect().left ?? 0) - GUTTER;
  const laneAt = (clientX: number, clientY: number) =>
    (document.elementFromPoint(clientX, clientY)?.closest("[data-lane]") as HTMLElement | null)?.dataset.lane ?? null;
  const flawAt = (px: number) => {
    // smallest hit first: overlapping findings stay selectable
    const hits = take.flaws.map((f, i) => ({ i, a: x(f.start) - 9, b: Math.max(x(f.end), x(f.start) + 6) + 3 }))
      .filter((h) => h.a <= px && px <= h.b).sort((p, q) => p.b - p.a - (q.b - q.a));
    return hits[0]?.i ?? -1;
  };
  const setHovered = useStage.getState().setHovered;
  const pointTo = (px: number, source: "stage" | "scrub") => {
    if (px < 0 || px > W) return cursor.clear("stage");
    cursor.set(Math.max(0, Math.min(take.duration, tAt(px))), source);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const px = localX(e.clientX);
    const scrub = px >= 0 && SCRUB_LANES.has(laneAt(e.clientX, e.clientY) ?? "");
    drag.current = { mode: scrub ? "scrub" : "pan", x0: px, v: [v0, v1], moved: false };
    if (scrub) {
      player.seek(Math.max(0, tAt(px)));
      pointTo(px, "scrub");
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const px = localX(e.clientX);
    const d = drag.current;
    if (!d) {
      pointTo(px, "stage");
      const lane = laneAt(e.clientX, e.clientY);
      setHovered(lane === "findings" || lane === "score" ? (flawAt(px) >= 0 ? flawAt(px) : null) : null);
      return;
    }
    const dx = px - d.x0;
    if (Math.abs(dx) > 3) d.moved = true;
    if (d.mode === "scrub") {
      const t = Math.max(0, Math.min(take.duration, tAt(px)));
      player.seek(t);
      cursor.set(t, "scrub");
    } else if (d.moved) {
      const dt = (dx / W) * (d.v[1] - d.v[0]);
      useStage.getState().setView([d.v[0] - dt, d.v[1] - dt], { smooth: false });
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    const px = localX(e.clientX);
    if (d?.mode === "scrub") return pointTo(px, "stage");
    if (!d || d.moved || px < 0) return;
    const lane = laneAt(e.clientX, e.clientY);
    if (lane === "findings" || lane === "score") {
      const hit = flawAt(px);
      if (hit >= 0) return onFinding(hit);
    }
    if (lane === "words") {
      const word = take.words.find((wd) => wd.start !== null && wd.end !== null && x(wd.start) <= px && px <= x(wd.end) + 2);
      if (word) return onWord(word);
    }
    player.seek(tAt(px));
  };
  const onPointerLeave = () => {
    if (drag.current) return;
    cursor.clear("stage");
    cursor.clear("scrub");
    setHovered(null);
  };

  // wheel: zooms freely in the explorer; elsewhere only with Ctrl / ⌘ so the page still scrolls
  useEffect(() => {
    const el = stack.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!freeZoom && !e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const { view: [a, b], setView: set } = useStage.getState();
      const r = el.getBoundingClientRect();
      const w = r.width - GUTTER;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && !e.ctrlKey) {
        const dt = (e.deltaX / w) * (b - a);
        set([a + dt, b + dt], { smooth: false });
        return;
      }
      const k = Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0018));
      const c = a + ((e.clientX - r.left - GUTTER) / w) * (b - a);
      set([c - (c - a) * k, c + (b - c) * k], { smooth: false });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [freeZoom, GUTTER]);

  // the measurement a finding rests on, placed where it was taken (finding level only)
  const evidence = useMemo(() => {
    if (level !== "finding" || !sel?.explanation.strongest_evidence) return null;
    const m = sel.explanation.strongest_evidence;
    const span = evidenceSpan(take, m);
    return span && m.observed !== null ? { span, m } : null;
  }, [level, sel, take]);

  const laneBody = (l: Lane) => {
    switch (l.key) {
      case "ruler":
        return <Ruler v0={v0} v1={v1} W={W} h={l.h} sel={sel} x={x} />;
      case "wave":
        return (
          <>
            <Waveform take={take} v0={v0} v1={v1} W={W} H={l.h} sel={sel} hovered={hovered} />
            <LiveTrace v0={v0} v1={v1} W={W} h={l.h} />
            {evidence && <EvidenceMark f={sel!} span={evidence.span} label={evidenceLabel(evidence.m)} x={x} strong={proof === "take"} />}
          </>
        );
      case "truth":
        return <TruthLane take={take} x={x} h={l.h} W={W} />;
      case "findings":
        return (
          <svg className="absolute inset-0" width={W} height={l.h} role="img" aria-label="Findings">
            <g clipPath={clip ? `url(#${clip})` : undefined}>
              {take.flaws.map((f, i) => (
                <FindingRegion key={i} f={f} x={x} h={l.h} rank={ranks[i]} selected={i === selIdx} hovered={i === hovered}
                  dim={level === "finding" && i !== selIdx} />
              ))}
            </g>
          </svg>
        );
      case "score":
        return <ScoreLane take={take} x={x} v0={v0} v1={v1} W={W} h={l.h} hovered={hovered} selected={selIdx} clipId={clip} />;
      case "words":
        return <WordsLane take={take} x={x} v0={v0} v1={v1} W={W} h={l.h} sel={sel} />;
      case "threads":
        return (
          <ThreadsLane take={take} x={x} v0={v0} v1={v1} W={W} h={l.h} sel={sel} refIdx={refIdx} labels={refLabel} proof={proof}
            anchor={sel && take.words[sel.start_idx].start !== null ? take.words[sel.start_idx].start! : (v0 + v1) / 2}
            caliper={evidence ? { m: evidence.m, span: evidence.span } : null} />
        );
      case "pitch":
        return <ContourLane h={l.h} W={W} data={take.contours.pitch} step={take.contours.step} n={take.contours.n} v0={v0} v1={v1}
          range={[-9, 11]} color="var(--cat-pitch)" unit="st" showRef={layers.reference || level !== "explore"} />;
      case "energy":
        return <ContourLane h={l.h} W={W} data={take.contours.energy} step={take.contours.step} n={take.contours.n} v0={v0} v1={v1}
          range={[-24, 10]} color="var(--cat-energy)" unit="dB" showRef={layers.reference || level !== "explore"} />;
      case "deviation":
        return <DeviationLane h={l.h} take={take} x={x} v0={v0} v1={v1} W={W} />;
    }
  };

  return (
    <div ref={wrap} className="relative select-none" data-level={level}>
      <AnimatePresence initial={false}>
        {freeZoom && !narrow && width > 0 && (
          <motion.div key="minimap" className="flex items-center overflow-hidden"
            initial={{ height: 0, opacity: 0 }} animate={{ height: 26, opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: duration.standard, ease }}>
            <div className="shrink-0 pr-3 text-[10.5px] font-medium tracking-[0.1em] text-faint uppercase" style={{ width: GUTTER }}>Take</div>
            <Minimap take={take} view={view} setView={useStage.getState().setView} width={W} />
          </motion.div>
        )}
      </AnimatePresence>

      <div
        ref={stack}
        className="relative cursor-crosshair touch-pan-y"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeave}
      >
        <AnimatePresence initial={false}>
          {width > 0 && lanes.map((l) => (
            <motion.div key={l.key} data-lane={l.key} className="flex overflow-hidden"
              initial={{ height: 0, opacity: 0 }} animate={{ height: l.h, opacity: 1 }} exit={{ height: 0, opacity: 0 }}
              transition={{ duration: duration.standard, ease }}>
              <div className="flex shrink-0 items-center pr-3 text-[10.5px] font-medium tracking-[0.1em] text-faint uppercase" style={{ width: GUTTER }}>
                {GUTTER > 0 && l.label}
              </div>
              <div className={l.key === "ruler" ? "relative" : "relative border-t border-hairline"}
                style={{ width: W, height: l.h, cursor: SCRUB_LANES.has(l.key) ? "ew-resize" : undefined }}>
                {laneBody(l)}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

        {/* overlays across every lane: the open finding, its evidence, the loop, the pointer, the playhead */}
        {width > 0 && (
          <div className="pointer-events-none absolute top-0 bottom-0 overflow-hidden" style={{ left: GUTTER, width: W }}>
            {sel && (
              <div className="absolute top-[20px] bottom-0"
                style={{
                  left: x(sel.start),
                  width: Math.max(2, x(sel.end) - x(sel.start)),
                  background: wash(sel.category, 0.09),
                  boxShadow: `inset 1px 0 0 ${wash(sel.category, 0.7)}, inset -1px 0 0 ${wash(sel.category, 0.7)}`,
                }} />
            )}
            <LoopMark player={player} x={x} />
            <div className="absolute inset-x-0 top-[20px] bottom-0">
              <PointerLine take={take} v0={v0} v1={v1} W={W} />
              <Playhead v0={v0} v1={v1} W={W} />
              {!narrow && <CrosshairReadout take={take} v0={v0} v1={v1} W={W} />}
            </div>
            {tracing && <AnalysisTrace id={traceId} takeId={take.id} W={W} onDone={endTrace} />}
          </div>
        )}
      </div>
    </div>
  );
}

function evidenceLabel(m: NonNullable<Flaw["explanation"]["strongest_evidence"]>) {
  const obs = `${m.bound === "upper" ? "≤" : ""}${fmt(m.observed!, 2)}`;
  return m.reference !== null ? `${obs} vs ${fmt(m.reference, 2)} ${m.unit}` : `${obs} ${m.unit}`;
}

/** The strongest measurement of the open finding, drawn on the audio where it was measured:
 *  deviation is a filled area (the gap of a pause, or the word measured) with its value against
 *  the references. Only on the audio lane, so the lanes below (words, references) stay legible. */
function EvidenceMark({ f, span, label, x, strong }: {
  f: Flaw; span: { start: number; end: number; kind: "word" | "gap" }; label: string; x: (t: number) => number; strong: boolean;
}) {
  const a = x(span.start), b = Math.max(x(span.end), a + 3);
  const c = CATEGORY[f.category].color;
  return (
    <motion.div className="pointer-events-none absolute inset-y-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.35, duration: duration.standard, ease }}
      style={{
        left: a, width: b - a,
        background: `repeating-linear-gradient(135deg, ${wash(f.category, strong ? 0.45 : 0.26)} 0 4px, ${wash(f.category, strong ? 0.25 : 0.12)} 4px 8px)`,
        boxShadow: strong ? `inset 0 0 0 2px ${c}` : undefined,
      }}
      data-evidence={span.kind}>
      <span className="absolute top-1 left-1/2 z-10 -translate-x-1/2 rounded px-1.5 py-[1px] font-mono text-[10px] whitespace-nowrap text-[var(--on-category)]"
        style={{ background: c }}>
        {span.kind === "gap" ? "pause " : ""}{label}
      </span>
    </motion.div>
  );
}

/** The looped range (L), if any: a bracket on the ruler and a faint wash below. */
function LoopMark({ player, x }: { player: Player; x: (t: number) => number }) {
  const { loop } = usePlayerState(player);
  if (!loop) return null;
  const a = x(loop[0]), b = x(loop[1]);
  return (
    <div className="absolute top-[3px] bottom-0" style={{ left: a, width: Math.max(2, b - a) }}>
      <div className="h-[5px] rounded-t-[3px] border-x-[1.5px] border-t-[1.5px] border-ink/70" />
      <div className="absolute inset-x-0 top-[17px] bottom-0 bg-ink/[0.035]" />
    </div>
  );
}
