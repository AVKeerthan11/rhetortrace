import { Check, ChevronLeft, ChevronRight, Maximize2, Pause, Play, SlidersHorizontal, ZoomIn, ZoomOut } from "lucide-react";
import { CATEGORY } from "@/lib/categories";
import { plainTitle } from "@/lib/findings";
import { fmtClock } from "@/lib/format";
import { usePlayerState, usePlayerTime, type Player } from "@/lib/player";
import { useUi, type Layers } from "@/lib/store";
import type { Take } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

function IconButton({ label, kbd, onClick, children, className }: { label: string; kbd?: string; onClick: () => void; children: React.ReactNode; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        onClick={onClick}
        aria-label={label}
        className={cn("grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground", className)}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>
        {label} {kbd && <Kbd>{kbd}</Kbd>}
      </TooltipContent>
    </Tooltip>
  );
}

const LAYERS: { key: keyof Layers; label: string; hint: string; color?: string }[] = [
  { key: "pitch", label: "Pitch contour", hint: "voice melody, semitones", color: "var(--cat-pitch)" },
  { key: "energy", label: "Energy contour", hint: "loudness, dB", color: "var(--cat-energy)" },
  { key: "reference", label: "Reference range", hint: "shaded band behind the contours" },
  { key: "deviation", label: "Deviation heat", hint: "per-word distance from the references" },
  { key: "truth", label: "Injected edits", hint: "demo recordings only", color: "var(--truth)" },
];

function ViewMenu({ take }: { take: Take }) {
  const layers = useUi((s) => s.layers);
  const toggle = useUi((s) => s.toggleLayer);
  return (
    <Popover>
      <PopoverTrigger className="inline-flex h-8 items-center gap-1.5 rounded-md border border-hairline bg-surface px-2.5 text-[12.5px] transition-colors hover:border-ink/20 aria-expanded:bg-selected">
        <SlidersHorizontal className="size-3.5" /> View
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-64 p-1.5">
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

export function TransportBar({ take, player, selected, rank, onPrev, onNext, onZoom, onFit }: {
  take: Take; player: Player; selected: number | null; rank: number | null; onPrev: () => void; onNext: () => void;
  onZoom: (k: number) => void; onFit: () => void;
}) {
  const time = usePlayerTime(player);
  const { playing } = usePlayerState(player);
  const f = selected !== null ? take.flaws[selected] : null;
  return (
    <div className="flex h-[56px] shrink-0 items-center gap-3 border-t border-hairline bg-surface px-4">
      <div className="flex items-center gap-1">
        <IconButton label="Previous finding in time" kbd="K" onClick={onPrev}><ChevronLeft className="size-4" /></IconButton>
        <Tooltip>
          <TooltipTrigger
            onClick={() => player.toggle()}
            aria-label={playing ? "Pause" : "Play"}
            className="grid size-9 place-items-center rounded-full bg-ink text-primary-foreground transition-transform hover:scale-[1.04] active:scale-95"
          >
            {playing ? <Pause className="size-4 fill-current" /> : <Play className="ml-0.5 size-4 fill-current" />}
          </TooltipTrigger>
          <TooltipContent>{playing ? "Pause" : "Play"} <Kbd>Space</Kbd></TooltipContent>
        </Tooltip>
        <IconButton label="Next finding in time" kbd="J" onClick={onNext}><ChevronRight className="size-4" /></IconButton>
      </div>

      <div className="font-mono text-[13px] tabular">
        <span className="text-foreground">{fmtClock(time)}</span>
        <span className="text-faint"> / {fmtClock(take.duration)}</span>
      </div>

      {f && rank !== null && (
        <div className="ml-2 flex min-w-0 items-center gap-2 border-l border-hairline pl-4 text-[12.5px] text-muted-foreground">
          <span className="size-1.5 shrink-0 rounded-full" style={{ background: CATEGORY[f.category].color }} />
          <span className="truncate text-foreground/85">{rank}. {plainTitle(f)}</span>
        </div>
      )}

      <div className="ml-auto flex items-center gap-1">
        <ViewMenu take={take} />
        <span className="mx-1 h-5 w-px bg-hairline" />
        <IconButton label="Zoom out" onClick={() => onZoom(1.6)}><ZoomOut className="size-4" /></IconButton>
        <IconButton label="Zoom in" onClick={() => onZoom(1 / 1.6)}><ZoomIn className="size-4" /></IconButton>
        <IconButton label="Fit whole recording" kbd="Esc" onClick={onFit}><Maximize2 className="size-4" /></IconButton>
      </div>
    </div>
  );
}
