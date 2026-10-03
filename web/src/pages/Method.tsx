import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { CATEGORIES, CATEGORY, SEVERITY_STYLE, capitalize } from "@/lib/categories";
import { useIndex, useTake } from "@/lib/data";
import { CATEGORY_MEANING } from "@/lib/findings";
import { fmt, fmtShort } from "@/lib/format";
import { rise } from "@/lib/motion";
import { motion } from "motion/react";
import { evaluationPath, groupBySpeech, overviewPath, robustnessPath, speechName } from "@/lib/takes";
import type { Category, Take, TakeSummary } from "@/lib/types";
import { KIND, kindLabel, pct } from "@/lib/validation";
import { cn } from "@/lib/utils";
import { TakeMarks } from "@/components/TakeMarks";
import { Note, PageHeader, ReadingPage, Section, Table, Td, Th } from "@/components/Page";
import { PageState } from "@/components/PageState";
import { ReadingSkeleton } from "./Evaluation";

/** What each aspect is measured from (per word; see src/features and src/baseline.py). */
const MEASURED: Record<Category, string> = {
  pacing: "local speaking rate around the word, and the word's own length",
  pause: "the silence between the word and the next one",
  pitch: "the word's pitch relative to the speaker's usual level, and how much the pitch moves across the surrounding words",
  energy: "loudness relative to the speaker's typical level",
  clarity: "the spectral shape of the word (brightness and timbre)",
};

const SCORE_KEY: Record<Category, string> = { pacing: "pacing", pitch: "pitch", pause: "pauses", energy: "energy", clarity: "clarity" };

