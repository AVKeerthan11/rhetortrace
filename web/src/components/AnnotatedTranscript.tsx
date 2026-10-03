import { useMemo } from "react";
import { CATEGORY } from "@/lib/categories";
import { plainTitle } from "@/lib/findings";
import type { Take, Word } from "@/lib/types";
import { FindingNumber } from "@/components/FindingNumber";

/** The script as prose, with each finding's words underlined and numbered. Click opens the finding. */
export function AnnotatedTranscript({ take, ranking, onOpen }: { take: Take; ranking: number[]; onOpen: (rank: number) => void }) {
  // word idx -> rank of the most important finding covering it
  const owner = useMemo(() => {
    const m = new Map<number, number>();
    [...ranking].reverse().forEach((fi) => {
      const f = take.flaws[fi];
      for (let i = f.start_idx; i <= f.end_idx; i++) m.set(i, ranking.indexOf(fi));
    });
    return m;
  }, [take, ranking]);

  const sentences = useMemo(() => {
    const out: Word[][] = [];
    take.words.forEach((w) => {
      const last = out[out.length - 1];
      if (!last || last[0].sentence !== w.sentence) out.push([w]);
      else last.push(w);
    });
    return out;
  }, [take]);

  return (
    <p className="font-display text-[20px] leading-[1.75] text-ink/85">
      {sentences.map((s, si) => (
        <span key={si}>
          {s.map((w) => {
            const r = owner.get(w.idx);
            if (r === undefined) return <span key={w.idx}>{w.text} </span>;
            const f = take.flaws[ranking[r]];
            const first = f.start_idx === w.idx;
            const color = CATEGORY[f.category].color;
            return (
              <span key={w.idx}>
                <button
                  onClick={() => onOpen(r)}
                  title={`Finding ${r + 1}: ${plainTitle(f)}`}
                  className="rounded-[3px] text-ink underline decoration-2 underline-offset-[6px] transition-colors hover:bg-highlight-soft"
                  style={{ textDecorationColor: color }}
                >
                  {first && <FindingNumber n={r + 1} category={f.category} className="mr-1 size-[18px] -translate-y-[3px] text-[10px]" />}
                  {w.text}
                </button>{" "}
              </span>
            );
          })}
        </span>
      ))}
    </p>
  );
}
