import { AnimatePresence, motion } from "motion/react";
import { Square } from "lucide-react";
import { fmtClock } from "@/lib/format";
import { spring } from "@/lib/motion";
import { player, usePlayerState, usePlayerTime } from "@/lib/player";
import { cn } from "@/lib/utils";

const RATES = [0.75, 1, 1.25];

/** Floating pill that says what is audible right now. Hearing a reference delivery
 *  instead of your own recording is otherwise easy to miss. */
export function NowPlaying({ hidden }: { hidden?: boolean }) {
  const { label, refPlaying, rate } = usePlayerState();
  const show = !!label && !hidden;
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: 16, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 12, scale: 0.97 }}
          transition={spring.snappy}
          className="fixed bottom-5 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-full bg-ink py-1.5 pr-1.5 pl-4 text-[13px] text-primary-foreground shadow-float"
          role="status"
        >
          <Bars />
          <span className="font-medium">{label}</span>
          {!refPlaying && <Clock />}
          <span className="flex rounded-full bg-white/10 p-0.5">
            {RATES.map((r) => (
              <button key={r} onClick={() => player.setRate(r)}
                className={cn("rounded-full px-2 py-0.5 font-mono text-[11px] transition-colors", rate === r ? "bg-white/90 text-ink" : "text-white/60 hover:text-white")}>
                {r}×
              </button>
            ))}
          </span>
          <button onClick={() => player.stop()} aria-label="Stop" className="grid size-8 place-items-center rounded-full bg-white/10 transition-colors hover:bg-white/20">
            <Square className="size-3 fill-current" />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Clock() {
  const t = usePlayerTime();
  return <span className="font-mono text-[12px] text-white/60 tabular">{fmtClock(t)}</span>;
}

/** Three bars bouncing, so "playing" reads at a glance. */
function Bars() {
  return (
    <span className="flex h-3.5 items-end gap-[2px]" aria-hidden>
      {[0, 0.2, 0.1].map((delay, i) => (
        <motion.span key={i} className="w-[3px] rounded-full bg-highlight"
          animate={{ height: ["30%", "100%", "45%", "80%", "30%"] }}
          transition={{ duration: 0.9, repeat: Infinity, delay, ease: "easeInOut" }} />
      ))}
    </span>
  );
}
