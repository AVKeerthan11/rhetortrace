import { NavLink } from "react-router-dom";
import { motion } from "motion/react";
import { spring } from "@/lib/motion";
import { evaluationPath, robustnessPath } from "@/lib/takes";
import { cn } from "@/lib/utils";

const TABS = [
  { to: evaluationPath, label: "Performance" },
  { to: robustnessPath, label: "Robustness to audio quality" },
];

/** Switches between the two evaluation reports. */
export function EvaluationTabs() {
  return (
    <nav aria-label="Evaluation reports" className="mt-8 flex gap-1 border-b border-hairline">
      {TABS.map((t) => (
        <NavLink key={t.to} to={t.to} end
          className={({ isActive }) => cn("relative px-3 pb-2.5 text-[13.5px] transition-colors", isActive ? "font-medium text-ink" : "text-muted-foreground hover:text-ink")}>
          {({ isActive }) => (
            <>
              {t.label}
              {isActive && <motion.span layoutId="eval-tab" transition={spring.snappy} className="absolute inset-x-2 -bottom-px h-[2px] rounded-full bg-ink" />}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
