import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { refTimeAt, takeTimeAt } from "./align";
import type { Take } from "./types";

const take = JSON.parse(readFileSync(path.resolve(__dirname, "../../public/data/speech_01__synth_01.json"), "utf-8")) as Take;

describe("same point of the script in a reference delivery", () => {
  it("maps each word's start onto the reference's start of the same word", () => {
    take.references.forEach((r, k) => {
      take.words.forEach((w, i) => {
        const rs = r.words[i]?.[0];
        if (w.start === null || rs == null) return;
        expect(refTimeAt(take, k, w.start)).toBeCloseTo(rs, 2);
      });
    });
  });

  it("maps a pause onto the reference's pause between the same two words", () => {
    // finding 1 of this demo: an injected long pause after "battlefield"
    const i = take.words.findIndex((w) => w.text.startsWith("battlefield"));
    const mid = (take.words[i].end! + take.words[i + 1].start!) / 2;
    const r = take.references[0].words;
    const rt = refTimeAt(take, 0, mid)!;
    expect(rt).toBeGreaterThan(r[i][1]! - 1e-6);
    expect(rt).toBeLessThan(r[i + 1][0]! + 1e-6);
  });

  it("round-trips: reference time back to this recording", () => {
    for (const t of [1.234, 10, 23.9, 40.5]) expect(takeTimeAt(take, 1, refTimeAt(take, 1, t)!)).toBeCloseTo(t, 3);
  });
});
