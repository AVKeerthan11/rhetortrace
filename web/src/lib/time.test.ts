import { describe, expect, it } from "vitest";
import { evidenceSpan, timingRows } from "./evidence";
import { cursor, findingAt, stepWord, wordAt, wordNear, wordTimes } from "./time";
import type { Flaw, Take } from "./types";

// words: "a" 0.0–0.4, "b" 0.5–0.9, (untimed "c"), "d" 1.6–2.0 · a pause after "b"
const word = (idx: number, text: string, start: number | null, end: number | null) =>
  ({ idx, text, start, end, sentence: 0, low_confidence: false, alignment_score: 1, categories: {}, features: [] }) as unknown as Take["words"][number];

const flaw = (start_idx: number, end_idx: number, start: number, end: number, score: number, category = "pause") =>
  ({ start_idx, end_idx, start, end, category, severity: { score } }) as unknown as Flaw;

const take = {
  duration: 2.5,
  words: [word(0, "a", 0, 0.4), word(1, "b", 0.5, 0.9), word(2, "c", null, null), word(3, "d", 1.6, 2.0)],
  flaws: [flaw(1, 1, 0.5, 0.9, 2), flaw(0, 1, 0.0, 0.9, 5, "pacing")],
  references: [{ take_id: "good_02", audio: "", words: [[1.0, 1.3], [1.4, 1.7], [1.8, 2.0], [2.05, 2.3]] }],
} as unknown as Take;

describe("word timing index", () => {
  it("skips untimed words and links each word to the next timed start", () => {
    const wt = wordTimes(take);
    expect(wt.order).toEqual([0, 1, 3]);
    expect(wt.nextStart).toEqual([0.5, 1.6, 1.6, null]);
    expect(wordTimes(take)).toBe(wt); // cached per take
  });

  it("wordAt is the spoken word, -1 in silence; wordNear keeps the word before a pause", () => {
    expect(wordAt(take, 0.2)).toBe(0);
    expect(wordAt(take, 1.2)).toBe(-1);
    expect(wordNear(take, 1.2)).toBe(1);
    expect(wordNear(take, 1.7)).toBe(3);
    expect(wordAt(take, null)).toBe(-1);
  });

  it("stepWord moves to the next start, and back to this word's start or the previous one", () => {
    expect(stepWord(take, 0.2, 1)).toBe(0.5);
    expect(stepWord(take, 0.5, 1)).toBe(1.6);
    expect(stepWord(take, 1.9, -1)).toBe(1.6); // well into "d": back to its start
    expect(stepWord(take, 1.6, -1)).toBe(0.5); // at its start: the word before
  });

  it("findingAt prefers the most severe finding covering t", () => {
    expect(findingAt(take, 0.6)).toBe(1);
    expect(findingAt(take, 0.2)).toBe(1);
    expect(findingAt(take, 2.2)).toBe(-1);
  });
});

describe("shared cursor", () => {
  it("only the surface that set the cursor clears it by source", () => {
    cursor.set(1, "text");
    cursor.clear("stage");
    expect(cursor.t).toBe(1);
    cursor.clear("text");
    expect(cursor.t).toBeNull();
  });
});

describe("evidence on the time axis", () => {
  it("a pause measurement is the gap to the next timed word; others are the word", () => {
    expect(evidenceSpan(take, { idx: 1, feature: "pause_after_s" })).toEqual({ start: 0.9, end: 1.6, kind: "gap" });
    expect(evidenceSpan(take, { idx: 0, feature: "log_duration" })).toEqual({ start: 0, end: 0.4, kind: "word" });
    expect(evidenceSpan(take, { idx: 2, feature: "log_duration" })).toBeNull();
  });

  it("reference rows are anchored on the finding's first word in this recording", () => {
    const [own, ref] = timingRows(take, take.flaws[0], 1);
    expect(own.words[1]).toEqual({ i: 1, start: 0.5, end: 0.9 });
    // good_02's "b" starts at 1.4: shifted by -0.9 to start at 0.5 like this recording's
    expect(ref.words[1]!.start).toBeCloseTo(0.5);
    expect(ref.words[1]!.end).toBeCloseTo(0.8);
    // the pause after "b" is measured to the next word ("c"), untimed in this recording
    expect(own.spanDur).toBeNull();
    expect(ref.spanDur).toBeCloseTo(0.1);
  });
});
