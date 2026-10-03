import { fmt } from "./format";
import type { Category, Flaw, Measurement, Take, Track, Word } from "./types";

// Presentation helpers for findings. Everything here re-words or selects values the pipeline
// exported; nothing re-computes analysis results.

/** Flaw indices in importance order. "Finding N" everywhere in the UI means position N here. */
export function rankFindings(take: Take): number[] {
  return take.flaws
    .map((_, i) => i)
    .sort((a, b) => take.flaws[b].severity.score - take.flaws[a].severity.score || take.flaws[a].start - take.flaws[b].start);
}

/** Plain-language finding titles, keyed by category/direction. */
export function plainTitle(t: Pick<Track, "category" | "direction">): string {
  return (
    {
      "pacing/fast": "Spoke too fast",
      "pacing/slow": "Spoke too slowly",
      "pitch/flatter": "Flat, monotone pitch",
      "pitch/livelier": "Exaggerated pitch swings",
      "pause/long": "Paused too long",
      "pause/short": "Missing or rushed pause",
      "energy/quiet": "Energy dropped",
      "energy/loud": "Pushed too loud",
    } as Record<string, string>
  )[`${t.category}/${t.direction}`] ?? (t.category === "clarity" ? "Articulation sounds different" : "Delivery differs here");
}

/** One-line description of what the category measures, for first-time readers. */
export const CATEGORY_MEANING: Record<Category, string> = {
  pacing: "how fast the words were spoken",
  pitch: "how much the voice rose and fell",
  pause: "the silences between words",
  energy: "how loud and forceful the voice was",
  clarity: "the sound quality of the words (articulation)",
};

/** Fixed coaching tips, one per category/direction (frontend copy, not analysis output). */
export function coachingTip(t: Pick<Track, "category" | "direction">): string {
  return (
    {
      "pacing/fast":
        "Slow down on this phrase. Give each word its full length, and let the important words land before moving on.",
      "pacing/slow":
        "Keep the phrase moving. Say it as one connected thought, without stretching individual words.",
      "pitch/flatter":
        "Let your voice move. Lift the key word of the phrase and let the end of the thought fall, as you would when telling someone something that matters.",
      "pitch/livelier":
        "Calm the melody. Keep the pitch movement for the one or two words that carry the meaning.",
      "pause/long":
        "Shorten this pause. Inside a sentence, a long silence breaks the thought. Save long pauses for the end of an idea.",
      "pause/short":
        "Take a breath here. A short pause at this boundary lets the listener absorb what you just said.",
      "energy/quiet":
        "Keep your support through the phrase. Breathe before it and carry the same volume to the last word.",
      "energy/loud":
        "Ease off. Emphasise with timing and pitch rather than volume, so the phrase does not sound forced.",
    } as Record<string, string>
  )[`${t.category}/${t.direction}`] ?? "Listen to the reference delivery and match its articulation: open the vowels and finish the consonants.";
}

/** What to listen for when comparing the two deliveries. */
export function listenFor(f: Pick<Track, "category" | "direction" | "words">): string {
  const last = f.words[f.words.length - 1]?.replace(/[.,;:!?]+$/, "") ?? "";
  const phrase = f.words.length > 4 ? `${f.words.slice(0, 4).join(" ")} …` : f.words.join(" ");
  return (
    {
      "pacing/fast": `how quickly “${phrase}” goes by`,
      "pacing/slow": `how drawn out “${phrase}” sounds`,
      "pitch/flatter": `how little the voice moves on “${phrase}”`,
      "pitch/livelier": `the large swings in pitch on “${phrase}”`,
      "pause/long": `the silence after “${last}”`,
      "pause/short": `the missing break after “${last}”`,
      "energy/quiet": `the voice losing strength on “${phrase}”`,
      "energy/loud": `the push in volume on “${phrase}”`,
    } as Record<string, string>
  )[`${f.category}/${f.direction}`] ?? `how “${phrase}” is articulated`;
}

export interface QuoteWord {
  word: Word;
  inSpan: boolean;
}

