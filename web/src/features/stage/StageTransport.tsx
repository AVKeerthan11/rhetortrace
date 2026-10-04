import { useMemo, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Ear, Maximize2, MousePointer2, Pause, Play, Repeat, SlidersHorizontal, Square, ZoomIn, ZoomOut } from "lucide-react";
import { CATEGORY } from "@/lib/categories";
import { plainTitle } from "@/lib/findings";
import { fmtClock } from "@/lib/format";
import { duration, ease, spring } from "@/lib/motion";
import { usePlayerState, type Player } from "@/lib/player";
import { findingAt, useTimeEffect, useTimeSelect, wordNear } from "@/lib/time";
import { useUi, type Layers } from "@/lib/store";
import { referenceName } from "@/lib/takes";
import type { Take } from "@/lib/types";
import { cn } from "@/lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { releaseHold, startHold } from "./hold";
import { useStage, type Level } from "./store";

// The stage's controls: play / pause and what is audible (this recording or a reference
// delivery), speed, the reference delivery comparisons use, and, in the explorer, stepping
// through findings, lanes and zoom. One bar for every zoom level, so playback never moves.

const RATES = [0.75, 1, 1.25];

function IconButton({ label, kbd, onClick, children }: { label: string; kbd?: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger onClick={onClick} aria-label={label}
        className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground">
        {children}
      </TooltipTrigger>
      <TooltipContent>{label} {kbd && <Kbd>{kbd}</Kbd>}</TooltipContent>
    </Tooltip>
  );
}

const LAYERS: { key: keyof Layers; label: string; hint: string; color?: string }[] = [
  { key: "pitch", label: "Pitch contour", hint: "voice melody, semitones", color: "var(--cat-pitch)" },
  { key: "energy", label: "Energy contour", hint: "loudness, dB", color: "var(--cat-energy)" },
  { key: "reference", label: "Reference range", hint: "shaded band behind the contours" },
  { key: "threads", label: "Rhythm threads", hint: "each reference delivery's words joined to these" },
  { key: "deviation", label: "Deviation heat", hint: "per-word distance from the references" },
  { key: "truth", label: "Injected edits", hint: "demo recordings only", color: "var(--truth)" },
];

