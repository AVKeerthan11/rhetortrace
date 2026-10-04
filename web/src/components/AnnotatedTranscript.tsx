import { memo, useMemo } from "react";
import { CATEGORY } from "@/lib/categories";
import { plainTitle } from "@/lib/findings";
import { player } from "@/lib/player";
import { cursor, useWordFocus } from "@/lib/time";
import type { Take, Word } from "@/lib/types";
import { FindingNumber } from "@/components/FindingNumber";
import { cn } from "@/lib/utils";

/** The script as prose, with each finding's words underlined and numbered, and time-aware: the
 *  word being played is highlighted, pointing at a word points the stage at it (shared cursor),
 *  clicking a word plays from there and clicking a finding's word opens the finding. */
export function AnnotatedTranscript({ take, ranking, onOpen, onHover, className }: {
  take: Take; ranking: number[]; onOpen: (rank: number) => void; onHover?: (rank: number | null) => void; className?: string;
}) {
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

  const { playing, pointed } = useWordFocus(take);

  return (
    <p className={cn("font-display text-[20px] leading-[1.75] text-ink/85", className)}
      onPointerLeave={() => cursor.clear("text")}>
      {sentences.map((s, si) => (
        <span key={si}>
          {s.map((w) => {
            const r = owner.get(w.idx);
            const f = r !== undefined ? take.flaws[ranking[r]] : null;
            return (
              <TimedWord key={w.idx} w={w} rank={r ?? null} category={f?.category ?? null} first={!!f && f.start_idx === w.idx}
                title={f ? `Finding ${r! + 1}: ${plainTitle(f)}` : undefined}
                playing={w.idx === playing} pointed={w.idx === pointed}
                onOpen={onOpen} onHover={onHover} />
            );
          })}
        </span>
      ))}
    </p>
  );
}

const TimedWord = memo(function TimedWord({ w, rank, category, first, title, playing, pointed, onOpen, onHover }: {
  w: Word; rank: number | null; category: keyof typeof CATEGORY | null; first: boolean; title?: string;
  playing: boolean; pointed: boolean; onOpen: (rank: number) => void; onHover?: (rank: number | null) => void;
}) {
  const timed = w.start !== null && w.end !== null;
  const enter = () => {
    if (timed) cursor.set(w.start!, "text");
    if (rank !== null) onHover?.(rank);
  };
  const leave = () => {
    if (rank !== null) onHover?.(null);
  };
  const time = cn(
    "rounded-[3px] transition-[background-color,box-shadow] duration-150",
    playing && "bg-highlight text-[var(--on-highlight)]",
    pointed && !playing && "shadow-[0_0_0_1.5px_var(--pointer)]",
  );
  if (rank === null || category === null)
    return (
      <span>
        <span data-idx={w.idx} onPointerEnter={enter} onPointerLeave={leave} onClick={() => timed && player.seek(w.start!)}
          className={cn("cursor-pointer hover:bg-ink/[0.05]", time)}>
          {w.text}
        </span>{" "}
      </span>
    );
  return (
    <span>
      <button
        data-idx={w.idx}
        onClick={() => onOpen(rank)}
        onPointerEnter={enter}
        onPointerLeave={leave}
        title={title}
        className={cn("text-ink underline decoration-2 underline-offset-[6px] hover:bg-highlight-soft", time)}
        style={{ textDecorationColor: CATEGORY[category].color }}
      >
        {first && <FindingNumber n={rank + 1} category={category} className="mr-1 size-[18px] -translate-y-[3px] text-[10px]" />}
        {w.text}
      </button>{" "}
    </span>
  );
});
