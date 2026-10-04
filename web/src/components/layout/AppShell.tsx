import { Suspense, useEffect } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { MotionConfig, motion } from "motion/react";
import { toast, Toaster } from "sonner";
import { isTypingTarget } from "@/lib/keys";
import { ease } from "@/lib/motion";
import { player } from "@/lib/player";
import { useUi } from "@/lib/store";
import { CommandPalette } from "@/components/CommandPalette";
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

/** Apply the appearance to <html> (index.html applies the saved one before the first paint). */
function useTheme() {
  const theme = useUi((s) => s.theme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "studio" ? "#0d1117" : "#f5f6f8");
  }, [theme]);
}

export function AppShell() {
  const { pathname } = useLocation();
  useTheme();
  const { id } = useCurrentTake();
  useGlobalKeys();

  // Leaving a recording stops its audio (moving between its own screens does not).
  useEffect(() => {
    if (!id) player.stop();
  }, [id]);

  // A recording's three zoom levels share one persistent layout (the stage): only leaving the
  // recording re-fades the page. Other pages fade in on navigation.
  const pageKey = id ? `/take/${id}` : pathname;

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex h-full flex-col overflow-hidden bg-background">
        <TopBar />
        <motion.main
          key={pageKey}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.28, ease }}
          className="min-h-0 flex-1 overflow-hidden"
        >
          <Suspense fallback={<PageFallback />}>
            <Outlet />
          </Suspense>
        </motion.main>
        <CommandPalette />
        <ShortcutsDialog />
        <Toaster
          position="bottom-center"
          offset={80}
          toastOptions={{
            className: "!rounded-xl !border-0 !bg-ink !text-primary-foreground !font-sans !shadow-float [&_[data-description]]:!text-primary-foreground/65",
          }}
        />
      </div>
    </MotionConfig>
  );
}

/** While a page's code loads: a quiet sheen where the page will be. */
function PageFallback() {
  return (
    <div className="page space-y-4 pt-14">
      <div className="shimmer h-3 w-40 rounded" />
      <div className="shimmer h-12 w-2/3 rounded-lg" />
      <div className="shimmer h-4 w-1/2 rounded" />
    </div>
  );
}
