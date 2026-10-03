import { useState } from "react";
import { Link, NavLink, useMatch, useNavigate } from "react-router-dom";
import { ChevronDown, ChevronRight, FileJson, Keyboard, Link2, MoreHorizontal, Music, ScanLine, Search } from "lucide-react";
import { copyLink, downloadAnalysis, downloadAudio } from "@/lib/actions";
import { isRunId } from "@/lib/api";
import { useIndex, useTake } from "@/lib/data";
import { MOD } from "@/lib/keys";
import { useUi } from "@/lib/store";
import { analyzePath, evaluationPath, explorePath, groupBySpeech, methodPath, overviewPath, robustnessPath, speechName, takeName } from "@/lib/takes";
import { cn } from "@/lib/utils";
import { LogoMark, Wordmark } from "@/components/Logo";
import { TakeMarks } from "@/components/TakeMarks";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useCurrentTake } from "./useCurrentTake";

/** Logo, a breadcrumb that always says where you are, and one overflow menu. */
export function TopBar() {
  const { id, view, rank } = useCurrentTake();
  const { data: index } = useIndex();
  const run = isRunId(id);
  const { data: runTake } = useTake(run ? id : undefined); // uploaded analyses are not in index.json
  const summary = id && !run ? index?.takes.find((t) => t.id === id) ?? null : null;
  const total = summary?.n_flaws ?? runTake?.flaws.length ?? 0;
  const evaluation = useMatch(evaluationPath);
  const robustness = useMatch(robustnessPath);
  const method = useMatch(methodPath);
  const analyze = useMatch(`${analyzePath}/*`);

  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-hairline bg-background/85 px-5 backdrop-blur">
      <Link to="/" aria-label="RhetorTrace home" className="flex items-center gap-2.5">
        <LogoMark />
        <Wordmark />
      </Link>

      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-[13.5px]">
        {id && (
          <>
            <Crumb sep />
            <Link to="/" className="rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:text-ink">All recordings</Link>
            <Crumb sep />
            {run ? (
              runTake ? (
                <Link to={overviewPath(runTake.id)} className={cn("rounded-md px-1.5 py-1 transition-colors hover:text-ink", view === "overview" ? "font-medium" : "text-muted-foreground")}>
                  Your recording · {runTake.display?.recording ?? runTake.take_id}
                </Link>
              ) : <span className="shimmer h-4 w-32 rounded" />
            ) : summary ? <TakeCrumb currentId={summary.id} current={view === "overview"} /> : <span className="shimmer h-4 w-32 rounded" />}
            {view === "finding" && rank && (
              <>
                <Crumb sep />
                <span className="px-1.5 font-medium">Finding {rank}{total ? <span className="font-normal text-muted-foreground"> of {total}</span> : null}</span>
              </>
            )}
            {view === "explore" && (
              <>
                <Crumb sep />
                <span className="px-1.5 font-medium">Timeline explorer</span>
              </>
            )}
          </>
        )}
        {(evaluation || robustness) && (
          <>
            <Crumb sep />
            {robustness ? (
              <>
                <Link to={evaluationPath} className="rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:text-ink">Evaluation</Link>
                <Crumb sep />
                <span className="px-1.5 font-medium">Robustness</span>
              </>
            ) : <span className="px-1.5 font-medium">Evaluation</span>}
          </>
        )}
        {method && (
          <>
            <Crumb sep />
            <span className="px-1.5 font-medium">Method</span>
          </>
        )}
        {analyze && (
          <>
            <Crumb sep />
            {analyze.params["*"] ? (
              <>
                <Link to={analyzePath} className="rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:text-ink">New analysis</Link>
                <Crumb sep />
                <span className="px-1.5 font-medium">Processing</span>
              </>
            ) : <span className="px-1.5 font-medium">New analysis</span>}
          </>
        )}
      </nav>

      <nav aria-label="Project" className="ml-auto flex items-center gap-1 text-[13px]">
        <TopLink to={analyzePath}>New analysis</TopLink>
        <TopLink to={evaluationPath}>Evaluation</TopLink>
        <TopLink to={methodPath}>How it works</TopLink>
      </nav>
      <div>{id ? <TakeMenu id={id} showExplore={view !== "explore"} /> : <AppMenu />}</div>
    </header>
  );
}

function TopLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink to={to}
      className={({ isActive }) => cn("rounded-full px-3 py-1.5 transition-colors", isActive ? "bg-selected text-ink" : "text-muted-foreground hover:bg-hover hover:text-ink")}>
      {children}
    </NavLink>
  );
}

function Crumb({ sep }: { sep?: boolean }) {
  return sep ? <ChevronRight className="size-3.5 shrink-0 text-faint" /> : null;
}

/** "Speech 01 · Demo recording ▾": goes to the overview, or switches to another recording. */
function TakeCrumb({ currentId, current }: { currentId: string; current: boolean }) {
  const [open, setOpen] = useState(false);
  const { data: index } = useIndex();
  const navigate = useNavigate();
  const t = index?.takes.find((x) => x.id === currentId);
  if (!index || !t) return null;
  return (
    <span className="flex items-center">
      <Link to={overviewPath(t.id)} className={cn("rounded-l-md py-1 pr-1 pl-1.5 transition-colors hover:text-ink", current ? "font-medium" : "text-muted-foreground")}>
        {speechName(t.speech_id)} · {takeName(t)}
      </Link>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger aria-label="Switch recording" className="grid size-6 place-items-center rounded-md text-faint transition-colors hover:bg-hover hover:text-ink aria-expanded:bg-selected">
          <ChevronDown className="size-3.5" />
        </PopoverTrigger>
        <PopoverContent className="w-[340px] overflow-hidden p-0">
          <Command>
            <CommandInput placeholder="Switch recording…" autoFocus />
            <CommandList>
              <CommandEmpty>No recording matches.</CommandEmpty>
              {groupBySpeech(index.takes).map((g) => (
                <CommandGroup key={g.speech} heading={`${speechName(g.speech)} · “${g.opening}”`}>
                  {g.takes.map((x) => (
                    <CommandItem key={x.id} value={`${speechName(x.speech_id)} ${takeName(x)} ${x.take_id}`}
                      onSelect={() => { setOpen(false); navigate(overviewPath(x.id)); }}
                      className="flex-col items-stretch gap-1.5">
                      <span className="flex items-baseline gap-2">
                        <span className={cn(x.id === currentId && "font-medium")}>{takeName(x)}</span>
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
    </span>
  );
}

function MenuButton() {
  return (
    <DropdownMenuTrigger aria-label="More"
      className="grid size-9 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-hover hover:text-ink aria-expanded:bg-selected">
      <MoreHorizontal className="size-[18px]" />
    </DropdownMenuTrigger>
  );
}

function GeneralItems() {
  const openPalette = useUi((s) => s.setPaletteOpen);
  const openShortcuts = useUi((s) => s.setShortcutsOpen);
  return (
    <>
      <DropdownMenuItem onClick={() => openPalette(true)}><Search /> Search <DropdownMenuShortcut>{MOD} K</DropdownMenuShortcut></DropdownMenuItem>
      <DropdownMenuItem onClick={() => openShortcuts(true)}><Keyboard /> Keyboard shortcuts <DropdownMenuShortcut>?</DropdownMenuShortcut></DropdownMenuItem>
    </>
  );
}

function TakeMenu({ id, showExplore }: { id: string; showExplore: boolean }) {
  const { data: take } = useTake(id);
  const navigate = useNavigate();
  return (
    <DropdownMenu>
      <MenuButton />
      <DropdownMenuContent align="end" className="w-60">
        {showExplore && (
          <>
            <DropdownMenuItem onClick={() => navigate(explorePath(id))}><ScanLine /> Open timeline explorer</DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem disabled={!take} onClick={() => take && downloadAnalysis(take)}><FileJson /> Download analysis (JSON)</DropdownMenuItem>
        <DropdownMenuItem disabled={!take} onClick={() => take && downloadAudio(take)}><Music /> Download audio</DropdownMenuItem>
        <DropdownMenuItem onClick={() => void copyLink()}><Link2 /> Copy link to this page</DropdownMenuItem>
        <DropdownMenuSeparator />
        <GeneralItems />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AppMenu() {
  return (
    <DropdownMenu>
      <MenuButton />
      <DropdownMenuContent align="end" className="w-56">
        <GeneralItems />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