/** The finding's words with a few words of context on each side, kept within its sentences. */
export function contextQuote(take: Take, f: Track, pad = 6): { words: QuoteWord[]; clippedStart: boolean; clippedEnd: boolean } {
  const ws = take.words;
  const firstSentence = ws[f.start_idx]?.sentence;
  const lastSentence = ws[f.end_idx]?.sentence;
  let a = f.start_idx;
  while (a > 0 && f.start_idx - a < pad && ws[a - 1].sentence === firstSentence) a--;
  let b = f.end_idx;
  while (b < ws.length - 1 && b - f.end_idx < pad && ws[b + 1].sentence === lastSentence) b++;
  return {
    words: ws.slice(a, b + 1).map((word) => ({ word, inSpan: word.idx >= f.start_idx && word.idx <= f.end_idx })),
    clippedStart: a > 0 && ws[a - 1].sentence === firstSentence,
    clippedEnd: b < ws.length - 1 && ws[b + 1].sentence === lastSentence,
  };
}

const UNIT: Record<string, string> = { s: "s", "st (std)": "semitones", st: "semitones", "words/s": "words per second", dB: "dB" };
const unitWord = (u: string) => UNIT[u] ?? u;

/** Subject of the plain evidence sentence, by feature. */
function subject(m: Measurement): string {
  switch (m.feature) {
    case "pause_after_s":
      return `The pause after “${m.word}”`;
    case "log_local_articulation_rate":
      return `The speaking rate around “${m.word}”`;
    case "log_f0_span_std":
      return "The pitch movement across this phrase";
    case "f0_range_st":
      return `The pitch range on “${m.word}”`;
    case "f0_median_st":
      return `The pitch level on “${m.word}”`;
    case "log_duration":
      return `The length of “${m.word}”`;
    case "energy_rel_db":
    case "energy_peak_rel_db":
      return `The loudness of “${m.word}”`;
    default:
      return `${m.label.charAt(0).toUpperCase()}${m.label.slice(1)} on “${m.word}”`;
  }
}

const num = (v: number) => (Math.abs(v) >= 10 ? fmt(v, 1) : fmt(v, 2));

/** "The pause after “battlefield” lasted 1.10 s. In the reference deliveries it was 0.16 s." */
export function plainEvidence(m: Measurement): { lead: string; compare: string | null } {
  const u = unitWord(m.unit);
  if (m.observed === null || m.reference === null) return { lead: m.statement, compare: null };
  const bound = m.bound === "upper" ? "at most " : "";
  const lead = `${subject(m)} was ${bound}${num(m.observed)} ${u}. In the reference deliveries it was ${num(m.reference)} ${u}.`;
  let compare: string | null = null;
  if (m.change !== null && m.comparison === "ratio") {
    compare = m.change >= 1 ? `That is ${fmt(m.change, 1)}× the reference.` : `That is about ${Math.round(m.change * 100)}% of the reference.`;
  } else if (m.change !== null && m.comparison === "difference") {
    compare = `That is ${num(Math.abs(m.change))} ${u} ${m.change >= 0 ? "more" : "less"} than the reference.`;
  }
  return { lead, compare };
}

/** Time range of the finding's words in a reference take (pauses include the following word). */
export function referenceRange(take: Take, f: Flaw, refIdx = 0): [number, number] | null {
  const ref = take.references[refIdx];
  if (!ref) return null;
  const last = f.category === "pause" ? Math.min(f.end_idx + 1, ref.words.length - 1) : f.end_idx;
  const a = ref.words[f.start_idx]?.[0];
  const b = ref.words[last]?.[1];
  return a == null || b == null ? null : [Math.max(0, a - 0.25), b + 0.25];
}

/** The same range in this take. */
export function takeRange(take: Take, f: Flaw): [number, number] {
  const nextStart = f.category === "pause" ? take.words[f.end_idx + 1]?.end ?? f.end : f.end;
  return [Math.max(0, f.start - 0.25), Math.min(take.duration, nextStart + 0.25)];
}

/** Ground-truth edits overlapping this finding (demo takes only; null on controls). */
export function truthFor(take: Take, f: Track) {
  return take.ground_truth?.filter((g) => g.category === f.category && g.start_idx <= f.end_idx && g.end_idx >= f.start_idx) ?? null;
}
