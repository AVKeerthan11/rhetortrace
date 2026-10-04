import { useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "motion/react";
import { ArrowRight, AudioLines, FileText, Headphones } from "lucide-react";
import { recentRuns, type RecentRun } from "@/lib/api";
import { useIndex, useTake } from "@/lib/data";
import { fmt } from "@/lib/format";
import { ease } from "@/lib/motion";
import { analyzePath, evaluationPath, examplesPath, methodPath, overviewPath, recordingsPath, robustnessPath, runPath, speechName, takeKindLabel, takeName } from "@/lib/takes";
import type { TakeSummary } from "@/lib/types";
import { pct } from "@/lib/validation";
import { TakeMarks } from "@/components/TakeMarks";
import { HeroScene } from "@/features/home/HeroScene";
import { CountUp, Headline, Rise } from "@/features/home/reveal";

const STEPS = [
  { icon: FileText, title: "Same script, several deliveries", body: "A recording is compared with good deliveries of the same text, not with fixed rules." },
  { icon: AudioLines, title: "Compared word by word", body: "Pace, pauses, pitch, energy and articulation are measured on every word, against the references' own variation." },
  { icon: Headphones, title: "Every finding can be heard", body: "Each one comes with the audio, the same words from a good delivery, and the measurement behind it." },
];

const fadeIn = (delay: number) => ({ initial: { opacity: 0, y: 14 }, animate: { opacity: 1, y: 0 }, transition: { delay, duration: 0.7, ease } });

/** The product's home. It opens on RhetorTrace analysing a real recording (the hero scene),
 *  then the library of recordings, how it reads a delivery, and why to trust it. */
export function Home() {
  const { data: index } = useIndex();
  const [runs] = useState(() => recentRuns().slice(0, 4));
  const demo = index?.takes.find((t) => t.kind === "demo") ?? null;
  const { data: take } = useTake(demo?.id);
  const opening = demo && index ? index.takes.filter((t) => t.speech_id === demo.speech_id)[0]?.opening.replace(/\s*\.\.\.$/, "…") : null;
  const o = index?.validation?.detection.overall;
  const controls = index?.validation?.controls;

  return (
    <div className="h-full overflow-x-hidden overflow-y-auto scrollbar-thin">
      {/* ------------------------------------------------------------ the opening scene */}
      <section className="relative isolate overflow-hidden pb-6">
        <Ambient />
        <div className="page">
          <HeroScene demo={demo} take={take ?? null} opening={opening ?? null}>
            <HeroCopy demo={demo} />
          </HeroScene>
          <motion.p {...fadeIn(2.6)} className="mt-1 text-center text-[12px] text-faint">
            A real recording, analysed: each finding appears where the delivery strays from good deliveries of the same speech.
          </motion.p>
        </div>
      </section>

      <div className="page pb-28">
        {/* ------------------------------------------------------------ the library */}
        <section aria-labelledby="library" className="mt-14">
          <Rise className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="label-caps text-faint">Library</div>
              <h2 id="library" className="mt-2 font-display text-display-m">Recordings</h2>
              <p className="mt-1 text-[13.5px] text-muted-foreground">
                {runs.length ? "Your recent analyses, and the controlled examples." : "The controlled examples: clean deliveries, and demos with flaws injected on purpose."}
              </p>
            </div>
            <div className="flex items-center gap-4 text-[13px]">
              {runs.length > 0 && <Link to={recordingsPath} className="text-muted-foreground transition-colors hover:text-ink">All your recordings →</Link>}
              <Link to={examplesPath} className="text-muted-foreground transition-colors hover:text-ink">About the examples →</Link>
            </div>
          </Rise>
          {runs.length > 0 && (
            <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {runs.map((r, i) => <RunCard key={r.run_id} r={r} i={i} />)}
            </ul>
          )}
          <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {(index?.takes ?? []).filter((t) => t.kind !== "user").map((t, i) => <RecordingCard key={t.id} t={t} i={i} />)}
          </ul>
        </section>

        {/* ------------------------------------------------------------ how it reads a delivery */}
        <section aria-labelledby="how" className="mt-24">
          <Rise>
            <div className="label-caps text-faint">Method</div>
            <h2 id="how" className="mt-2 font-display text-display-m">How it reads a delivery</h2>
          </Rise>
          <div className="relative mt-8">
            {/* the thread joining the three steps, drawn as it comes into view */}
            <motion.span aria-hidden className="absolute top-[22px] left-[22px] hidden h-px origin-left bg-signal/70 sm:block" style={{ width: "calc(100% - 44px)" }}
              initial={{ scaleX: 0 }} whileInView={{ scaleX: 1 }} viewport={{ once: true }} transition={{ delay: 0.2, duration: 1.4, ease }} />
            <ol className="relative grid grid-cols-1 gap-6 sm:grid-cols-3">
              {STEPS.map((s, i) => (
                <Rise as="li" key={s.title} delay={0.15 + i * 0.12}>
                  <span className="relative grid size-11 place-items-center rounded-full border border-hairline bg-surface shadow-[0_0_0_6px_var(--paper)]">
                    <s.icon className="size-[18px] text-ink" strokeWidth={1.75} />
                    <span className="absolute -top-1 -right-1 grid size-[18px] place-items-center rounded-full bg-signal font-mono text-[10px] font-semibold text-[var(--on-highlight)]">
                      {i + 1}
                    </span>
                  </span>
                  <div className="mt-4 text-[16px] font-medium">{s.title}</div>
                  <p className="mt-1.5 max-w-sm text-[14px] leading-relaxed text-muted-foreground">{s.body}</p>
                </Rise>
              ))}
            </ol>
          </div>
        </section>

        {/* ------------------------------------------------------------ why trust it */}
        {o && controls && (
          <section aria-labelledby="trust" className="mt-24">
            <Rise className="grid-page gap-y-8">
              <div className="col-span-full lg:col-span-4">
                <div className="label-caps text-faint">Evidence</div>
                <h2 id="trust" className="mt-2 font-display text-display-m">Can you trust it?</h2>
                <p className="mt-2 max-w-sm text-[14px] leading-relaxed text-muted-foreground">
                  Tested on flaws injected on purpose and on clean deliveries. The full reports are in the Lab.
                </p>
                <nav aria-label="Lab" className="mt-5 flex max-w-sm flex-col text-[13.5px]">
                  {[
                    { to: examplesPath, label: "Controlled examples" },
                    { to: evaluationPath, label: "Performance report" },
                    { to: robustnessPath, label: "Robustness to audio quality" },
                    { to: methodPath, label: "How it works" },
                  ].map((l) => (
                    <Link key={l.to} to={l.to} className="group flex items-center justify-between border-b border-hairline py-2.5 transition-colors hover:text-ink">
                      <span className="text-ink/80 group-hover:text-ink">{l.label}</span>
                      <ArrowRight className="size-3.5 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-ink" />
                    </Link>
                  ))}
                </nav>
              </div>
              <div className="col-span-full grid grid-cols-1 content-center gap-4 sm:grid-cols-3 lg:col-span-8">
                <Stat value={pct(o.recall)} label="of injected flaws are found" detail={`${o.tp} of ${o.tp + o.fn} injections`} />
                <Stat value={pct(o.precision)} label="of findings point at a real flaw" detail={`${o.tp} of ${o.tp + o.fp} findings`} />
                <Stat value={fmt(controls.tracks_per_min, 1)} label="false alarms per minute on clean recordings"
                  detail={`over ${controls.per_take.length} clean recordings`} />
              </div>
            </Rise>
          </section>
        )}

        {/* ------------------------------------------------------------ the way in, again */}
        <Rise className="studio-panel relative mt-24 overflow-hidden rounded-3xl px-6 py-12 text-center sm:px-12">
          <span aria-hidden className="pointer-events-none absolute -top-40 left-1/2 size-[440px] -translate-x-1/2 rounded-full blur-3xl"
            style={{ background: "radial-gradient(circle, color-mix(in oklab, var(--signal) 16%, transparent), transparent 70%)" }} />
          <h2 className="relative font-display text-display-l">Hear where your delivery drifts.</h2>
          <p className="relative mx-auto mt-3 max-w-lg text-[15px] text-muted-foreground">
            Upload a recording, its text, and two or more good deliveries of the same text. RhetorTrace does the rest.
          </p>
          <Link to={analyzePath}
            className="relative mt-7 inline-flex h-12 items-center gap-2.5 rounded-full bg-signal pr-5 pl-6 text-[15px] font-medium text-[var(--on-highlight)] shadow-[0_10px_30px_-10px_color-mix(in_oklab,var(--signal)_60%,transparent)] transition-transform hover:scale-[1.03]">
            Analyse a recording <ArrowRight className="size-4" />
          </Link>
        </Rise>
      </div>
    </div>
  );
}

/** The hero's words: eyebrow, the headline writing itself in, and the ways in. */
function HeroCopy({ demo }: { demo: TakeSummary | null }) {
  return (
    <>
      <motion.div {...fadeIn(0)} className="inline-flex items-center gap-2 rounded-full border border-hairline bg-surface/60 px-3 py-1 text-[12px] text-muted-foreground backdrop-blur">
        <span className="relative flex size-2">
          <span className="absolute inset-0 animate-ping rounded-full bg-signal opacity-60" />
          <span className="relative size-2 rounded-full bg-signal" />
        </span>
        Speech delivery analysis · evidence you can hear
      </motion.div>
      <Headline className="mt-6 font-display text-display-xl"
        parts={[{ text: "Find the exact moments a speech " }, { text: "went off", mark: true }, { text: ", and hear why." }]} />
      <motion.p {...fadeIn(1.0)} className="mt-6 max-w-xl text-[17px] leading-relaxed text-muted-foreground">
        RhetorTrace listens to a delivery, compares it word by word with good deliveries of the same script, and points to where the
        pacing, pauses, pitch or energy drifted, with the evidence for each.
      </motion.p>
      <motion.div {...fadeIn(1.15)} className="mt-9 flex flex-wrap items-center gap-3">
        <Link to={analyzePath}
          className="group inline-flex h-12 items-center gap-2.5 rounded-full bg-primary pr-5 pl-6 text-[15px] font-medium text-primary-foreground shadow-[0_10px_30px_-12px_color-mix(in_oklab,var(--primary)_70%,transparent)] transition-transform hover:scale-[1.02] active:scale-[0.99]">
          Analyse a recording
          <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
        </Link>
        <Link to={demo ? overviewPath(demo.id) : examplesPath}
          className="inline-flex h-12 items-center gap-2 rounded-full border border-hairline bg-surface/60 px-5 text-[14.5px] font-medium backdrop-blur transition-colors hover:border-ink/25">
          See it on an example
        </Link>
      </motion.div>
    </>
  );
}

/** Slow, faint light behind the hero: two soft glows drifting. Atmosphere only; it carries no data,
 *  so it stays very quiet. */
function Ambient() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <div className="ambient-a absolute -top-40 -left-40 size-[620px] rounded-full blur-3xl"
        style={{ background: "radial-gradient(circle, color-mix(in oklab, var(--signal) 11%, transparent), transparent 65%)" }} />
      <div className="ambient-b absolute top-10 -right-48 size-[680px] rounded-full blur-3xl"
        style={{ background: "radial-gradient(circle, color-mix(in oklab, var(--cat-pitch) 12%, transparent), transparent 65%)" }} />
      <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-b from-transparent to-[var(--paper)]" />
    </div>
  );
}