export function Method() {
  const { data: index, error } = useIndex();
  const demoId = index?.takes.find((t) => t.kind === "demo")?.id ?? index?.takes[0]?.id;
  const { data: take } = useTake(demoId);
  if (error) return <PageState title="Could not load the project data" detail={error} />;
  if (!index || !take) return <ReadingSkeleton />;
  const v = index.validation;
  const groups = groupBySpeech(index.takes);
  const nClean = index.takes.filter((t) => t.kind === "control").length;
  const lib = v.metadata.libraries;

  const steps: { title: string; body: React.ReactNode }[] = [
    {
      title: "Put every word in time",
      body: (
        <>
          The known script is force-aligned to the audio{lib.whisperx ? <> with WhisperX {lib.whisperx}</> : null}, so every word gets a
          start and end time. Words the aligner is unsure of are kept in the transcript but left out of the evidence.
        </>
      ),
    },
    {
      title: "Measure every word",
      body: (
        <>
          Five aspects of delivery are measured on each word, with Praat{lib["praat-parselmouth"] ? ` (parselmouth ${lib["praat-parselmouth"]})` : ""}{" "}
          and librosa{lib.librosa ? ` ${lib.librosa}` : ""}:
          <ul className="mt-2 space-y-1">
            {CATEGORIES.map((c) => (
              <li key={c} className="flex gap-2">
                <span className="mt-[7px] size-2 shrink-0 rounded-full" style={{ background: CATEGORY[c].color }} />
                <span><span className="text-ink">{CATEGORY[c].label}</span>: {MEASURED[c]}.</span>
              </li>
            ))}
          </ul>
        </>
      ),
    },
    {
      title: "Compare with good deliveries of the same words",
      body: (
        <>
          For every word of the script, the clean deliveries give a reference value (their median) and a usual spread (a robust
          measure of how much good speakers differ there). Each measurement becomes a distance from the reference in units of that
          spread, written σ. A clean recording is never compared with itself, only with the other clean deliveries.
        </>
      ),
    },
    {
      title: "Find the stretches that stand out",
      body: (
        <>
          The distances are smoothed over neighbouring words, so one odd word does not raise a finding. A stretch opens where an
          aspect is at least {fmt(take.detection_settings.z_open, 1)}σ from the references and continues while it stays above{" "}
          {fmt(take.detection_settings.z_close, 1)}σ. Its edges are then adjusted to the words that carry the evidence.
        </>
      ),
    },
    {
      title: "Rate how serious each one is",
      body: (
        <>
          Severity is a 0–1 score from the strength of the evidence and how many words support it: evidence at{" "}
          {fmt(take.severity_settings.z_min, 0)}σ or below scores 0, at {fmt(take.severity_settings.z_max.default, 0)}σ or above
          scores 1{take.severity_settings.z_max["pitch/flatter"] ? <> ({fmt(take.severity_settings.z_max["pitch/flatter"], 0)}σ for flat pitch)</> : null}. The score is cut into the five labels shown below. Findings are numbered by this score, most serious first.
        </>
      ),
    },
    {
      title: "Explain it, and summarise the recording",
      body: (
        <>
          Each finding's explanation is built from its strongest measurement, compared with the reference deliveries. The coaching
          tip is fixed text for that kind of finding. The delivery score starts each aspect at 100 and subtracts{" "}
          {fmt(100 / take.score.settings.flaws_to_zero, 0)} points per unit of severity, then weights the aspects. It is a summary
          only; the findings are what to act on. Nothing is generated by a language model: the same audio always gives the same result.
        </>
      ),
    },
  ];

  return (
    <ReadingPage>
      <PageHeader eyebrow="Method" title="How RhetorTrace works">
        <p>
          There is no single right speed or pitch for a speech. So instead of fixed rules, RhetorTrace compares a delivery with good
          deliveries of the <em>same script</em>, word by word, and points to the stretches where it differs from all of them by
          more than good speakers differ from each other.
        </p>
      </PageHeader>

      <Section title="From audio to findings">
        <ol className="relative">
          {steps.map((s, i) => (
            <motion.li key={s.title} {...rise(3 + i * 0.6)} className="relative flex gap-5 pb-8 last:pb-0">
              {i < steps.length - 1 && <span className="absolute top-8 bottom-1 left-[13px] w-px bg-hairline" />}
              <span className="grid size-7 shrink-0 place-items-center rounded-full border border-ink/20 bg-surface font-mono text-[12px] text-ink/80">{i + 1}</span>
              <div className="min-w-0 pt-0.5">
                <h3 className="text-[16px] font-medium">{s.title}</h3>
                <div className="mt-1.5 text-[14.5px] leading-relaxed text-muted-foreground">{s.body}</div>
              </div>
            </motion.li>
          ))}
        </ol>
      </Section>

      <Section title="Reading a finding">
        <dl className="space-y-5 text-[14.5px] leading-relaxed">
          <Term t="Severity">
            <span className="mt-1 flex flex-wrap gap-2">
              {take.severity_settings.labels.map((l, i) => {
                const th = take.severity_settings.level_thresholds;
                const range = i === 0 ? `below ${th[0]}` : i === th.length ? `${th[i - 1]} and up` : `${th[i - 1]}–${th[i]}`;
                return (
                  <span key={l} className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
                    <span className={cn("inline-flex h-[19px] items-center rounded-[5px] border px-1.5 text-[11px] font-medium", SEVERITY_STYLE[i].badge)}>{capitalize(l)}</span>
                    <span className="font-mono text-[11.5px]">{range}</span>
                  </span>
                );
              })}
            </span>
          </Term>
          <Term t="σ (distance from the references)">
            How far a measurement is from the reference value, in units of the usual difference between good speakers at that word.
            1σ is an ordinary difference; findings start at {fmt(take.detection_settings.z_open, 0)}σ.
          </Term>
          <Term t="Usual range">The shaded band in the evidence and the timeline: where the reference deliveries fall.</Term>
          <Term t="Confidence">
            How much of the finding could be measured reliably: words the aligner was unsure of, or where no pitch could be found, lower it.
          </Term>
          <Term t="Delivery score">
            Weighted sum of the five aspects:{" "}
            {CATEGORIES.map((c) => `${CATEGORY[c].label.toLowerCase()} ${pct(take.score.settings.weights[SCORE_KEY[c]] ?? 0)}`).join(", ")}.
          </Term>
        </dl>
      </Section>

      <Section title="The recordings" lead={
        <>
          {groups.length} speech scripts, each with {[...new Set(groups.map((g) => g.takes.filter((t) => t.kind === "control").length))].join(" or ")}{" "}
          clean deliveries ({nClean} in total) and a demo recording. The clean deliveries are both the references and the test for
          false alarms.
        </>
      }>
        <Table>
          <thead><tr><Th>Recording</Th><Th>Findings along the recording</Th><Th right>Length</Th><Th right>Findings</Th></tr></thead>
          <tbody>
            {groups.flatMap((g) => g.takes.map((t) => <RecordingRow key={t.id} t={t} />))}
          </tbody>
        </Table>
      </Section>

      <Section title="How the demo recordings were made" lead={
        <>
          Each demo starts from one clean delivery. {take.edits?.length ?? "Several"} places were edited in the audio with Praat, and
          the edited recording was then analysed like any other, from word alignment onwards, against the clean deliveries it was
          not made from.
        </>
      }>
        <DemoEdits take={take} />
        <Note>The exact edited words and times are listed on each demo recording's summary, under “What was injected”.</Note>
      </Section>

      <Section title="Limits" lead="What these results do and do not show.">
        <ul className="space-y-2.5 text-[14.5px] leading-relaxed text-ink/80">
          <li>The flaws are injected, not real mistakes. Real delivery problems are subtler and mixed; how RhetorTrace does on them is not measured yet.</li>
          <li>
            Each script has only {groups[0]?.takes.filter((t) => t.kind === "control").length ?? 3} clean deliveries, so a clean
            recording is judged against two. One unusual reference shifts what counts as normal.
          </li>
          <li>
            Clarity was never tested with injected flaws, and it raises most of the false alarms on degraded audio. Treat clarity
            findings with care.
          </li>
          <li>Heavy background noise breaks the word timing, and with it the findings.</li>
        </ul>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link to={evaluationPath} className="group inline-flex h-11 items-center gap-2 rounded-full bg-ink pr-5 pl-6 text-[14px] font-medium text-primary-foreground transition-transform hover:scale-[1.02]">
            See how often it is right <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
          </Link>
          <Link to={robustnessPath} className="group inline-flex h-11 items-center gap-2 rounded-full border border-hairline bg-surface pr-5 pl-6 text-[14px] font-medium transition-colors hover:border-ink/25">
            Robustness to audio quality <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
          </Link>
        </div>
      </Section>
    </ReadingPage>
  );
}

