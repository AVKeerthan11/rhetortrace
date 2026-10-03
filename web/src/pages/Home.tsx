import { Link } from "react-router-dom";
import { motion } from "motion/react";
import { ArrowRight, AudioLines, BookOpen, FileText, FlaskConical, Headphones, ShieldCheck } from "lucide-react";
import { useIndex } from "@/lib/data";
import { fmtShort } from "@/lib/format";
import { ease } from "@/lib/motion";
import { evaluationPath, groupBySpeech, methodPath, overviewPath, robustnessPath, speechName } from "@/lib/takes";
import type { TakeSummary } from "@/lib/types";
import { pct } from "@/lib/validation";
import { PageState } from "@/components/PageState";
import { TakeMarks } from "@/components/TakeMarks";

const STEPS = [
  { icon: FileText, title: "Same script, several deliveries", body: "A recording is compared with clean deliveries of the same text." },
  { icon: AudioLines, title: "Compared word by word", body: "Pace, pauses, pitch, energy and articulation are measured on every word." },
  { icon: Headphones, title: "Every finding can be heard", body: "Each one comes with the audio, the reference delivery and the measurement." },
];

const rise = (i: number) => ({ initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0 }, transition: { delay: 0.06 * i, duration: 0.45, ease } });

export function Home() {
  const { data: index, error } = useIndex();
  if (error) return <PageState title="Could not load the analyses" detail={error} />;
  const groups = index ? groupBySpeech(index.takes) : [];
  const overall = index?.validation.detection.overall;

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-3xl px-8 pt-16 pb-24">
        <motion.h1 {...rise(0)} className="font-display text-[54px] leading-[1.02] tracking-[-0.015em]">
          Find the exact moments a speech <span className="marker px-1 whitespace-nowrap italic">went off</span>, and hear why.
        </motion.h1>
        <motion.p {...rise(1)} className="mt-5 max-w-xl text-[16px] leading-relaxed text-muted-foreground">
          RhetorTrace listens to a delivery of a speech, compares it with good deliveries of the same script, and points to the
          words where the pacing, pauses, pitch or energy drifted, with the evidence for each.
        </motion.p>

        <motion.ol {...rise(2)} className="mt-10 grid grid-cols-3 gap-5">
          {STEPS.map((s, i) => (
            <li key={s.title} className="relative pl-0">
              <div className="flex items-center gap-2 text-[11px] font-medium tracking-[0.12em] text-faint uppercase">
                <span className="font-mono">0{i + 1}</span>
                <s.icon className="size-3.5" strokeWidth={1.75} />
              </div>
              <div className="mt-2 text-[14px] font-medium">{s.title}</div>
              <p className="mt-1 text-[13px] leading-snug text-muted-foreground">{s.body}</p>
            </li>
          ))}
        </motion.ol>

        <motion.section {...rise(3)} className="mt-14">
          <h2 className="text-[11px] font-medium tracking-[0.14em] text-faint uppercase">Try it on a demo recording</h2>
          <p className="mt-1 text-[13.5px] text-muted-foreground">
            Flaws were injected into these recordings on purpose, so you can check what RhetorTrace finds. Below each one are the
            clean deliveries of the same script it is compared with.
          </p>
          <div className="mt-4 space-y-8">
            {!index && [0, 1].map((i) => <div key={i} className="shimmer h-[118px] rounded-2xl" />)}
            {groups.map((g, i) => {
              const demo = g.takes.find((t) => t.kind === "demo");
              const clean = g.takes.filter((t) => t.kind === "control");
              return (
                <div key={g.speech}>
                  {demo && <DemoCard take={demo} opening={g.opening} primary={i === 0} />}
                  {clean.length > 0 && <CleanList speech={g.speech} takes={clean} attached={!!demo} />}
                </div>
              );
            })}
          </div>
        </motion.section>

        {index && overall && (
          <motion.section {...rise(4)} className="mt-14">
            <h2 className="text-[11px] font-medium tracking-[0.14em] text-faint uppercase">Can you trust it?</h2>
            <div className="mt-4 grid grid-cols-3 gap-3">
              <InfoCard to={evaluationPath} icon={FlaskConical} title="Performance"
                body={`Finds ${pct(overall.recall)} of injected flaws; ${pct(overall.precision)} of its findings are real.`} />
              <InfoCard to={robustnessPath} icon={ShieldCheck} title="Robustness" body="How compression, resampling and background noise change the results." />
              <InfoCard to={methodPath} icon={BookOpen} title="How it works" body="From word timing to severity: every step, and its limits." />
            </div>
          </motion.section>
        )}
      </div>
    </div>
  );
}

