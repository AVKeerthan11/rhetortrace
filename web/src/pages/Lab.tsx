import { Link } from "react-router-dom";
import { motion } from "motion/react";
import { ArrowRight, BookOpen, FlaskConical, ShieldCheck } from "lucide-react";
import { useIndex } from "@/lib/data";
import { fmt } from "@/lib/format";
import { rise } from "@/lib/motion";
import { evaluationPath, examplesPath, groupBySpeech, methodPath, overviewPath, robustnessPath, speechName } from "@/lib/takes";
import { pct } from "@/lib/validation";
import { LabTabs } from "@/components/LabTabs";
import { PageHeader } from "@/components/Page";
import { PageState } from "@/components/PageState";
import { TakeMarks } from "@/components/TakeMarks";

/** The Lab: how RhetorTrace is tested. Controlled examples to try, and the validation reports. */
export function Lab() {
  const { data: index, error } = useIndex();
  if (error) return <PageState title="Could not load the Lab" detail={error} />;
  const groups = index ? groupBySpeech(index.takes) : [];
  const o = index?.validation.detection.overall;
  const controls = index?.validation.controls;
  const conditions = index ? Object.keys(index.validation.robustness).length : null;

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="page pt-10 pb-28 lg:pt-12">
        <div className="max-w-3xl">
          <PageHeader eyebrow="Lab" title="How RhetorTrace is tested">
            <p>
              There are no real recordings with known mistakes yet, so RhetorTrace is tested on mistakes put there on purpose, and
              on clean deliveries that should raise few findings. Everything here is the actual evaluation data.
            </p>
          </PageHeader>
        </div>
        <LabTabs />

        <div className="mt-10 grid-page gap-y-6">
          <motion.div {...rise(3)} className="col-span-full lg:col-span-7">
            <Card to={examplesPath} title="Controlled examples" icon={FlaskConical}
              body="Recordings with flaws injected into the audio, each with its answer key, and the clean deliveries they are compared with.">
              <div className="mt-5 space-y-4">
                {!index && <div className="shimmer h-16 rounded-xl" />}
                {groups.map((g) => {
                  const demo = g.takes.find((t) => t.kind === "demo");
                  if (!demo) return null;
                  return (
                    <Link key={g.speech} to={overviewPath(demo.id)} onClick={(e) => e.stopPropagation()}
                      className="group/row block rounded-xl border border-hairline bg-paper/60 p-3.5 transition-colors hover:border-ink/20">
                      <div className="flex items-baseline gap-3">
                        <span className="text-[11px] font-medium tracking-[0.12em] text-faint uppercase">{speechName(g.speech)}</span>
                        <span className="min-w-0 flex-1 truncate font-display text-[18px]">“{g.opening}”</span>
                        <span className="shrink-0 text-[12px] text-muted-foreground">
                          {demo.ground_truth ? `${demo.ground_truth[0]} of ${demo.ground_truth[1]} found` : `${demo.n_flaws} findings`}
                        </span>
                      </div>
                      <TakeMarks take={demo} className="mt-2.5 h-2" />
                    </Link>
                  );
                })}
              </div>
            </Card>
          </motion.div>

          <motion.div {...rise(4)} className="col-span-full lg:col-span-5">
            <Card to={evaluationPath} title="Performance" icon={FlaskConical}
              body="How many injected flaws are found, how many findings are real, and how often clean recordings raise a false alarm.">
              {o && controls && (
                <dl className="mt-5 grid grid-cols-3 gap-4 border-t border-hairline pt-4">
                  <Num value={pct(o.recall)} label="of injected flaws found" />
                  <Num value={pct(o.precision)} label="of findings are real" />
                  <Num value={fmt(controls.tracks_per_min, 1)} label="false alarms per minute" />
                </dl>
              )}
            </Card>
          </motion.div>

          <motion.div {...rise(5)} className="col-span-full lg:col-span-6">
            <Card to={robustnessPath} title="Robustness" icon={ShieldCheck}
              body={`The clean recordings degraded${conditions ? ` in ${conditions} ways` : ""} (louder, quieter, compressed, resampled, noisy) and analysed again: are real flaws still found, and how many new false alarms appear?`} />
          </motion.div>
          <motion.div {...rise(6)} className="col-span-full lg:col-span-6">
            <Card to={methodPath} title="Method" icon={BookOpen}
              body="From word timing to severity: every step of the analysis, what each aspect of delivery is measured from, and its limits." />
          </motion.div>
        </div>
      </div>
    </div>
  );
}

function Card({ to, title, body, icon: Icon, children }: {
  to: string; title: string; body: string; icon: React.ComponentType<{ className?: string; strokeWidth?: number }>; children?: React.ReactNode;
}) {
  return (
    <div className="group relative h-full rounded-2xl border border-hairline bg-surface p-5 transition-[box-shadow,border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-transparent hover:shadow-float">
      <Link to={to} className="flex items-center gap-2 text-[15px] font-medium after:absolute after:inset-0 after:rounded-2xl">
        <Icon className="size-4 text-ink/60" strokeWidth={1.75} />
        {title}
        <ArrowRight className="ml-auto size-4 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-ink" />
      </Link>
      <p className="mt-1.5 max-w-xl text-[13.5px] leading-relaxed text-muted-foreground">{body}</p>
      {/* above the card-wide link, so nested links stay clickable */}
      <div className="relative z-10">{children}</div>
    </div>
  );
}

function Num({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <dt className="sr-only">{label}</dt>
      <dd className="font-display text-[34px] leading-none tabular">{value}</dd>
      <dd className="mt-1.5 text-[12px] leading-snug text-muted-foreground">{label}</dd>
    </div>
  );
}
