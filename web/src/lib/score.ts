import type { Category, Flaw, Take } from "./types";

// The delivery score, taken apart in time and in severity. Both mirror the pipeline exactly
// (src/scoring.py, src/flaws.py) from exported values; nothing here is a new analysis.
//
// scoring.py:  per category c, penalty_c = Σ severity.score of its tracks (each finding and its
//              secondary tracks); score_c = 100 · max(0, 1 − penalty_c / flaws_to_zero);
//              total = Σ weight_c · score_c.
// So every track costs weight_c · 100 · severity / flaws_to_zero points until its category is
// used up. Walking the findings in time order gives where the points were lost.

export interface ScoreStep {
  /** flaw index */
  flaw: number;
  start: number;
  end: number;
  category: Category;
  /** points of the delivery score this finding (with its secondary tracks) costs */
  lost: number;
  /** delivery score after this finding */
  after: number;
}

/** The delivery score as it falls, finding by finding, in time order. */
export function scoreSteps(take: Take): ScoreStep[] {
  const { flaws_to_zero: ftz } = take.score.settings;
  const weight = (c: Category) => take.score.categories[c]?.weight ?? 0;
  const used: Partial<Record<Category, number>> = {};
  const order = take.flaws.map((_, i) => i).sort((a, b) => take.flaws[a].start - take.flaws[b].start);
  let score = 100;
  return order.map((i) => {
    const f = take.flaws[i];
    let lost = 0;
    for (const t of [f, ...f.secondary]) {
      const before = used[t.category] ?? 0;
      const now = before + t.severity.score;
      used[t.category] = now;
      lost += weight(t.category) * 100 * (Math.min(1, now / ftz) - Math.min(1, before / ftz));
    }
    score -= lost;
    return { flaw: i, start: f.start, end: f.end, category: f.category, lost, after: score };
  });
}

/** The severity scale of a finding, in z units (flaws.py severity()):
 *  score = clip((effective_z − z_min) / (z_max − z_min), 0, 1); level = thresholds reached. */
export function severityScale(take: Take, f: Pick<Flaw, "category" | "direction">) {
  const s = take.severity_settings;
  const zMax = s.z_max[`${f.category}/${f.direction}`] ?? s.z_max[f.category] ?? s.z_max.default ?? 8;
  const zAt = (score: number) => s.z_min + score * (zMax - s.z_min);
  return {
    zMin: s.z_min,
    zMax,
    zOpen: take.detection_settings.z_open,
    /** z where each level (1..4) starts */
    levels: s.level_thresholds.map((thr, k) => ({ level: k + 1, z: zAt(thr), label: s.labels[k + 1] ?? `level ${k + 1}` })),
  };
}
