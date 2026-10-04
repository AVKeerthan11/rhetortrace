import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scoreSteps, severityScale } from "./score";
import type { Take } from "./types";

// Against the real exported takes: the per-finding losses must add up to the pipeline's score,
// and the severity scale must reproduce every finding's exported severity score.
const DATA = path.resolve(__dirname, "../../public/data");
const takes = readdirSync(DATA).filter((f) => f.includes("__")).map((f) => JSON.parse(readFileSync(path.join(DATA, f), "utf-8")) as Take);

describe("score through time", () => {
  it.each(takes.map((t) => [t.id, t] as const))("%s: losses add up to the delivery score", (_, take) => {
    const steps = scoreSteps(take);
    const final = steps.length ? steps[steps.length - 1].after : 100;
    expect(final).toBeCloseTo(take.score.total, 1);
    expect(steps.every((s) => s.lost >= 0)).toBe(true);
    // in time order
    expect(steps.map((s) => s.start)).toEqual([...steps.map((s) => s.start)].sort((a, b) => a - b));
  });
});

describe("severity scale", () => {
  it("reproduces each finding's severity score from its effective z", () => {
    for (const take of takes)
      for (const f of take.flaws) {
        const sc = severityScale(take, f);
        const score = Math.min(1, Math.max(0, (Math.abs(f.severity.effective_z) - sc.zMin) / (sc.zMax - sc.zMin)));
        expect(score).toBeCloseTo(f.severity.score, 2);
        expect(sc.levels.filter((l) => Math.abs(f.severity.effective_z) >= l.z - 1e-3).length).toBe(f.severity.level);
      }
  });
});