function Stat({ value, label, detail }: { value: string; label: string; detail: string }) {
  return (
    <div className="h-fit rounded-2xl border border-hairline bg-surface p-5">
      <CountUp value={value} className="block font-display text-[clamp(40px,3.6vw,56px)] leading-none font-[380] tracking-tight tabular" />
      <div className="mt-3 text-[13.5px] leading-snug text-ink/85">{label}</div>
      <div className="mt-3 border-t border-hairline pt-2.5 font-mono text-[11.5px] text-faint">{detail}</div>
    </div>
  );
}

/** One recording in the library: what it is, where its findings fall, its score. */
function RecordingCard({ t, i }: { t: TakeSummary; i: number }) {
  return (
    <Rise as="li" delay={0.06 * i}>
      <Link to={overviewPath(t.id)}
        className="group flex h-full flex-col rounded-2xl border border-hairline bg-surface p-5 transition-[box-shadow,border-color,transform] duration-300 hover:-translate-y-1 hover:border-transparent hover:shadow-float">
        <div className="label-caps text-faint">{speechName(t.speech_id)} · {takeKindLabel(t.kind)}</div>
        <div className="mt-1.5 text-[15px] font-medium">{takeName(t)}</div>
        <p className="mt-1 line-clamp-2 font-display text-[15.5px] leading-snug text-ink/65">“{t.opening.replace(/\s*\.\.\.$/, "…")}”</p>
        <motion.div className="mt-auto pt-4" initial={{ clipPath: "inset(0 100% 0 0)" }} whileInView={{ clipPath: "inset(0 0% 0 0)" }}
          viewport={{ once: true }} transition={{ delay: 0.3 + 0.06 * i, duration: 0.9, ease }}>
          <TakeMarks take={t} className="h-3" />
        </motion.div>
        <div className="mt-4 flex items-end justify-between gap-3">
          <span className="font-mono text-[24px] leading-none font-medium tabular">
            {fmt(t.score, 1)}<span className="text-[12px] font-normal text-faint"> / 100</span>
          </span>
          <span className="text-[12.5px] text-muted-foreground">{t.n_flaws ? `${t.n_flaws} finding${t.n_flaws === 1 ? "" : "s"}` : "no findings"}</span>
        </div>
      </Link>
    </Rise>
  );
}

function RunCard({ r, i }: { r: RecentRun; i: number }) {
  return (
    <Rise as="li" delay={0.06 * i}>
      <Link to={runPath(r.run_id)}
        className="group flex h-full flex-col rounded-2xl border border-hairline bg-surface p-5 transition-[box-shadow,border-color,transform] duration-300 hover:-translate-y-1 hover:border-transparent hover:shadow-float">
        <div className="label-caps text-faint">Your analysis</div>
        <div className="mt-1.5 truncate font-display text-[20px] leading-tight">{r.name}</div>
        <div className="mt-1 text-[12.5px] text-muted-foreground">{new Date(r.submitted_at).toLocaleString()}</div>
        <span className="mt-auto inline-flex items-center gap-1.5 pt-6 text-[13px] font-medium">
          Open <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
        </span>
      </Link>
    </Rise>
  );
}
