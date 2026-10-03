import { Link } from "react-router-dom";
import { ArrowRight, CircleCheck, CircleX } from "lucide-react";
import { CATEGORY } from "@/lib/categories";
import { plainTitle, rankFindings, truthFor } from "@/lib/findings";
import { fmt } from "@/lib/format";
import { kindLabel } from "@/lib/validation";
import { findingPath } from "@/lib/takes";
import type { GroundTruth, Take } from "@/lib/types";
import { FindingNumber } from "@/components/FindingNumber";

/** Demo recordings only: each injected edit, whether it was found and by which finding,
 *  then the findings that match no edit (false alarms on this recording). */
export function AnswerKey({ take }: { take: Take }) {
  if (!take.ground_truth) return null;
  const ranking = rankFindings(take);
  const matches = (g: GroundTruth) =>
    ranking
      .map((fi, r) => ({ f: take.flaws[fi], rank: r + 1 }))
      .filter(({ f }) => f.category === g.category && f.start_idx <= g.end_idx && f.end_idx >= g.start_idx);
  const unmatched = ranking.map((fi, r) => ({ f: take.flaws[fi], rank: r + 1 })).filter(({ f }) => !truthFor(take, f)?.length);
  const found = take.ground_truth.filter((g) => g.detected).length;
  // unmatched findings that touch an edit (within two words): likely a side effect of that edit
  const nextToEdit = unmatched.filter(({ f }) =>
    take.ground_truth!.some((g) => f.start_idx <= g.end_idx + 2 && f.end_idx >= g.start_idx - 2));

  return (
    <div>
      <div className="overflow-hidden rounded-xl border border-hairline bg-surface">
        {take.ground_truth.map((g, i) => {
          const m = matches(g);
          const words = take.words.slice(g.start_idx, g.end_idx + 1).map((w) => w.text);
          const quote = g.category === "pause" ? `after “${words[words.length - 1]}”` : `“${words.slice(0, 7).join(" ")}${words.length > 7 ? " …" : ""}”`;
          const row = (
            <>
              {g.detected ? <CircleCheck className="size-4 shrink-0 text-truth" /> : <CircleX className="size-4 shrink-0 text-warn" />}
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-[14px] font-medium">
                  <span className="size-2 rounded-full" style={{ background: CATEGORY[g.category].color }} />
                  {kindLabel(g.kind)}
                  <span className="font-normal text-muted-foreground">{quote}</span>
                </span>
                <span className="mt-0.5 block text-[12.5px] text-muted-foreground">
                  injected at {fmt(g.start, 1)}–{fmt(g.end, 1)} s ·{" "}
                  {g.detected ? `found; the finding covers ${Math.round((g.iou ?? 0) * 100)}% of the same time (overlap)` : "not found"}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1">
                {m.map(({ f, rank }) => <FindingNumber key={rank} n={rank} category={f.category} />)}
              </span>
              {m.length > 0 && <ArrowRight className="size-4 shrink-0 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-ink" />}
            </>
          );
          const cls = "group flex items-center gap-3 border-t border-hairline px-4 py-3 first:border-t-0";
          return m.length ? (
            <Link key={i} to={findingPath(take.id, m[0].rank)} className={`${cls} transition-colors hover:bg-hover`}
              aria-label={`${kindLabel(g.kind)}: open finding ${m[0].rank}`}>
              {row}
            </Link>
          ) : (
            <div key={i} className={cls}>{row}</div>
          );
        })}
      </div>
      <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">
        {found} of {take.ground_truth.length} injected edits found.{" "}
        {unmatched.length === 0 ? (
          "Every finding matches an injected edit."
        ) : (
          <>
            {unmatched.length === 1 ? "One finding matches" : `${unmatched.length} findings match`} no injected edit, so on this recording{" "}
            {unmatched.length === 1 ? "it counts" : "they count"} as false alarms:{" "}
            {unmatched.map(({ f, rank }, k) => (
              <span key={rank}>
                <Link to={findingPath(take.id, rank)} className="text-ink underline decoration-ink/25 underline-offset-[3px] hover:decoration-ink">
                  finding {rank} ({plainTitle(f).toLowerCase()})
                </Link>
                {k < unmatched.length - 1 ? ", " : "."}
              </span>
            ))}
            {nextToEdit.length > 0 && (
              <>
                {" "}Finding{nextToEdit.length > 1 ? "s" : ""} {nextToEdit.map(({ rank }) => rank).join(" and ")}{" "}
                {nextToEdit.length > 1 ? "sit" : "sits"} right next to an injected edit, so {nextToEdit.length > 1 ? "they are" : "it is"} likely a side effect of the edit.
              </>
            )}
          </>
        )}
      </p>
    </div>
  );
}
