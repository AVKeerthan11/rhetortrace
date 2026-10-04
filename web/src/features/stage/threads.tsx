import { memo, useMemo, useRef } from "react";
import { refTimeAt } from "@/lib/align";
import { CATEGORY } from "@/lib/categories";
import type { EvidenceSpan } from "@/lib/evidence";
import { fmt } from "@/lib/format";
import { NOW, REF, wash } from "@/lib/grammar";
import { useTimeEffect, useWordFocus } from "@/lib/time";
import type { Flaw, Measurement, Take } from "@/lib/types";
import type { X } from "./lanes";

// Rhythm threads: this recording's words on the top row, each reference delivery's words on a
// row below, and a thread joining every word to the same word in each delivery. The references
// are drawn on their own clocks, shifted so that they agree with this recording at the anchor
// (the finding's first word, or the middle of the view): where the deliveries keep the same
// rhythm the threads hang straight down; rushing slants them one way, dragging the other, and a
// pause one delivery takes and another does not fans them apart. Exported alignments only.

export interface Caliper {
  m: Measurement;
  span: EvidenceSpan;
}

/** The reference's span for the same measurement (the same word, or the gap after it). */
function refSpan(take: Take, k: number, c: Caliper): [number, number] | null {
  const r = take.references[k].words;
  const i = c.m.idx;
  if (c.span.kind === "gap") {
    const next = take.words.findIndex((w, j) => j > i && w.start !== null);
    const a = r[i]?.[1], b = next >= 0 ? r[next]?.[0] : null;
    return a != null && b != null ? [a, b] : null;
  }
  const a = r[i]?.[0], b = r[i]?.[1];
  return a != null && b != null ? [a, b] : null;
}

