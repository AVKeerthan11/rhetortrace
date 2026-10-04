import { useEffect, useRef } from "react";
import { animate, motion, useInView } from "motion/react";
import { ease, prefersReducedMotion } from "@/lib/motion";

/** A headline that writes itself in: words rise out of a soft blur one after another; `mark`
 *  words get the highlighter stroke, drawn once the sentence has landed. */
export function Headline({ parts, className, delay = 0.1 }: { parts: { text: string; mark?: boolean }[]; className?: string; delay?: number }) {
  let i = 0;
  // plain parts rise word by word; a marked part is one phrase under one highlighter stroke
  const words = parts.flatMap((p) => (p.mark ? [{ w: p.text, mark: true }] : p.text.split(/(\s+)/).filter(Boolean).map((w) => ({ w, mark: false }))));
  const total = words.filter((x) => x.w.trim()).length;
  return (
    <h1 className={className} aria-label={parts.map((p) => p.text).join("")}>
      {words.map(({ w, mark }, k) => {
        if (!w.trim()) return <span key={k}> </span>;
        const d = delay + 0.055 * i++;
        const word = (
          <motion.span key={k} aria-hidden className="inline-block will-change-transform"
            initial={{ opacity: 0, y: "0.45em", filter: "blur(10px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            transition={{ delay: d, duration: 0.7, ease }}>
            {w}
          </motion.span>
        );
        if (!mark) return word;
        return (
          <motion.span key={k} aria-hidden className="marker inline-block py-[0.02em] pr-[0.4em] pl-[0.14em] whitespace-nowrap italic"
            initial={{ opacity: 0, y: "0.45em", filter: "blur(10px)", backgroundSize: "0% 100%" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)", backgroundSize: "100% 100%" }}
            transition={{ delay: d, duration: 0.7, ease, backgroundSize: { delay: delay + 0.055 * total + 0.25, duration: 0.6, ease } }}
            style={{ backgroundRepeat: "no-repeat" }}>
            {w}
          </motion.span>
        );
      })}
    </h1>
  );
}

/** A number that counts up from zero the first time it scrolls into view ("89%", "6.2"). */
export function CountUp({ value, className }: { value: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "-10% 0px" });
  const parse = (v: string) => v.match(/^([^\d-]*)(-?[\d.]+)(.*)$/);
  const m = parse(value);
  useEffect(() => {
    const el = ref.current, m = parse(value);
    if (!el || !m || !inView) return;
    const target = parseFloat(m[2]), decimals = (m[2].split(".")[1] ?? "").length;
    if (prefersReducedMotion()) {
      el.textContent = value;
      return;
    }
    const a = animate(0, target, { duration: 1.4, ease, onUpdate: (v) => (el.textContent = `${m[1]}${v.toFixed(decimals)}${m[3]}`) });
    return () => a.stop();
  }, [inView, value]);
  return <span ref={ref} className={className}>{m ? `${m[1]}${(0).toFixed((m[2].split(".")[1] ?? "").length)}${m[3]}` : value}</span>;
}

/** A block that rises in when it scrolls into view. */
export function Rise({ children, className, delay = 0, as = "div" }: { children: React.ReactNode; className?: string; delay?: number; as?: "div" | "section" | "li" }) {
  const C = motion[as];
  return (
    <C className={className} initial={{ opacity: 0, y: 26 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-8% 0px" }}
      transition={{ delay, duration: 0.7, ease }}>
      {children}
    </C>
  );
}
