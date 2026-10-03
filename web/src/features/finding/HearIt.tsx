import { ArrowLeftRight, Check, ChevronDown, Ear, Pause, Play } from "lucide-react";
import { listenFor, referenceRange, takeRange } from "@/lib/findings";
import { player, usePlayerState } from "@/lib/player";
import { referenceName } from "@/lib/takes";
import type { Flaw, Take } from "@/lib/types";
import { cn } from "@/lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

/** The primary action of a finding: hear this recording, then the same words from a good delivery. */
export function HearIt({ take, f, rank, refIdx, setRefIdx, onListened }: {
  take: Take; f: Flaw; rank: number; refIdx: number; setRefIdx: (i: number) => void; onListened: () => void;
}) {
  const { label, playing, refPlaying } = usePlayerState();
  const ref = take.references[refIdx];
  const mine = takeRange(take, f);
  const theirs = referenceRange(take, f, refIdx);
  const refName = ref ? referenceName(take, ref.take_id) : "";
  const L = { mine: `Finding ${rank} · this recording`, ref: `Finding ${rank} · reference ${refName}` };
  const active = playing || refPlaying ? label : null;

  const playMine = () => {
    onListened();
    if (active === L.mine) return player.stop();
    player.playSegment(mine[0], mine[1], L.mine);
  };
  const playRef = () => {
    if (!theirs) return;
    onListened();
    if (active === L.ref) return player.stop();
    player.playReference(ref.audio, theirs[0], theirs[1], L.ref);
  };
  const playBoth = () => {
    if (!theirs) return;
    onListened();
    player.playSequence([
      { kind: "take", range: mine, label: L.mine },
      { kind: "ref", src: ref.audio, range: theirs, label: L.ref },
    ]);
  };

  return (
    <section className="rounded-2xl border border-hairline bg-surface p-5 shadow-[0_1px_0_rgba(27,26,23,0.04)]">
      <h2 className="text-[11px] font-medium tracking-[0.14em] text-faint uppercase">Hear the difference</h2>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <PlayCard title="This recording" sub="the flagged moment" playing={active === L.mine} onClick={playMine} primary />
        <div className="relative">
          <PlayCard title="Reference delivery" sub={`same words · ${refName}`} playing={active === L.ref} onClick={playRef} disabled={!theirs} />
          {take.references.length > 1 && (
            <DropdownMenu>
              <DropdownMenuTrigger aria-label="Choose reference delivery"
                className="absolute top-3 right-3 grid size-7 place-items-center rounded-md text-faint transition-colors hover:bg-hover hover:text-ink">
                <ChevronDown className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Compare with</DropdownMenuLabel>
                  {take.references.map((r, i) => (
                    <DropdownMenuItem key={r.take_id} onClick={() => setRefIdx(i)}>
                      Reference {referenceName(take, r.take_id)}
                      {i === refIdx && <Check className="ml-auto size-3.5" />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-[13.5px] text-muted-foreground">
          <Ear className="size-4 shrink-0 text-faint" />
          <span>Listen for {listenFor(f)}.</span>
        </p>
        <button onClick={playBoth} disabled={!theirs}
          className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-medium text-ink/80 transition-colors hover:bg-hover hover:text-ink disabled:opacity-40">
          <ArrowLeftRight className="size-3.5" /> Play both, one after the other
        </button>
      </div>
    </section>
  );
}

function PlayCard({ title, sub, playing, onClick, primary, disabled }: {
  title: string; sub: string; playing: boolean; onClick: () => void; primary?: boolean; disabled?: boolean;
}) {
  return (
    <button onClick={onClick} disabled={disabled}
      className={cn(
        "group flex w-full items-center gap-3.5 rounded-xl border p-3.5 text-left transition-all disabled:opacity-40",
        playing ? "border-ink bg-highlight-soft" : "border-hairline hover:border-ink/25 hover:bg-hover",
      )}>
      <span className={cn(
        "grid size-11 shrink-0 place-items-center rounded-full transition-transform group-hover:scale-105",
        primary ? "bg-ink text-primary-foreground" : "border border-ink/20 bg-surface text-ink",
      )}>
        {playing ? <Pause className="size-4 fill-current" /> : <Play className="ml-0.5 size-4 fill-current" />}
      </span>
      <span className="min-w-0">
        <span className="block text-[14.5px] font-medium">{title}</span>
        <span className="block truncate text-[12.5px] text-muted-foreground">{playing ? "playing…" : sub}</span>
      </span>
    </button>
  );
}
