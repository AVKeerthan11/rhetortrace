import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { ArrowLeft, ArrowRight, ChevronDown, Crosshair, Rows3, ScanLine } from "lucide-react";
import { CATEGORY } from "@/lib/categories";
import { useIndex } from "@/lib/data";
import { plainTitle } from "@/lib/findings";
import { spring } from "@/lib/motion";
import { examplesPath, explorePath, findingPath, groupBySpeech, overviewPath, recordingTitle, recordingsPath, speechName, takeName } from "@/lib/takes";
import type { Take } from "@/lib/types";
import { cn } from "@/lib/utils";
import { TakeMarks } from "@/components/TakeMarks";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useStage, type Level } from "./store";

// Above the stage: where this recording lives (back link), what it is, and the three zoom
// levels as one control. The active level's pill slides between them, the same motion as the
// camera underneath.

export function StageHeader({ take, level, rank, ranking }: { take: Take; level: Level; rank: number | null; ranking: number[] }) {
  const lastRank = useStage((s) => s.lastRank);
  const user = take.kind === "user";
  const total = ranking.length;
  const tabs: { level: Level; to: string; label: string; short: string; icon: typeof Rows3; disabled?: boolean }[] = [
    { level: "overview", to: overviewPath(take.id), label: "Overview", short: "Overview", icon: Rows3 },
    {
      level: "finding", to: findingPath(take.id, rank ?? Math.min(lastRank, Math.max(1, total))),
      label: level === "finding" && rank ? `Finding ${rank} of ${total}` : "Findings", short: level === "finding" && rank ? `${rank}/${total}` : "Findings",
      icon: Crosshair, disabled: total === 0,
    },
    { level: "explore", to: explorePath(take.id), label: "Timeline explorer", short: "Explorer", icon: ScanLine },
  ];

  return (
    <div className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 py-2.5">
      <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto sm:flex-1">
        <Link to={user ? recordingsPath : examplesPath} aria-label={user ? "Your recordings" : "Lab examples"}
          className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-hover hover:text-ink">
          <ArrowLeft className="size-4" />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[10.5px] font-medium tracking-[0.14em] text-faint uppercase">
            {user ? "Your recording" : take.kind === "demo" ? "Lab · controlled example" : "Lab · clean reference delivery"}
          </div>
          {user ? (
            <h1 className="truncate text-[15px] font-medium">{recordingTitle(take)}</h1>
          ) : (
            <SwitchRecording take={take} />
          )}
        </div>
      </div>

      <nav aria-label="Zoom level" className="flex shrink-0 items-center rounded-full border border-hairline bg-surface p-0.5 text-[13px]">
        {tabs.map((t) => {
          const active = t.level === level;
          return (
            <Link key={t.level} to={t.to} aria-current={active ? "page" : undefined} aria-disabled={t.disabled}
              className={cn("relative flex items-center gap-1.5 rounded-full px-3 py-1.5 transition-colors",
                active ? "text-ink" : "text-muted-foreground hover:text-ink", t.disabled && "pointer-events-none opacity-40")}>
              {active && <motion.span layoutId="stage-level" transition={spring.snappy} className="absolute inset-0 rounded-full bg-selected" />}
              <t.icon className="relative size-3.5" />
              <span className="relative hidden whitespace-nowrap sm:inline">{t.label}</span>
              <span className="relative whitespace-nowrap sm:hidden">{t.short}</span>
            </Link>
          );
        })}
      </nav>

      {level === "finding" && rank && <FindingStepper take={take} rank={rank} ranking={ranking} />}
    </div>
  );
}

/** Dots for every finding (the open one wide, in its colour) and previous / next. */
function FindingStepper({ take, rank, ranking }: { take: Take; rank: number; ranking: number[] }) {
  const navigate = useNavigate();
  const total = ranking.length;
  const go = (r: number) => r >= 1 && r <= total && navigate(findingPath(take.id, r));
  return (
    <div className="ml-auto flex shrink-0 items-center gap-2 sm:ml-0">
      <span className="hidden items-center gap-1 md:flex" aria-label={`Finding ${rank} of ${total}`}>
        {ranking.map((fi, r) => (
          <Tooltip key={fi}>
            <TooltipTrigger onClick={() => go(r + 1)} aria-label={`Finding ${r + 1}`} className="grid h-5 w-3 place-items-center">
              <motion.span className="block rounded-full"
                animate={{ width: r + 1 === rank ? 14 : 6, height: 6, opacity: r + 1 === rank ? 1 : 0.35 }}
                transition={spring.snappy}
                style={{ background: r + 1 === rank ? CATEGORY[take.flaws[fi].category].color : "var(--ink)" }} />
            </TooltipTrigger>
            <TooltipContent>{r + 1}. {plainTitle(take.flaws[fi])}</TooltipContent>
          </Tooltip>
        ))}
      </span>
      <StepButton onClick={() => go(rank - 1)} disabled={rank === 1} label="Previous finding" kbd="K"><ArrowLeft className="size-4" /></StepButton>
      <StepButton onClick={() => go(rank + 1)} disabled={rank === total} label="Next finding" kbd="J"><ArrowRight className="size-4" /></StepButton>
    </div>
  );
}

function StepButton({ onClick, disabled, label, kbd, children }: { onClick: () => void; disabled: boolean; label: string; kbd: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger onClick={onClick} disabled={disabled} aria-label={label}
        className="grid size-8 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-hover hover:text-ink disabled:pointer-events-none disabled:opacity-30">
        {children}
      </TooltipTrigger>
      <TooltipContent>{label} <span className="font-mono text-faint">{kbd}</span></TooltipContent>
    </Tooltip>
  );
}

/** "Speech 01 · Demo recording ▾": switch to another dataset recording. */
function SwitchRecording({ take }: { take: Take }) {
  const [open, setOpen] = useState(false);
  const { data: index } = useIndex();
  const navigate = useNavigate();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger aria-label="Switch recording"
        className="-ml-1 flex max-w-full items-center gap-1 rounded-md px-1 text-[15px] font-medium transition-colors hover:bg-hover aria-expanded:bg-selected">
        <span className="truncate">{recordingTitle(take)}</span>
        <ChevronDown className="size-3.5 shrink-0 text-faint" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(92vw,340px)] overflow-hidden p-0">
        <Command>
          <CommandInput placeholder="Switch recording…" autoFocus />
          <CommandList>
            <CommandEmpty>No recording matches.</CommandEmpty>
            {index && groupBySpeech(index.takes).map((g) => (
              <CommandGroup key={g.speech} heading={`${speechName(g.speech)} · “${g.opening}”`}>
                {g.takes.map((x) => (
                  <CommandItem key={x.id} value={`${speechName(x.speech_id)} ${takeName(x)} ${x.take_id}`}
                    onSelect={() => { setOpen(false); navigate(overviewPath(x.id)); }}
                    className="flex-col items-stretch gap-1.5">
                    <span className="flex items-baseline gap-2">
                      <span className={cn(x.id === take.id && "font-medium")}>{takeName(x)}</span>
                      <span className="ml-auto text-[12px] text-muted-foreground">{x.n_flaws} finding{x.n_flaws === 1 ? "" : "s"}</span>
                    </span>
                    <TakeMarks take={x} className="h-[6px]" />
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