export const ThreadsLane = memo(function ThreadsLane({ take, x, v0, v1, W, h, sel, anchor, refIdx, labels, caliper, proof }: {
  take: Take; x: X; v0: number; v1: number; W: number; h: number; sel: Flaw | null;
  /** time in this recording where all deliveries are lined up */
  anchor: number;
  /** the reference delivery chosen for comparisons (and for hold-to-hear) */
  refIdx: number;
  labels: (id: string) => string;
  /** the open finding's strongest measurement, measured in every row */
  caliper: Caliper | null;
  /** which half of "play the proof" is audible */
  proof: "take" | "ref" | null;
}) {
  const { playing, pointed } = useWordFocus(take);
  const nRefs = take.references.length;
  const top = 12, rowH = (h - top - 6) / Math.max(1, nRefs);
  const rowY = (k: number) => (k < 0 ? top : top + (k + 1) * rowH - 2);
  const shifts = useMemo(() => take.references.map((_, k) => {
    const rt = refTimeAt(take, k, anchor);
    return rt === null ? null : anchor - rt;
  }), [take, anchor]);

  const geo = useMemo(() => {
    const pad = (v1 - v0) * 0.15;
    const out: { i: number; d: string; rows: { a: number; b: number; y: number; k: number }[] }[] = [];
    take.words.forEach((w, i) => {
      if (w.start === null || w.end === null || w.end < v0 - pad || w.start > v1 + pad) return;
      const rows = [{ a: x(w.start), b: x(w.end), y: rowY(-1), k: -1 }];
      take.references.forEach((r, k) => {
        const rw = r.words[i], s = shifts[k];
        if (!rw || rw[0] === null || rw[1] === null || s === null) return;
        rows.push({ a: x(rw[0] + s), b: x(rw[1] + s), y: rowY(k), k });
      });
      let d = `M${rows[0].a.toFixed(1)},${rows[0].y}`;
      for (let j = 1; j < rows.length; j++) {
        const p = rows[j - 1], q = rows[j], c = (q.y - p.y) * 0.55;
        d += `C${p.a.toFixed(1)},${(p.y + c).toFixed(1)} ${q.a.toFixed(1)},${(q.y - c).toFixed(1)} ${q.a.toFixed(1)},${q.y.toFixed(1)}`;
      }
      out.push({ i, d, rows });
    });
    return out;
    // x and rowY derive from v0/v1/W/h
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [take, v0, v1, W, h, shifts]);

  const inSel = (i: number) => !!sel && i >= sel.start_idx && i <= sel.end_idx;
  const cat = sel ? CATEGORY[sel.category].color : null;

  // "where would each reference speaker be now": a ghost head per row at the playhead's point of the script
  const heads = useRef<(SVGGElement | null)[]>([]);
  useTimeEffect("playhead", (t) => {
    take.references.forEach((_, k) => {
      const g = heads.current[k], s = shifts[k];
      if (!g) return;
      const rt = t === null || s === null ? null : refTimeAt(take, k, t);
      const px = rt === null ? -99 : x(rt + s!);
      g.setAttribute("transform", `translate(${px},${rowY(k)})`);
      g.style.visibility = px < -10 || px > W + 10 ? "hidden" : "visible";
    });
  }, [take, v0, v1, W, h, shifts]);

  return (
    <svg className="absolute inset-0" width={W} height={h} role="img" aria-label="Rhythm threads: this recording's words joined to the same words in each reference delivery">
      {/* row baselines and names */}
      {[-1, ...take.references.map((_, k) => k)].map((k) => (
        <line key={k} x1={0} x2={W} y1={rowY(k)} y2={rowY(k)} stroke={k === refIdx ? REF.line : REF.band} strokeWidth={k === -1 ? 1 : 0.75} />
      ))}
      {/* threads */}
      {geo.map(({ i, d }) => {
        const hot = i === playing || i === pointed;
        const mine = inSel(i);
        return (
          <path key={i} d={d} fill="none" strokeLinecap="round"
            stroke={hot ? NOW : mine && cat ? cat : REF.ghost}
            strokeOpacity={hot ? 0.9 : mine ? 0.85 : 0.28} strokeWidth={hot || mine ? 1.4 : 0.9} />
        );
      })}
      {/* the words as short bars on each row: duration at a glance */}
      {geo.map(({ i, rows }) => rows.map((r) => (
        <rect key={`${i}-${r.k}`} x={r.a} y={r.y - 2} width={Math.max(1.5, r.b - r.a - 1)} height={4} rx={2}
          fill={r.k === -1 ? (inSel(i) && cat ? cat : "var(--ink)") : inSel(i) && cat ? wash(cat, 0.55) : REF.ghost}
          fillOpacity={r.k === -1 ? 0.8 : 0.55} />
      )))}
      {/* the open finding's measurement in every delivery: calipers */}
      {caliper && cat && (
        <g>
          <CaliperMark a={x(caliper.span.start)} b={x(caliper.span.end)} y={rowY(-1)} color={cat} strong={proof === "take"} anchor="take" below
            label={`${caliper.m.bound === "upper" ? "≤" : ""}${fmt(caliper.m.observed ?? 0, 2)} ${caliper.m.unit}`} />
          {take.references.map((r, k) => {
            const sp = refSpan(take, k, caliper), s = shifts[k];
            if (!sp || s === null) return null;
            const pt = caliper.m.reference_points?.find((p) => p.take === r.take_id)?.value;
            return (
              <CaliperMark key={k} a={x(sp[0] + s!)} b={x(sp[1] + s!)} y={rowY(k)} color={REF.line} strong={proof === "ref" && k === refIdx}
                anchor={`ref-${k}`} label={`${fmt(pt ?? sp[1] - sp[0], 2)} ${caliper.m.unit}`} />
            );
          })}
        </g>
      )}
      {/* ghost heads */}
      {take.references.map((_, k) => (
        <g key={k} ref={(el) => { heads.current[k] = el; }} style={{ visibility: "hidden" }}>
          <circle r={3.5} fill="var(--stage)" stroke={k === refIdx ? "var(--ink)" : REF.ghost} strokeWidth={1.5} />
        </g>
      ))}
      {W > 380 && take.references.map((r, k) => (
        <text key={k} x={W - 4} y={rowY(k) - 4} textAnchor="end" fontSize={9.5} className="font-mono" fill={k === refIdx ? "var(--ink)" : "var(--faint)"}
          stroke="var(--stage)" strokeWidth={3} paintOrder="stroke">
          {labels(r.take_id)}
        </text>
      ))}
      {W > 380 && (
        <text x={W - 4} y={rowY(-1) - 4} textAnchor="end" fontSize={9.5} className="font-mono" fill="var(--ink)" stroke="var(--stage)" strokeWidth={3} paintOrder="stroke">
          this recording
        </text>
      )}
    </svg>
  );
});

/** A measured span on a row: end ticks, a bar, and its value. */
function CaliperMark({ a, b, y, color, label, strong, anchor, below }: {
  a: number; b: number; y: number; color: string; label: string; strong: boolean; anchor: string;
  /** put a centred value under the span (the top row has no room above it) */
  below?: boolean;
}) {
  const w = Math.max(2, b - a);
  const inside = w > label.length * 6.2 + 8;
  return (
    <g data-proof-anchor={anchor} className="transition-opacity">
      <rect x={a} y={y - 6} width={w} height={12} rx={2} fill={color} fillOpacity={strong ? 0.32 : 0.14} />
      <path d={`M${a},${y - 7}V${y + 7}M${a + w},${y - 7}V${y + 7}`} stroke={color} strokeWidth={strong ? 2 : 1.25} />
      {/* the value: centred above the span when it fits, else just after it */}
      <text x={inside ? a + w / 2 : a + w + 4} y={inside ? (below ? y + 17 : y - 9) : y + 3.5} textAnchor={inside ? "middle" : "start"} fontSize={10} fontWeight={strong ? 600 : 500}
        className="font-mono" fill={color} stroke="var(--stage)" strokeWidth={3} paintOrder="stroke">
        {label}
      </text>
    </g>
  );
}

export { refSpan };
