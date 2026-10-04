import { memo, useEffect, useMemo, useRef } from "react";
import type { Category, Take, Word } from "@/lib/types";
import { CATEGORY, CATEGORIES } from "@/lib/categories";
import { fmt, fmtSigned } from "@/lib/format";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Player } from "@/lib/player";
import { AudioWaveform } from "lucide-react";
import { REF, deviationAmount, wash } from "@/lib/grammar";
import { useUi } from "@/lib/store";
import { cursor, useWordFocus, wordTimes } from "@/lib/time";

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
  const { playing, pointed } = useWordFocus(take);
  const rhythm = useUi((s) => s.rhythm);
  const setRhythm = useUi((s) => s.setRhythm);
  const gaps = useMemo(() => rhythmGaps(take), [take]);
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

  // karaoke: while playing, keep the spoken word in view
  useEffect(() => {
    if (playing < 0 || !player.playing || !container.current) return;
    const el = container.current.querySelector(`[data-idx="${playing}"]`);
    el?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [playing, player]);

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
      <div className="page flex flex-wrap items-center justify-between gap-2 pt-4 pb-2">
        <div className="flex items-center gap-3">
          <div className="text-[13px] font-semibold">Transcript</div>
          <button onClick={() => setRhythm(!rhythm)} aria-pressed={rhythm}
            title="Space the words by their real pauses, against the reference deliveries' pauses"
            className={cn("inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12px] transition-colors",
              rhythm ? "border-ink bg-ink text-primary-foreground" : "border-hairline text-muted-foreground hover:border-ink/25 hover:text-ink")}>
            <AudioWaveform className="size-3.5" /> Rhythm
          </button>
        </div>
        <div className="hidden items-center gap-3 text-[11px] text-muted-foreground sm:flex">
          {rhythm ? (
            <>
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-[2px] bg-ink/[0.07]" />pause</span>
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-px bg-ink/60" />reference pause</span>
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-[2px]" style={{ background: wash("pause", 0.45) }} />longer than theirs</span>
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-[2px] border" style={{ borderColor: REF.line }} />missing</span>
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-[2px]" style={{ background: wash("pacing", 0.3) }} />word off-pace</span>
            </>
          ) : (
            <>
              <span className="flex items-center gap-1.5"><span className="h-[2px] w-3 rounded-full bg-ink/60" />finding</span>
              <span className="flex items-center gap-1.5"><span className="w-3 border-b border-dotted border-ink/40" />low confidence</span>
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-3 rounded-[2px] bg-highlight" />playing</span>
              <span className="text-faint">hover to point the stage · click to jump</span>
            </>
          )}
        </div>
      </div>
      <div ref={container} className="flex-1 overflow-y-auto pb-24 scrollbar-thin lg:pb-5" onPointerLeave={() => cursor.clear("text")}>
        <div className="page"><p className="max-w-[100ch] text-[15px] leading-[2.05]">
          {sentences.map((s, si) => (
            <span key={si}>
              {s.map((w) => (
                <TranscriptWord key={w.idx} w={w} cat={marks.get(w.idx) ?? null}
                  inSel={!!sel && w.idx >= sel.start_idx && w.idx <= sel.end_idx}
                  playing={w.idx === playing} pointed={w.idx === pointed} onWord={onWord} rhythm={rhythm ? gaps[w.idx] : null} />
              ))}
            </span>
          ))}
        </p></div>
      </div>
    </div>
  );
}

interface Rhythm {
  /** silence after the word, s (null when the next word is untimed) */
  obs: number | null;
  /** the reference deliveries' pause after the same word, s */
  ref: number | null;
  /** how far the pause deviates, 0..1 */
  pauseAmt: number;
  /** how far the word's pace deviates, 0..1 */
  paceAmt: number;
}

/** Per word, the pause after it against the references' pause (the word's pause_after_s
 *  measurement), and how far its pause and pace deviate. Exported values only. */