function DemoCard({ take, opening, primary }: { take: TakeSummary; opening: string; primary: boolean }) {
  return (
    <Link
      to={overviewPath(take.id)}
      className="group block rounded-2xl border border-hairline bg-surface p-5 shadow-[0_1px_0_rgba(27,26,23,0.04)] transition-[box-shadow,border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-transparent hover:shadow-float"
    >
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium tracking-[0.12em] text-faint uppercase">
            {speechName(take.speech_id)} · demo · {fmtShort(take.duration)}
          </div>
          <div className="mt-1 truncate font-display text-[25px] leading-tight">“{opening}”</div>
          <div className="mt-1 text-[13px] text-muted-foreground">
            {take.ground_truth ? `${take.ground_truth[1]} flaws injected, ${take.ground_truth[0]} found · ` : ""}
            {take.n_flaws} findings
          </div>
        </div>
        <span
          className={
            primary
              ? "inline-flex h-10 shrink-0 items-center gap-2 rounded-full bg-ink px-5 text-[13.5px] font-medium text-primary-foreground transition-transform group-hover:scale-[1.03]"
              : "inline-flex h-10 shrink-0 items-center gap-2 rounded-full border border-hairline px-5 text-[13.5px] font-medium transition-colors group-hover:border-ink/25"
          }
        >
          Open analysis <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
        </span>
      </div>
      <TakeMarks take={take} className="mt-4 h-2" />
    </Link>
  );
}

/** The clean deliveries of one script, hung under its demo card. */
function CleanList({ speech, takes, attached }: { speech: string; takes: TakeSummary[]; attached: boolean }) {
  return (
    <div className={attached ? "mx-4 rounded-b-xl border border-t-0 border-hairline bg-surface/60" : "rounded-xl border border-hairline bg-surface"}>
      <div className="px-4 pt-2.5 pb-1 text-[10.5px] font-medium tracking-[0.12em] text-faint uppercase">
        Clean deliveries of {speechName(speech)} · the references
      </div>
      <div className="divide-y divide-hairline">
        {takes.map((t) => (
          <Link key={t.id} to={overviewPath(t.id)} className="group flex items-center gap-4 px-4 py-2.5 transition-colors hover:bg-hover">
            <span className="w-[140px] text-[13.5px]">Clean recording {t.take_id.split("_")[1]}</span>
            <TakeMarks take={t} className="h-2 flex-1" />
            <span className="w-[86px] text-right text-[12.5px] text-muted-foreground">
              {t.n_flaws} finding{t.n_flaws === 1 ? "" : "s"}
            </span>
            <ArrowRight className="size-4 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-ink" />
          </Link>
        ))}
      </div>
    </div>
  );
}

function InfoCard({ to, icon: Icon, title, body }: { to: string; icon: React.ComponentType<{ className?: string; strokeWidth?: number }>; title: string; body: string }) {
  return (
    <Link to={to} className="group rounded-2xl border border-hairline bg-surface p-4 transition-[box-shadow,border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-transparent hover:shadow-float">
      <span className="flex items-center gap-2 text-[14px] font-medium">
        <Icon className="size-4 text-ink/60" strokeWidth={1.75} />
        {title}
        <ArrowRight className="ml-auto size-4 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-ink" />
      </span>
      <p className="mt-1.5 text-[13px] leading-snug text-muted-foreground">{body}</p>
    </Link>
  );
}
