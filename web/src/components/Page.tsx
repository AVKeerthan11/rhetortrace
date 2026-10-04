import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { rise, spring } from "@/lib/motion";
import { cn } from "@/lib/utils";

// Building blocks for the reading pages (the Lab's reports, the analysis forms): one serif
// headline, prose, hairline tables, on the page grid with an optional contents margin.

export function ReadingPage({ children, wide, toc }: { children: React.ReactNode; wide?: boolean; toc?: boolean }) {
  const scroller = useRef<HTMLDivElement>(null);
  return (
    <div ref={scroller} className="h-full overflow-y-auto scrollbar-thin">
      <div className="page grid-page pt-10 pb-28 lg:pt-12">
        <div className={cn("col-span-full min-w-0", toc ? "lg:col-span-9 xl:col-span-8" : wide ? "lg:col-span-10 lg:col-start-2" : "lg:col-span-8 lg:col-start-3")}>
          {children}
        </div>
        {toc && (
          <aside className="hidden lg:col-span-3 lg:col-start-10 lg:block">
            <Contents scroller={scroller} />
          </aside>
        )}
      </div>
    </div>
  );
}

/** "On this page": the page's sections, the one being read marked; click scrolls to it. */
function Contents({ scroller }: { scroller: React.RefObject<HTMLDivElement | null> }) {
  const [items, setItems] = useState<{ id: string; title: string }[]>([]);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    let last = "";
    const scan = () => {
      const found = [...root.querySelectorAll<HTMLElement>("[data-toc]")].map((el) => ({ id: el.id, title: el.dataset.toc! }));
      const key = JSON.stringify(found);
      if (key !== last) {
        last = key;
        setItems(found);
      }
    };
    scan();
    const mo = new MutationObserver(scan);
    mo.observe(root, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [scroller]);

  useEffect(() => {
    const root = scroller.current;
    if (!root || !items.length) return;
    const onScroll = () => {
      const top = root.getBoundingClientRect().top + 120;
      let current = items[0].id;
      for (const it of items) {
        const el = document.getElementById(it.id);
        if (el && el.getBoundingClientRect().top <= top) current = it.id;
      }
      setActive(current);
    };
    onScroll();
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => root.removeEventListener("scroll", onScroll);
  }, [scroller, items]);

  if (!items.length) return null;
  return (
    <nav aria-label="On this page" className="sticky top-12 mt-[148px]">
      <div className="mb-3 text-[10.5px] font-medium tracking-[0.14em] text-faint uppercase">On this page</div>
      <ul className="space-y-0.5 border-l border-hairline">
        {items.map((it) => (
          <li key={it.id} className="relative">
            {active === it.id && <motion.span layoutId="toc-active" transition={spring.snappy} className="absolute top-1 bottom-1 -left-px w-[2px] rounded-full bg-ink" />}
            <button onClick={() => document.getElementById(it.id)?.scrollIntoView({ behavior: "smooth", block: "start" })}
              className={cn("block w-full py-1 pl-3.5 text-left text-[13px] leading-snug transition-colors", active === it.id ? "text-ink" : "text-muted-foreground hover:text-ink")}>
              {it.title}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function PageHeader({ eyebrow, title, children }: { eyebrow: string; title: React.ReactNode; children?: React.ReactNode }) {
  return (
    <header>
      <motion.div {...rise(0)} className="text-[11px] font-medium tracking-[0.14em] text-faint uppercase">{eyebrow}</motion.div>
      <motion.h1 {...rise(1)} className="mt-2 font-display text-display-l">{title}</motion.h1>
      {children && (
        <motion.div {...rise(2)} className="mt-4 max-w-2xl space-y-3 text-[15px] leading-relaxed text-muted-foreground">
          {children}
        </motion.div>
      )}
    </header>
  );
}

export function Section({ id, title, lead, aside, children, i = 3 }: {
  id?: string; title: React.ReactNode; lead?: React.ReactNode; aside?: React.ReactNode; children?: React.ReactNode; i?: number;
}) {
  return (
    <motion.section {...rise(i)} id={id ?? (typeof title === "string" ? slug(title) : undefined)}
      data-toc={typeof title === "string" ? title : undefined} className="mt-14 scroll-mt-6">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="font-display text-display-m">{title}</h2>
        {aside}
      </div>
      {lead && <div className="mt-2 max-w-2xl text-[14.5px] leading-relaxed text-muted-foreground">{lead}</div>}
      {children && <div className="mt-5">{children}</div>}
    </motion.section>
  );
}

/** Big number with a plain sentence under it. Typographic, not a chart. */
export function Stat({ value, label, sub }: { value: React.ReactNode; label: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="border-t border-ink/80 pt-3">
      <div className="font-display text-[clamp(36px,3.4vw,48px)] leading-none tabular">{value}</div>
      <div className="mt-2 text-[14px] leading-snug text-ink/85">{label}</div>
      {sub && <div className="mt-1 text-[12.5px] leading-snug text-muted-foreground">{sub}</div>}
    </div>
  );
}

/** Hairline table: header in small caps, numbers right-aligned and tabular. */
export function Table({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("overflow-x-auto rounded-xl border border-hairline bg-surface", className)}>
      <table className="w-full text-[13.5px] [&>tbody>tr:first-child>td]:border-t-0">{children}</table>
    </div>
  );
}

export function Th({ children, right, className }: { children?: React.ReactNode; right?: boolean; className?: string }) {
  return (
    <th className={cn("border-b border-hairline px-3 py-2.5 first:pl-4 last:pr-4 text-[10.5px] font-medium tracking-[0.1em] whitespace-nowrap text-faint uppercase", right ? "text-right" : "text-left", className)}>
      {children}
    </th>
  );
}

export function Td({ children, right, mono, muted, className, colSpan }: {
  children?: React.ReactNode; right?: boolean; mono?: boolean; muted?: boolean; className?: string; colSpan?: number;
}) {
  return (
    <td colSpan={colSpan} className={cn("border-t border-hairline px-3 py-2.5 align-baseline first:pl-4 last:pr-4",
      right && "text-right", mono && "font-mono text-[12.5px] whitespace-nowrap tabular", muted && "text-muted-foreground", className)}>
      {children}
    </td>
  );
}

export function Note({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn("mt-3 text-[12.5px] leading-relaxed text-muted-foreground", className)}>{children}</p>;
}
