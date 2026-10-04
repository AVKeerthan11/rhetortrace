import { Link, useLocation, useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { FileJson, Keyboard, Link2, Menu, Moon, MoreHorizontal, Music, Plus, ScanLine, Search, Sun } from "lucide-react";
import { copyLink, downloadAnalysis, downloadAudio } from "@/lib/actions";
import { isRunId } from "@/lib/api";
import { useTake } from "@/lib/data";
import { MOD } from "@/lib/keys";
import { spring } from "@/lib/motion";
import { useUi } from "@/lib/store";
import { analyzePath, explorePath, homePath, labPath, recordingsPath } from "@/lib/takes";
import { cn } from "@/lib/utils";
import { LogoMark, Wordmark } from "@/components/Logo";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCurrentTake } from "./useCurrentTake";

const NAV = [
  { to: homePath, label: "Home" },
  { to: analyzePath, label: "Analyse" },
  { to: recordingsPath, label: "Your recordings" },
  { to: labPath, label: "Lab" },
] as const;

/** Which section the current page belongs to. A recording belongs to "Your recordings" when it
 *  was uploaded, to the Lab when it is one of the dataset's controlled examples. */
function useSection(): string {
  const { pathname } = useLocation();
  const { id } = useCurrentTake();
  if (id) return isRunId(id) ? recordingsPath : labPath;
  if (pathname.startsWith(analyzePath)) return analyzePath;
  if (pathname.startsWith(recordingsPath)) return recordingsPath;
  if (pathname.startsWith(labPath)) return labPath;
  return pathname === homePath ? homePath : "";
}

/** Logo, the four sections, search, the primary action and one overflow menu. */
export function TopBar() {
  const { id, view } = useCurrentTake();
  const section = useSection();
  const { pathname } = useLocation();
  const openPalette = useUi((s) => s.setPaletteOpen);

  return (
    <header className="shrink-0 border-b border-hairline bg-background/85 backdrop-blur">
      <div className="page flex h-14 items-center gap-3">
        <Link to="/" aria-label="RhetorTrace home" className="mr-2 flex items-center gap-2.5">
          <LogoMark />
          <Wordmark />
        </Link>

        <nav aria-label="Main" className="hidden items-center gap-0.5 text-[13.5px] md:flex">
          {NAV.map((n) => {
            const active = section === n.to;
            return (
              <Link key={n.to} to={n.to} aria-current={active ? "page" : undefined}
                className={cn("relative rounded-full px-3 py-1.5 transition-colors", active ? "text-ink" : "text-muted-foreground hover:text-ink")}>
                {active && <motion.span layoutId="nav-pill" transition={spring.snappy} className="absolute inset-0 rounded-full bg-selected" />}
                <span className="relative">{n.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger onClick={() => openPalette(true)} aria-label="Search"
              className="hidden h-9 items-center gap-2 rounded-full border border-hairline bg-surface/70 pr-2 pl-3 text-[12.5px] text-muted-foreground transition-colors hover:border-ink/20 hover:text-ink lg:flex">
              <Search className="size-3.5" /> Search <Kbd>{MOD} K</Kbd>
            </TooltipTrigger>
            <TooltipContent>Findings, recordings and actions</TooltipContent>
          </Tooltip>
          {pathname !== analyzePath && (
            <Link to={analyzePath}
              className="group inline-flex h-9 items-center gap-1.5 rounded-full bg-ink px-3.5 text-[13px] font-medium text-primary-foreground shadow-[0_4px_14px_-6px_color-mix(in_oklab,var(--shadow)_50%,transparent)] transition-transform hover:scale-[1.03] active:scale-[0.98]">
              <Plus className="size-4 transition-transform duration-200 group-hover:rotate-90" />
              <span className="hidden sm:inline">New analysis</span>
            </Link>
          )}
          <MobileNav section={section} />
          {id ? <TakeMenu id={id} showExplore={view !== "explore"} /> : <AppMenu />}
        </div>
      </div>
    </header>
  );
}

function MobileNav({ section }: { section: string }) {
  const navigate = useNavigate();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="Menu"
        className="grid size-9 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-hover hover:text-ink aria-expanded:bg-selected md:hidden">
        <Menu className="size-[18px]" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {NAV.map((n) => (
          <DropdownMenuItem key={n.to} onClick={() => navigate(n.to)} className={cn(section === n.to && "font-medium")}>
            {n.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  return (
    <>
      <DropdownMenuItem onClick={() => openPalette(true)}><Search /> Search <DropdownMenuShortcut>{MOD} K</DropdownMenuShortcut></DropdownMenuItem>
      <DropdownMenuItem onClick={() => openShortcuts(true)}><Keyboard /> Keyboard shortcuts <DropdownMenuShortcut>?</DropdownMenuShortcut></DropdownMenuItem>
      <DropdownMenuItem onClick={() => setTheme(theme === "studio" ? "report" : "studio")}>
        {theme === "studio" ? <Sun /> : <Moon />} {theme === "studio" ? "Light appearance" : "Dark appearance"}
      </DropdownMenuItem>
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
