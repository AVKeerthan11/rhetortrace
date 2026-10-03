import { useEffect, useMemo, useRef } from "react";
import type { Category, Take, Word } from "@/lib/types";
import { CATEGORY, CATEGORIES } from "@/lib/categories";
import { fmt, fmtSigned } from "@/lib/format";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { usePlayerTime, type Player } from "@/lib/player";

const KEY_FEATURES = ["log_duration", "f0_median_st", "energy_rel_db", "pause_after_s", "log_local_articulation_rate"];

function WordCard({ w }: { w: Word }) {
  const feats = w.features.filter((f) => KEY_FEATURES.includes(f.feature));
  const strongest = CATEGORIES.map((c) => [c, w.categories[c]] as const)
    .filter(([, s]) => s && s.score >= 1)
    .sort((a, b) => b[1]!.score - a[1]!.score)
    .slice(0, 3);
  return (
    <div className="w-[260px] space-y-2 py-1 text-left">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] font-semibold">{w.text}</span>
        <span className="font-mono text-[10.5px] opacity-60">
          {fmt(w.start)}–{fmt(w.end)}s · w{w.idx}
        </span>
      </div>
      <div className="space-y-0.5">
        {feats.map((f) => (
          <div key={f.feature} className="flex items-baseline gap-2 text-[11.5px]">
            <span className="flex-1 truncate opacity-70">{f.label}</span>
            {f.z !== undefined ? (
              <>
                <span className="font-mono tabular">{f.bound === "upper" ? "≤" : ""}{f.observed}</span>
                <span className="font-mono tabular opacity-50">ref {f.reference}</span>
                <span className="w-[44px] text-right font-mono tabular">{fmtSigned(f.z, 1)}σ</span>
              </>
            ) : (
              <span className="font-mono text-[10.5px] opacity-50">{(f.reason ?? f.status ?? "").replaceAll("_", " ")}</span>
            )}
          </div>
        ))}
      </div>
      {strongest.length > 0 && (
        <div className="flex gap-2 border-t border-current/10 pt-1.5 text-[11px]">
          {strongest.map(([c, s]) => (
            <span key={c} className="font-mono" style={{ color: CATEGORY[c as Category].color }}>
              {CATEGORY[c as Category].label} {fmt(s!.score, 1)}σ
            </span>
          ))}
        </div>
      )}
      {w.low_confidence && <div className="text-[11px] opacity-60">Low alignment confidence: excluded from evidence.</div>}
    </div>
  );
}

export function Transcript({ take, selected, player, onWord }: { take: Take; selected: number | null; player: Player; onWord: (w: Word) => void }) {
  const time = usePlayerTime(player);
  const container = useRef<HTMLDivElement>(null);
  const sel = selected !== null ? take.flaws[selected] : null;

  // dominant finding category per word (for the accent underline)
  const marks = useMemo(() => {
    const m = new Map<number, Category>();
    [...take.flaws].sort((a, b) => a.severity.score - b.severity.score).forEach((f) => {
      for (let i = f.start_idx; i <= f.end_idx; i++) m.set(i, f.category);
    });
    return m;
  }, [take]);

  useEffect(() => {
    if (!sel || !container.current) return;
    const el = container.current.querySelector(`[data-idx="${sel.start_idx}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [sel]);

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
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-5 pt-4 pb-2">
        <div className="text-[13px] font-semibold">Transcript</div>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5"><span className="h-[2px] w-3 rounded-full bg-ink/60" />finding</span>
          <span className="flex items-center gap-1.5"><span className="w-3 border-b border-dotted border-ink/40" />low confidence</span>
          <span className="text-faint">hover for measurements · click to jump</span>
        </div>
      </div>
      <div ref={container} className="flex-1 overflow-y-auto px-5 pb-5 scrollbar-thin">
        <p className="text-[15px] leading-[2.05]">
          {sentences.map((s, si) => (
            <span key={si}>
              {s.map((w) => {
                const cat = marks.get(w.idx);
                const inSel = !!sel && w.idx >= sel.start_idx && w.idx <= sel.end_idx;
                const playing = w.start !== null && w.end !== null && time >= w.start && time < w.end;
                return (
                  <Tooltip key={w.idx}>
                    <TooltipTrigger
                      render={<span />}
                      data-idx={w.idx}
                      onClick={() => onWord(w)}
                      className={cn(
                        "cursor-pointer rounded-[4px] px-[3px] py-[1px] transition-colors hover:bg-ink/[0.08]",
                        cat ? "text-foreground" : "text-foreground/70",
                        inSel && "bg-highlight-soft",
                        playing && "bg-highlight text-ink hover:bg-highlight",
                        w.low_confidence && "underline decoration-ink/35 decoration-dotted underline-offset-[5px]",
                      )}
                      style={cat && !w.low_confidence ? {
                        textDecorationLine: "underline", textDecorationThickness: inSel ? 2 : 1.5,
                        textDecorationColor: CATEGORY[cat].color, textUnderlineOffset: 5,
                      } : undefined}
                    >
                      {w.text}
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-none">
                      <WordCard w={w} />
                    </TooltipContent>
                    {" "}
                  </Tooltip>
                );
              })}
            </span>
          ))}
        </p>
      </div>
    </div>
  );
}
