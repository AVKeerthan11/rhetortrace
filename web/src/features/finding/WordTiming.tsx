import { motion } from "motion/react";
import { CATEGORY } from "@/lib/categories";
import { fmt } from "@/lib/format";
import { ease } from "@/lib/motion";
import { referenceName } from "@/lib/takes";
import type { Flaw, Take } from "@/lib/types";

const PAD_WORDS = 2;

/** This recording's words against each reference delivery's words, all on one seconds axis
 *  starting at the first word shown. Pauses read as gaps; rushing / dragging as shorter /
 *  longer rows. Uses the exported word alignments only. */
export function WordTiming({ take, f }: { take: Take; f: Flaw }) {
  const a = Math.max(0, f.start_idx - PAD_WORDS);
  const b = Math.min(take.words.length - 1, f.end_idx + PAD_WORDS);
  const idx = Array.from({ length: b - a + 1 }, (_, k) => a + k);
  const color = CATEGORY[f.category].color;
  const isPause = f.category === "pause";

  const rows = [
    { label: "This recording", own: true, times: idx.map((i) => [take.words[i].start, take.words[i].end] as const) },
    ...take.references.map((r) => ({ label: `Reference ${referenceName(take, r.take_id)}`, own: false, times: idx.map((i) => r.words[i] ?? [null, null]) })),
  ].map((row) => {
    const t0 = row.times.find(([s]) => s !== null)?.[0] ?? 0;
    const words = row.times.map(([s, e], k) => (s === null || e === null ? null : { i: idx[k], s: s - t0, e: e - t0 }));
    const span = words.filter((w) => w && w.i >= f.start_idx && w.i <= f.end_idx) as { s: number; e: number }[];
    let spanDur = span.length ? span[span.length - 1].e - span[0].s : null;
    if (isPause) {
      // for pauses, the number that matters is the silence after the last word of the finding
      const last = words.find((w) => w?.i === f.end_idx), next = words.find((w) => w?.i === f.end_idx + 1);
      spanDur = last && next ? Math.max(0, next.s - last.e) : null;
    }
    return { ...row, words, total: Math.max(0, ...words.map((w) => w?.e ?? 0)), spanDur };
  });
  const scale = Math.max(...rows.map((r) => r.total)) || 1;

  return (
    <div className="space-y-2">
      {rows.map((row, ri) => (
        <div key={row.label} className="flex items-center gap-3">
          <div className={`w-[118px] shrink-0 text-[12px] ${row.own ? "font-medium text-ink" : "text-muted-foreground"}`}>{row.label}</div>
          <div className="relative h-7 flex-1 rounded-md bg-ink/[0.035]">
            {row.words.map((w, k) => {
              if (!w) return null;
              const inSpan = w.i >= f.start_idx && w.i <= f.end_idx;
              return (
                <motion.div key={k}
                  initial={{ opacity: 0, scaleX: 0.6 }} animate={{ opacity: 1, scaleX: 1 }} transition={{ delay: 0.05 * ri + 0.02 * k, duration: 0.35, ease }}
                  className="absolute top-1 bottom-1 flex origin-left items-center overflow-hidden rounded-[4px] px-1 text-[11px] whitespace-nowrap"
                  style={{
                    left: `${(w.s / scale) * 100}%`,
                    width: `${Math.max(0.6, ((w.e - w.s) / scale) * 100)}%`,
                    background: inSpan ? `color-mix(in oklab, ${color} ${row.own ? 30 : 16}%, var(--surface))` : "var(--surface)",
                    boxShadow: `inset 0 0 0 1px ${inSpan ? `color-mix(in oklab, ${color} 45%, transparent)` : "rgba(27,26,23,0.1)"}`,
                  }}
                  title={`${take.words[w.i].text}: ${fmt(w.e - w.s)} s`}
                >
                  {take.words[w.i].text}
                </motion.div>
              );
            })}
          </div>
          <div className="w-[64px] shrink-0 text-right font-mono text-[11.5px] text-muted-foreground tabular">
            {row.spanDur !== null ? `${fmt(row.spanDur, 2)} s` : "—"}
          </div>
        </div>
      ))}
      <p className="pl-[130px] text-[11.5px] text-faint">
        {isPause
          ? "The gap after the coloured word is the pause. The time on the right is that pause in each delivery."
          : "Coloured words are the finding. The time on the right is how long they took in each delivery."}
      </p>
    </div>
  );
}
