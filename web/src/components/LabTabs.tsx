import { NavLink } from "react-router-dom";
import { motion } from "motion/react";
import { spring } from "@/lib/motion";
import { evaluationPath, examplesPath, labPath, methodPath, robustnessPath } from "@/lib/takes";
import { cn } from "@/lib/utils";

const TABS = [
  { to: labPath, label: "Overview" },
  { to: examplesPath, label: "Examples" },
  { to: evaluationPath, label: "Performance" },
  { to: robustnessPath, label: "Robustness" },
  { to: methodPath, label: "Method" },
];

/** The Lab's sections: controlled examples and the validation reports. */
export function LabTabs() {
  return (
    <nav aria-label="Lab" className="-mx-1 mt-8 flex gap-1 overflow-x-auto border-b border-hairline px-1 scrollbar-thin">
      {TABS.map((t) => (
        <NavLink key={t.to} to={t.to} end
          className={({ isActive }) => cn("relative shrink-0 px-3 pb-2.5 text-[13.5px] whitespace-nowrap transition-colors", isActive ? "font-medium text-ink" : "text-muted-foreground hover:text-ink")}>
          {({ isActive }) => (
            <>
              {t.label}
              {isActive && <motion.span layoutId="lab-tab" transition={spring.snappy} className="absolute inset-x-2 -bottom-px h-[2px] rounded-full bg-ink" />}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
