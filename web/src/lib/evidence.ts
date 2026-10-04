import type { Flaw, Measurement, Take } from "./types";

// Where evidence lives on this recording's time axis, so the stage can draw it in place:
// a measurement is about a word (its duration, pitch, energy) or about the gap after it.

export interface EvidenceSpan {
  start: number;
  end: number;
  kind: "word" | "gap";
}

/** The stretch of this recording a measurement was taken on, or null if the word is untimed. */
export function evidenceSpan(take: Take, m: Pick<Measurement, "idx" | "feature">): EvidenceSpan | null {
  const w = take.words[m.idx];
  if (!w || w.start === null || w.end === null) return null;
  if (m.feature.startsWith("pause_after")) {
    const next = take.words.slice(m.idx + 1).find((u) => u.start !== null);
    return next?.start != null ? { start: w.end, end: next.start, kind: "gap" } : null;
  }
  return { start: w.start, end: w.end, kind: "word" };
}

export interface TimingRow {
  label: string;
  own: boolean;
  /** words placed on THIS recording's time axis (see anchor), null when untimed */
  words: ({ i: number; start: number; end: number } | null)[];
  /** the finding's words' duration in this delivery, or for pauses the silence after them */
  spanDur: number | null;
}

/** This recording's and each reference delivery's words around a finding, every row anchored so
 *  the finding's first word starts at the same instant as in this recording. Drawn on the stage's
 *  time axis, differences in duration and pausing line up against this recording's own words. */
export function timingRows(take: Take, f: Flaw, pad = 2): TimingRow[] {
  const a = Math.max(0, f.start_idx - pad);
  const b = Math.min(take.words.length - 1, f.end_idx + pad);
  const idx = Array.from({ length: b - a + 1 }, (_, k) => a + k);
  const anchor = take.words[f.start_idx].start;
  const isPause = f.category === "pause";
  const rows = [
    { label: "This recording", own: true, times: idx.map((i) => [take.words[i].start, take.words[i].end] as const) },
    ...take.references.map((r) => ({ label: r.take_id, own: false, times: idx.map((i) => r.words[i] ?? [null, null]) })),
  ];
  return rows.map((row) => {
    const own0 = row.times[f.start_idx - a][0];
    const shift = anchor !== null && own0 !== null ? anchor - own0 : 0;
    const words = row.times.map(([s, e], k) => (s === null || e === null ? null : { i: idx[k], start: s + shift, end: e + shift }));
    const span = words.filter((w) => w && w.i >= f.start_idx && w.i <= f.end_idx) as { start: number; end: number }[];
    let spanDur = span.length ? span[span.length - 1].end - span[0].start : null;
    if (isPause) {
      const last = words.find((w) => w?.i === f.end_idx), next = words.find((w) => w?.i === f.end_idx + 1);
      spanDur = last && next ? Math.max(0, next.start - last.end) : null;
    }
    return { label: row.label, own: row.own, words, spanDur };
  });
}