function rhythmGaps(take: Take): Rhythm[] {
  const { nextStart } = wordTimes(take);
  const { z_open } = take.detection_settings;
  return take.words.map((w, i) => {
    const m = w.features.find((f) => f.feature === "pause_after_s");
    const gap = w.end !== null && nextStart[i] !== null ? Math.max(0, nextStart[i]! - w.end) : null;
    return {
      obs: m?.observed ?? gap,
      ref: m?.reference ?? null,
      pauseAmt: w.categories.pause ? deviationAmount(w.categories.pause.score, z_open) : 0,
      paceAmt: w.categories.pacing ? deviationAmount(w.categories.pacing.score, z_open) : 0,
    };
  });
}

const PX_PER_S = 40;

/** The silence after a word drawn to scale: its length (track), the references' pause (tick),
 *  and the difference as an area: filled when longer than theirs, outlined when missing. */
function RhythmGap({ r }: { r: Rhythm }) {
  const obs = r.obs ?? 0, ref = r.ref;
  // only pauses a listener can hear: shorter gaps read as a plain space
  if (Math.max(obs, ref ?? 0) < 0.15) return <> </>;
  const px = (s: number) => Math.min(2.5, s) * PX_PER_S;
  const wObs = Math.max(3, px(obs)), wRef = ref !== null ? px(ref) : null;
  const width = Math.max(wObs, wRef ?? 0) + 6;
  return (
    <span aria-hidden className="relative inline-block h-[0.95em] align-[-0.12em]" style={{ width }}>
      <span className="absolute inset-y-0 left-[3px] rounded-[2px] bg-ink/[0.07]" style={{ width: wObs }} />
      {wRef !== null && wObs > wRef + 1 && (
        <span className="absolute inset-y-0 rounded-r-[2px]" style={{ left: 3 + wRef, width: wObs - wRef, background: wash("pause", 0.18 + 0.5 * r.pauseAmt) }} />
      )}
      {wRef !== null && wRef > wObs + 1 && (
        <span className="absolute inset-y-0 rounded-r-[2px] border border-l-0" style={{ left: 3 + wObs, width: wRef - wObs, borderColor: REF.line }} />
      )}
      {wRef !== null && <span className="absolute -inset-y-[2px] w-px bg-ink/60" style={{ left: 3 + wRef }} />}
    </span>
  );
}

const TranscriptWord = memo(function TranscriptWord({ w, cat, inSel, playing, pointed, onWord, rhythm }: {
  w: Word; cat: Category | null; inSel: boolean; playing: boolean; pointed: boolean; onWord: (w: Word) => void; rhythm: Rhythm | null;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span />}
        data-idx={w.idx}
        onClick={() => onWord(w)}
        onPointerEnter={() => w.start !== null && cursor.set(w.start, "text")}
        className={cn(
          "cursor-pointer rounded-[4px] px-[3px] py-[1px] transition-[background-color,box-shadow] hover:bg-ink/[0.08]",
          cat ? "text-foreground" : "text-foreground/70",
          inSel && "bg-highlight-soft",
          playing && "bg-highlight text-[var(--on-highlight)] hover:bg-highlight",
          pointed && !playing && "shadow-[inset_0_0_0_1px_var(--pointer)]",
          w.low_confidence && "underline decoration-ink/35 decoration-dotted underline-offset-[5px]",
        )}
        style={{
          ...(cat && !w.low_confidence ? {
            textDecorationLine: "underline", textDecorationThickness: inSel ? 2 : 1.5,
            textDecorationColor: CATEGORY[cat].color, textUnderlineOffset: 5,
          } : {}),
          ...(rhythm && rhythm.paceAmt > 0 && !playing && !inSel ? { background: wash("pacing", 0.12 + 0.3 * rhythm.paceAmt) } : {}),
        }}
      >
        {w.text}
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-none">
        <WordCard w={w} />
      </TooltipContent>
      {rhythm ? <RhythmGap r={rhythm} /> : " "}
    </Tooltip>
  );
});
