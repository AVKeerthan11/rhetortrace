import { useEffect } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { motion } from "motion/react";
import { toast, Toaster } from "sonner";
import { isTypingTarget } from "@/lib/keys";
import { ease } from "@/lib/motion";
import { player } from "@/lib/player";
import { useUi } from "@/lib/store";
import { CommandPalette } from "@/components/CommandPalette";
import { NowPlaying } from "@/components/NowPlaying";
import { ShortcutsDialog } from "@/components/ShortcutsDialog";
import { TopBar } from "./TopBar";
import { useCurrentTake } from "./useCurrentTake";

function useGlobalKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useUi.getState();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        ui.setPaletteOpen(!ui.paletteOpen);
        return;
      }
      if (mod || e.altKey || isTypingTarget(e)) return;
      if (e.key === "?") {
        e.preventDefault();
        ui.setShortcutsOpen(!ui.shortcutsOpen);
      } else if ((e.key === "[" || e.key === "]") && player.src) {
        player.setRate(player.rate + (e.key === "]" ? 0.25 : -0.25));
        toast(`Playback ${player.rate}×`, { id: "rate", duration: 1200 });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function AppShell() {
  const { pathname } = useLocation();
  const { id, view } = useCurrentTake();
  useGlobalKeys();

  // Leaving a recording stops its audio (moving between its own screens does not).
  useEffect(() => {
    if (!id) player.stop();
  }, [id]);

  // Finding pages animate between each other themselves; don't re-fade the whole page.
  const pageKey = view === "finding" ? `${id}/finding` : pathname;

  return (
    <div className="flex h-full min-w-[1024px] flex-col overflow-hidden bg-background">
      <TopBar />
      <motion.main
        key={pageKey}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, ease }}
        className="min-h-0 flex-1 overflow-hidden"
      >
        <Outlet />
      </motion.main>
      <NowPlaying hidden={view === "explore"} />
      <CommandPalette />
      <ShortcutsDialog />
      <Toaster
        position="bottom-center"
        offset={80}
        toastOptions={{
          className: "!rounded-xl !border-0 !bg-ink !text-[#fbfaf7] !font-sans !shadow-float [&_[data-description]]:!text-[#fbfaf7]/65",
        }}
      />
    </div>
  );
}