function Term({ t, children }: { t: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="font-medium">{t}</dt>
      <dd className="mt-0.5 text-muted-foreground">{children}</dd>
    </div>
  );
}

function RecordingRow({ t }: { t: TakeSummary }) {
  return (
    <tr className="group">
      <Td className="w-[240px]">
        <Link to={overviewPath(t.id)} className="underline decoration-ink/20 underline-offset-[3px] transition-colors group-hover:decoration-ink">
          {speechName(t.speech_id)} · {t.kind === "demo" ? "demo" : `clean ${t.take_id.split("_")[1]}`}
        </Link>
        {t.kind === "demo" && <span className="block text-[12px] text-muted-foreground">made from clean {t.source_take?.split("_")[1]}</span>}
      </Td>
      <Td><TakeMarks take={t} className="h-2" /></Td>
      <Td right mono muted>{fmtShort(t.duration)}</Td>
      <Td right mono>{t.n_flaws}</Td>
    </tr>
  );
}

function describeEdit(kind: string, params: Record<string, unknown>): string {
  if (typeof params.factor === "number") return `played ${params.factor < 1 ? "faster" : "slower"}: time-scaled to ${params.factor}× its length, pitch unchanged`;
  if (typeof params.inserted_s === "number") return `${fmt(params.inserted_s, 1)} s of the recording's own background silence inserted where there was no pause`;
  if (kind === "monotone") return "pitch replaced by a flat line at the phrase's own median, length unchanged";
  return Object.entries(params).map(([k, x]) => `${k} ${String(x)}`).join(", ");
}

function DemoEdits({ take }: { take: Take }) {
  if (!take.edits) return null;
  return (
    <ul className="space-y-3">
      {take.edits.map((e) => {
        const c = KIND[e.kind]?.category;
        return (
          <li key={e.kind} className="flex gap-3 text-[14.5px] leading-relaxed">
            {c && <span className="mt-[9px] size-2 shrink-0 rounded-full" style={{ background: CATEGORY[c].color }} />}
            <span>
              <span className="font-medium">{kindLabel(e.kind)}</span>
              <span className="text-muted-foreground">: {describeEdit(e.kind, e.params)}.{c && <> Tests {CATEGORY_MEANING[c]}.</>}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