function ViewMenu({ take }: { take: Take }) {
  const layers = useUi((s) => s.layers);
  const toggle = useUi((s) => s.toggleLayer);
  return (
    <Popover>
      <PopoverTrigger className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline bg-surface px-2.5 text-[12.5px] transition-colors hover:border-ink/20 aria-expanded:bg-selected">
        <SlidersHorizontal className="size-3.5" /> <span className="hidden sm:inline">Lanes</span>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-64 p-1.5">
        <div className="px-2 pt-1 pb-1.5 text-[10.5px] font-medium tracking-[0.12em] text-faint uppercase">Timeline lanes</div>
        {LAYERS.filter((l) => l.key !== "truth" || take.ground_truth).map((l) => (
          <button key={l.key} onClick={() => toggle(l.key)}
            className="flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-hover">
            <span className={cn("mt-0.5 grid size-4 shrink-0 place-items-center rounded-[4px] border", layers[l.key] ? "border-ink bg-ink text-primary-foreground" : "border-ink/25")}>
              {layers[l.key] && <Check className="size-3" strokeWidth={3} />}
            </span>
            <span>
              <span className="flex items-center gap-1.5 text-[13px]">
                {l.color && <span className="size-2 rounded-full" style={{ background: l.color }} />}
                {l.label}
              </span>
              <span className="block text-[11.5px] text-muted-foreground">{l.hint}</span>
            </span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/** Three bars bouncing while something plays, so "playing" reads at a glance. */
function Bars({ on }: { on: boolean }) {
  return (
    <span className="flex h-3 items-end gap-[2px]" aria-hidden>
      {[0, 0.2, 0.1].map((delay, i) => (
        <motion.span key={i} className="w-[3px] rounded-full bg-ink/70"
          animate={on ? { height: ["30%", "100%", "45%", "80%", "30%"] } : { height: "30%" }}
          transition={on ? { duration: 0.9, repeat: Infinity, delay, ease: "easeInOut" } : { duration: 0.2 }} />
      ))}
    </span>
  );
}

/** The playhead time, written straight into the DOM every frame (no React render). */
function Clock({ take }: { take: Take }) {
  const el = useRef<HTMLSpanElement>(null);
  useTimeEffect("playhead", (t) => {
    if (el.current) el.current.textContent = fmtClock(t ?? 0);
  }, []);
  return (
    <span className="font-mono text-[12.5px] tabular">
      <span ref={el} className="text-ink">{fmtClock(0)}</span>
      <span className="hidden text-faint sm:inline"> / {fmtClock(take.duration)}</span>
    </span>
  );
}

/** What the focus time is on: the pointed-at word while pointing anywhere (stage, transcript),
 *  otherwise the word under the playhead, and its sentence. Re-renders when the word changes. */
function Readout({ take }: { take: Take }) {
  const wi = useTimeSelect("focus", (t) => wordNear(take, t));
  const pointing = useTimeSelect("cursor", (t) => t !== null);
  const fi = useTimeSelect("focus", (t) => findingAt(take, t));
  const sentences = useMemo(() => new Set(take.words.map((w) => w.sentence)).size, [take]);
  const w = take.words[wi];
  if (!w) return null;
  const f = fi >= 0 ? take.flaws[fi] : null;
  return (
    <span className={cn("hidden min-w-0 items-center gap-2 text-[12.5px] transition-colors md:flex", pointing ? "text-ink" : "text-muted-foreground")}
      aria-live="off" data-testid="stage-readout">
      {pointing ? <MousePointer2 className="size-3 shrink-0 text-faint" /> : <span className="size-1.5 shrink-0 rounded-full bg-ink/70" />}
      <span className="max-w-[18ch] truncate font-medium">“{w.text}”</span>
      {w.sentence !== null && <span className="shrink-0 font-mono text-[11px] text-faint">sentence {w.sentence + 1}/{sentences}</span>}
      {f && (
        <span className="flex min-w-0 items-center gap-1.5 text-[12px]">
          <span className="size-1.5 shrink-0 rounded-full" style={{ background: CATEGORY[f.category].color }} />
          <span className="truncate">{plainTitle(f)}</span>
        </span>
      )}
    </span>
  );
}

/** Press and hold: hear the chosen reference delivery from the same point of the script. */
function HoldButton({ take, player }: { take: Take; player: Player }) {
  const { ghost } = usePlayerState(player);
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label="Hold to hear the reference delivery at this point"
        aria-pressed={!!ghost}
        onPointerDown={(e) => {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          startHold(take);
        }}
        onPointerUp={releaseHold}
        onPointerCancel={releaseHold}
        onKeyDown={(e) => (e.key === " " || e.key === "Enter") && !e.repeat && (e.preventDefault(), startHold(take))}
        onKeyUp={(e) => (e.key === " " || e.key === "Enter") && releaseHold()}
        className={cn("hidden h-8 touch-none items-center gap-1.5 rounded-full border px-3 text-[12.5px] transition-colors select-none sm:inline-flex",
          ghost ? "border-ink bg-highlight-soft text-ink" : "border-hairline bg-surface text-muted-foreground hover:border-ink/25 hover:text-ink")}>
        <Ear className="size-3.5" /> {ghost ? "Hearing the reference" : "Hold to hear reference"}
      </TooltipTrigger>
      <TooltipContent className="max-w-[260px]">
        The reference speaker from the same point of the script, for as long as you hold. Release to come back. <Kbd>Shift</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}

function LoopButton({ player }: { player: Player }) {
  const { loop } = usePlayerState(player);
  if (!loop) return null;
  return (
    <Tooltip>
      <TooltipTrigger onClick={() => player.setLoop(null)} aria-label="Stop looping"
        className="inline-flex h-7 items-center gap-1.5 rounded-full bg-ink/[0.06] px-2.5 text-[12px] text-ink transition-colors hover:bg-ink/10">
        <Repeat className="size-3.5" /> Loop
      </TooltipTrigger>
      <TooltipContent>Stop looping <Kbd>L</Kbd></TooltipContent>
    </Tooltip>
  );
}

export function StageTransport({ take, level, player, ranks, onStep }: {
  take: Take; level: Level; player: Player; ranks: number[]; onStep: (dir: 1 | -1) => void;
}) {
  const { playing, refPlaying, label, rate } = usePlayerState(player);
  const refIdx = useStage((s) => s.refIdx);
  const selected = useStage((s) => s.selected);
  const { setRefIdx, zoom, fit } = useStage.getState();
  const audible = playing || refPlaying;
  const sel = level === "explore" && selected !== null ? take.flaws[selected] : null;
  const ref = take.references[refIdx];

  return (
    <div className="flex h-12 items-center gap-2 sm:gap-3">
      <Tooltip>
        <TooltipTrigger onClick={() => player.toggle()} aria-label={playing ? "Pause" : "Play the recording"}
          className="grid size-9 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground shadow-[0_2px_8px_color-mix(in_oklab,var(--shadow)_18%,transparent)] transition-transform hover:scale-[1.05] active:scale-95">
          <AnimatePresence mode="wait" initial={false}>
            <motion.span key={playing ? "pause" : "play"} initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }}
              transition={{ duration: duration.instant }}>
              {playing ? <Pause className="size-4 fill-current" /> : <Play className="ml-0.5 size-4 fill-current" />}
            </motion.span>
          </AnimatePresence>
        </TooltipTrigger>
        <TooltipContent>{playing ? "Pause" : "Play"} <Kbd>Space</Kbd></TooltipContent>
      </Tooltip>

      <Clock take={take} />
      <LoopButton player={player} />

      {/* what is audible right now: easy to miss when it is a reference delivery */}
      <AnimatePresence>
        {audible && label && (
          <motion.span role="status" initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -6 }}
            transition={{ duration: duration.quick, ease }}
            className={cn("flex min-w-0 items-center gap-2 rounded-full py-1 pr-1 pl-2.5 text-[12.5px]",
              refPlaying ? "bg-highlight-soft text-ink" : "bg-ink/[0.05] text-ink/80")}>
            <Bars on={audible} />
            <span className="max-w-[34vw] truncate font-medium sm:max-w-[260px]">{label}</span>
            <button onClick={() => player.stop()} aria-label="Stop" className="grid size-6 place-items-center rounded-full transition-colors hover:bg-ink/10">
              <Square className="size-2.5 fill-current" />
            </button>
          </motion.span>
        )}
      </AnimatePresence>

      {!(audible && label) && level !== "explore" && <Readout take={take} />}

      {level === "explore" && (
        <div className="hidden items-center gap-1 border-l border-hairline pl-3 md:flex">
          <IconButton label="Previous finding in time" kbd="K" onClick={() => onStep(-1)}><ChevronLeft className="size-4" /></IconButton>
          <IconButton label="Next finding in time" kbd="J" onClick={() => onStep(1)}><ChevronRight className="size-4" /></IconButton>
          {sel && (
            <span className="flex min-w-0 items-center gap-2 pl-1 text-[12.5px]">
              <span className="size-1.5 shrink-0 rounded-full" style={{ background: CATEGORY[sel.category].color }} />
              <span className="truncate text-foreground/85">{ranks[selected!]}. {plainTitle(sel)}</span>
            </span>
          )}
        </div>
      )}

      <div className="ml-auto flex items-center gap-1.5">
        <span className="hidden rounded-full border border-hairline bg-surface p-0.5 lg:flex" role="group" aria-label="Playback speed">
          {RATES.map((r) => (
            <button key={r} onClick={() => player.setRate(r)} aria-pressed={rate === r}
              className="relative rounded-full px-2 py-0.5 font-mono text-[11px] transition-colors">
              {rate === r && <motion.span layoutId="stage-rate" transition={spring.snappy} className="absolute inset-0 rounded-full bg-selected" />}
              <span className={cn("relative", rate === r ? "text-ink" : "text-muted-foreground hover:text-ink")}>{r}×</span>
            </button>
          ))}
        </span>

        {ref && <HoldButton take={take} player={player} />}

        {ref && (
          <DropdownMenu>
            <DropdownMenuTrigger aria-label="Reference delivery for comparisons"
              className="inline-flex h-8 max-w-[44vw] items-center gap-1.5 rounded-md px-2 text-[12.5px] text-muted-foreground transition-colors hover:bg-hover hover:text-ink aria-expanded:bg-selected sm:max-w-none">
              <span className="hidden text-faint sm:inline">Compare with</span>
              <span className="truncate text-ink">{referenceName(take, ref.take_id)}</span>
              <ChevronDown className="size-3.5 shrink-0" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Reference delivery</DropdownMenuLabel>
                {take.references.map((r, i) => (
                  <DropdownMenuItem key={r.take_id} onClick={() => setRefIdx(i)}>
                    {referenceName(take, r.take_id)}
                    {i === refIdx && <Check className="ml-auto size-3.5" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <AnimatePresence initial={false}>
          {level === "explore" && (
            <motion.div className="flex items-center gap-1" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 8 }}
              transition={{ duration: duration.quick, ease }}>
              <span className="mx-1 hidden h-5 w-px bg-hairline sm:block" />
              <ViewMenu take={take} />
              <span className="hidden sm:contents">
                <IconButton label="Zoom out" kbd="−" onClick={() => zoom(1.6)}><ZoomOut className="size-4" /></IconButton>
                <IconButton label="Zoom in" kbd="=" onClick={() => zoom(1 / 1.6)}><ZoomIn className="size-4" /></IconButton>
              </span>
              <IconButton label="Fit whole recording" kbd="0" onClick={fit}><Maximize2 className="size-4" /></IconButton>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
