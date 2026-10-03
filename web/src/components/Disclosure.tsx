import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronRight } from "lucide-react";
import { ease } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** "▸ Title" that expands its content in place. Used for everything secondary. */
export function Disclosure({ title, aside, children, defaultOpen = false, className }: {
  title: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean; className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={cn("border-t border-hairline", className)}>
      <button onClick={() => setOpen(!open)} aria-expanded={open}
        className="group flex w-full items-center gap-2 py-3.5 text-left text-[14px] text-ink/85 transition-colors hover:text-ink">
        <ChevronRight className={cn("size-4 text-faint transition-transform duration-200", open && "rotate-90")} />
        <span className="font-medium">{title}</span>
        {aside && <span className="ml-auto text-[12.5px] text-muted-foreground">{aside}</span>}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.28, ease }} className="overflow-hidden">
            <div className="pb-5 pl-6">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
