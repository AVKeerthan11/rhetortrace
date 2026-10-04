import { Link } from "react-router-dom";
import { motion } from "motion/react";
import { ArrowRight } from "lucide-react";
import { useIndex } from "@/lib/data";
import { fmtShort } from "@/lib/format";
import { rise } from "@/lib/motion";
import { groupBySpeech, overviewPath, speechName } from "@/lib/takes";
import type { TakeSummary } from "@/lib/types";
import { LabTabs } from "@/components/LabTabs";
import { PageHeader } from "@/components/Page";
import { PageState } from "@/components/PageState";
import { TakeMarks } from "@/components/TakeMarks";

/** Lab › Examples: the controlled demo recordings (flaws injected on purpose, with an answer
 *  key) and, beside each, the clean deliveries of the same script it is compared with. */
export function Examples() {
  const { data: index, error } = useIndex();
  if (error) return <PageState title="Could not load the examples" detail={error} />;
  const groups = index ? groupBySpeech(index.takes) : [];

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="page pt-10 pb-28 lg:pt-12">
        <div className="max-w-3xl">
          <PageHeader eyebrow="Lab · examples" title="Controlled examples">
            <p>
              Flaws were injected into these recordings on purpose, so you can check what RhetorTrace finds against an answer key.
              Beside each one are the clean deliveries of the same script: the references it is compared with, and recordings that
              should raise few findings.
            </p>
          </PageHeader>
        </div>
        <LabTabs />

        <div className="mt-10 space-y-12">
          {!index && [0, 1].map((i) => <div key={i} className="shimmer h-[160px] rounded-2xl" />)}
          {groups.map((g, i) => {
            const demo = g.takes.find((t) => t.kind === "demo");
            const clean = g.takes.filter((t) => t.kind === "control");
            return (
              <motion.section key={g.speech} {...rise(3 + i)} className="grid-page gap-y-4" aria-label={speechName(g.speech)}>
                <div className="col-span-full lg:col-span-7">
                  {demo && <DemoCard take={demo} opening={g.opening} primary={i === 0} />}
                </div>
                {clean.length > 0 && (
                  <div className="col-span-full lg:col-span-5">
                    <CleanList speech={g.speech} takes={clean} />
                  </div>
                )}
              </motion.section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function DemoCard({ take, opening, primary }: { take: TakeSummary; opening: string; primary: boolean }) {
  return (
    <Link
      to={overviewPath(take.id)}
      className="group flex h-full flex-col rounded-2xl border border-hairline bg-surface p-5 shadow-[0_1px_0_color-mix(in_oklab,var(--shadow)_4%,transparent)] transition-[box-shadow,border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-transparent hover:shadow-float"
    >
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium tracking-[0.12em] text-faint uppercase">
            {speechName(take.speech_id)} · demo · {fmtShort(take.duration)}
          </div>
          <div className="mt-1 font-display text-[25px] leading-tight">“{opening}”</div>
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
      <div className="mt-auto pt-4">
        <TakeMarks take={take} className="h-2" />
      </div>
    </Link>
  );
}

/** The clean deliveries of one script. */
function CleanList({ speech, takes }: { speech: string; takes: TakeSummary[] }) {
  return (
    <div className="h-full rounded-2xl border border-hairline bg-surface/60">
      <div className="px-4 pt-3 pb-1 text-[10.5px] font-medium tracking-[0.12em] text-faint uppercase">
        Clean deliveries of {speechName(speech)} · the references
      </div>
      <div className="divide-y divide-hairline">
        {takes.map((t) => (
          <Link key={t.id} to={overviewPath(t.id)} className="group flex items-center gap-4 px-4 py-3 transition-colors hover:bg-hover">
            <span className="w-[128px] shrink-0 text-[13.5px]">Clean recording {t.take_id.split("_")[1]}</span>
            <TakeMarks take={t} className="h-2 flex-1" />
            <span className="w-[76px] shrink-0 text-right text-[12.5px] text-muted-foreground">
              {t.n_flaws} finding{t.n_flaws === 1 ? "" : "s"}
            </span>
            <ArrowRight className="size-4 shrink-0 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-ink" />
          </Link>
        ))}
      </div>
    </div>
  );
}
