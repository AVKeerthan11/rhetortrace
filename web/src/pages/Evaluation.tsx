import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { CATEGORIES, CATEGORY } from "@/lib/categories";
import { useIndex, useTake } from "@/lib/data";
import { plainTitle } from "@/lib/findings";
import { fmt } from "@/lib/format";
import { caseToId, overviewPath, speechName } from "@/lib/takes";
import type { Category, TakeSummary, Validation } from "@/lib/types";
import { KIND, kindLabel, pct, splitTrack } from "@/lib/validation";
import { AnswerKey } from "@/components/AnswerKey";
import { Disclosure } from "@/components/Disclosure";
import { EvaluationTabs } from "@/components/EvaluationTabs";
import { Note, PageHeader, ReadingPage, Section, Stat, Table, Td, Th } from "@/components/Page";
import { PageState } from "@/components/PageState";

export function Evaluation() {
  const { data: index, error } = useIndex();
  if (error) return <PageState title="Could not load the evaluation" detail={error} />;
  if (!index) return <ReadingSkeleton />;
  const v = index.validation;
  const o = v.detection.overall;
  const injected = o.tp + o.fn;
  const demos = index.takes.filter((t) => t.kind === "demo");

  return (
    <ReadingPage wide>
      <PageHeader eyebrow="Evaluation · performance" title="How often is RhetorTrace right?">
        <p>
          There are no real recordings with known mistakes yet, so RhetorTrace is tested on mistakes put there on purpose. Flaws
          were injected into the measurements of the six clean recordings (a phrase sped up, slowed down, made quieter or
          flattened, a pause inserted or removed): {injected} scorable injections in total. The clean recordings themselves show
          how often it raises a false alarm. Every recording is compared only with the <em>other</em> clean deliveries of its script.
        </p>
      </PageHeader>
      <EvaluationTabs />

      <section className="mt-10 grid grid-cols-3 gap-8">
        <Stat value={pct(o.recall)} label="of injected flaws are found" sub={`${o.tp} of ${injected}`} />
        <Stat value={pct(o.precision)} label="of findings point at a real flaw" sub={`${o.tp} of ${o.tp + o.fp} findings; the rest are false alarms or side effects`} />
        <Stat value={fmt(v.controls.tracks_per_min, 1)} label="false alarms per minute on clean recordings"
          sub={`${pct(v.controls.fp_word_rate, 1)} of their words fall inside one`} />
      </section>
      <Note>
        F1 (the balance of the first two) is {fmt(o.f1, 2)}. {Object.entries(v.detection.excluded).map(([k, n]) => `${n} ${k}`).join(" and ")} injections
        are left out of the count: unscorable means nothing could be measured at that spot; confounded means the clean recording
        already had a finding of the same kind there.
      </Note>

      <Section title="The two demo recordings" lead={
        <>
          The demo recordings go one step further: the edits were made to the audio itself, and the edited recording then went
          through the whole pipeline, from word alignment onwards. So you can listen to what was injected and to what was found.
        </>
      }>
        <div className="space-y-8">
          {demos.map((t) => <DemoKey key={t.id} summary={t} />)}
        </div>
      </Section>

      <Section title="By aspect of delivery" lead={
        <>
          Pacing finds {pct(v.detection.per_category.pacing.recall)} and pauses {pct(v.detection.per_category.pause.recall)} of their
          injected flaws. Pitch is the hardest: {pct(v.detection.per_category.pitch.recall)} of flattened phrases are found.
        </>
      }>
        <CategoryTable v={v} />
        <Note>
          Clarity has no injected test, so only its false alarms can be counted. “Side effect” counts findings that an injected
          edit caused next to itself, in a different aspect.
        </Note>
      </Section>

      <Section title="By kind of injected flaw" lead="How many were found, and how closely the finding lines up with the edited words in time.">
        <KindTable v={v} />
        <Note>
          Overlap is the share of time the finding and the edit have in common (1.0 = exactly the same words). Start and end
          offsets are how far the finding's edges are from the edit's, in seconds; “typical” is the mean, “worst 10%” the 90th
          percentile. Severity is the mean 0–1 score given at the standard injection strength.
        </Note>
      </Section>

      <Section title="False alarms on clean recordings" lead="Each clean recording, compared with the other two. Every finding here is either a false alarm or a genuine difference between good speakers.">
        <ControlsTable v={v} takes={index.takes} />
      </Section>

      <Section title="Does severity follow the size of the flaw?" lead={
        <>
          Each flaw was also injected at weaker and stronger settings. A useful severity score should rise with the strength. At{" "}
          {v.severity_pooled[0]} of {v.severity_pooled[1]} sites it never went down as the edit got stronger.
        </>
      }>
        <SeverityTable v={v} />
        <Note>Each cell: mean severity score (0–1) of the detected injections, in brackets how many were detected, below it the edit strength. ρ is the rank correlation between strength and score.</Note>
      </Section>

      <Section title="Does the choice of reference deliveries matter?" lead={
        <>
          With only three clean deliveries per script, each one carries weight. Scoring a clean recording against all three
          (including itself) hides false alarms; leaving it out, as everywhere above, is the honest test.
        </>
      }>
        <ReferenceTable v={v} takes={index.takes} />
        <Note>Each cell: compared with the other two deliveries (honest) · <span className="text-faint">compared with all three, including itself</span>.</Note>
        <Disclosure title="How much the reference values move when one delivery is left out" className="mt-6 border-b">
          <InfluenceTable v={v} />
        </Disclosure>
      </Section>

      <Section title="Reproducibility">
        <Reproducibility v={v} />
      </Section>

      <div className="mt-14 flex items-center justify-between border-t border-hairline pt-6">
        <Link to="/method" className="text-[13.5px] text-muted-foreground transition-colors hover:text-ink">How the analysis works</Link>
        <Link to="/evaluation/robustness"
          className="group inline-flex h-11 items-center gap-2 rounded-full bg-ink pr-5 pl-6 text-[14px] font-medium text-primary-foreground transition-transform hover:scale-[1.02]">
          Next: robustness to audio quality
          <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
        </Link>
      </div>
    </ReadingPage>
  );
}

function DemoKey({ summary }: { summary: TakeSummary }) {
  const { data: take } = useTake(summary.id);
  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h3 className="text-[15px] font-medium">
          {speechName(summary.speech_id)} · demo recording
          <span className="ml-2 font-normal text-muted-foreground">made from clean recording {summary.source_take?.split("_")[1]}</span>
        </h3>
        <Link to={overviewPath(summary.id)} className="group inline-flex items-center gap-1 text-[13px] text-muted-foreground transition-colors hover:text-ink">
          Open analysis <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
        </Link>
      </div>
      {take ? <AnswerKey take={take} /> : <div className="shimmer h-[220px] rounded-xl" />}
    </div>
  );
}

const Dot = ({ c }: { c: Category }) => <span className="size-2 shrink-0 rounded-full" style={{ background: CATEGORY[c].color }} />;

function CategoryTable({ v }: { v: Validation }) {
  const rows: [string, Category | null, Validation["detection"]["overall"]][] = [
    ...CATEGORIES.map((c) => [CATEGORY[c].label, c, v.detection.per_category[c]] as [string, Category, Validation["detection"]["overall"]]),
    ["All", null, v.detection.overall],
  ];
  return (
    <Table>
      <thead>
        <tr>
          <Th>Aspect</Th><Th right>Found</Th><Th right>Missed</Th><Th right>False alarm</Th><Th right>Side effect</Th>
          <Th right>Found rate</Th><Th right>Precision</Th><Th right>F1</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, c, d]) => (
          <tr key={label} className={c ? "" : "font-medium"}>
            <Td><span className="flex items-center gap-2">{c && <Dot c={c} />}{label}</span></Td>
            <Td right mono>{d.tp}</Td><Td right mono>{d.fn}</Td><Td right mono>{d.control_fp}</Td><Td right mono>{d.collateral_fp}</Td>
            <Td right mono>{pct(d.recall)}</Td><Td right mono>{pct(d.precision)}</Td><Td right mono>{fmt(d.f1, 2)}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function KindTable({ v }: { v: Validation }) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>Injected flaw</Th><Th right>Found</Th><Th right>Overlap</Th><Th right>Start offset</Th><Th right>End offset</Th>
          <Th right>Severity</Th><Th right>Side effects</Th>
        </tr>
      </thead>
      <tbody>
        {Object.entries(v.per_kind).map(([k, s]) => (
          <tr key={k}>
            <Td>
              <span className="flex items-center gap-2">{KIND[k] && <Dot c={KIND[k].category} />}{kindLabel(k)}</span>
              {KIND[k] && <span className="block pl-4 text-[12px] text-muted-foreground">{KIND[k].how}</span>}
            </Td>
            <Td right mono>{pct(s.recall)} <span className="text-faint">of {s.n_clean}</span></Td>
            <Td right mono>{fmt(s.iou, 2)}</Td>
            <Td right mono>{fmt(s.start_err, 2)} s <span className="text-faint">/ {fmt(s.start_err_p90, 2)}</span></Td>
            <Td right mono>{fmt(s.end_err, 2)} s <span className="text-faint">/ {fmt(s.end_err_p90, 2)}</span></Td>
            <Td right mono>{fmt(s.severity, 2)}</Td>
            <Td right mono>{s.collateral_fp}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function ControlsTable({ v, takes }: { v: Validation; takes: TakeSummary[] }) {
  const c = v.controls;
  return (
    <Table>
      <thead>
        <tr><Th>Clean recording</Th><Th right>Findings</Th><Th right>Words inside</Th><Th right>Per minute</Th><Th>What was flagged</Th><Th /></tr>
      </thead>
      <tbody>
        {c.per_take.map((r) => {
          const id = caseToId(r.case);
          const t = takes.find((x) => x.id === id);
          return (
            <tr key={r.case} className="group">
              <Td className="whitespace-nowrap">
                {t ? (
                  <Link to={overviewPath(id)} className="underline decoration-ink/20 underline-offset-[3px] transition-colors hover:decoration-ink">
                    {speechName(t.speech_id)} · clean {t.take_id.split("_")[1]}
                  </Link>
                ) : r.case}
              </Td>
              <Td right mono>{r.n_tracks}</Td>
              <Td right mono>{r.words_flagged} <span className="text-faint">/ {r.n_words}</span></Td>
              <Td right mono>{fmt(r.tracks_per_min, 1)}</Td>
              <Td muted className="text-[12.5px]">
                <span className="flex flex-wrap gap-x-3 gap-y-0.5">
                  {Object.entries(r.tracks).map(([k, n]) => {
                    const s = splitTrack(k);
                    return (
                      <span key={k} className="flex items-center gap-1.5 whitespace-nowrap">
                        <Dot c={s.category} />{plainTitle(s).toLowerCase()}{n > 1 ? ` ×${n}` : ""}
                      </span>
                    );
                  })}
                </span>
              </Td>
              <Td right>{t && <Link to={overviewPath(id)} aria-label="Open"><ArrowRight className="size-4 text-faint transition-colors group-hover:text-ink" /></Link>}</Td>
            </tr>
          );
        })}
        <tr className="font-medium">
          <Td>All six</Td><Td right mono>{c.n_tracks}</Td><Td right mono>{c.words_flagged} <span className="text-faint">/ {c.n_words}</span></Td>
          <Td right mono>{fmt(c.tracks_per_min, 1)}</Td><Td /><Td />
        </tr>
      </tbody>
    </Table>
  );
}

function SeverityTable({ v }: { v: Validation }) {
  const kinds = Object.entries(v.severity);
  const n = Math.max(...kinds.map(([, s]) => s.strengths.length));
  return (
    <Table>
      <thead>
        <tr>
          <Th>Injected flaw</Th>
          {Array.from({ length: n }, (_, i) => <Th key={i} right>{i === 0 ? "Weakest" : i === n - 1 ? "Strongest" : ""}</Th>)}
          <Th right>ρ</Th>
        </tr>
      </thead>
      <tbody>
        {kinds.map(([k, s]) => (
          <tr key={k}>
            <Td><span className="flex items-center gap-2">{KIND[k] && <Dot c={KIND[k].category} />}{kindLabel(k)}</span></Td>
            {s.strengths.map((st, i) => (
              <Td key={st} right mono>
                {fmt(s.mean_score[i], 2)} <span className="text-faint">({s.detected[i]})</span>
                <span className="block text-[10.5px] text-faint">×{st}</span>
              </Td>
            ))}
            <Td right mono>{fmt(s.rho, 2)}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function ReferenceTable({ v, takes }: { v: Validation; takes: TakeSummary[] }) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>Clean recording</Th>
          <Th right>Findings</Th><Th right>Words inside</Th><Th right>Injections found</Th>
        </tr>
      </thead>
      <tbody>
        {Object.entries(v.reference.in_sample_vs_loo).map(([c, r]) => {
          const t = takes.find((x) => x.id === caseToId(c));
          return (
            <tr key={c}>
              <Td className="whitespace-nowrap">{t ? `${speechName(t.speech_id)} · clean ${t.take_id.split("_")[1]}` : c}</Td>
              <Td right mono>{r.leave_one_out.control_tracks} <span className="text-faint">· {r.in_sample.control_tracks}</span></Td>
              <Td right mono>{r.leave_one_out.words_flagged} <span className="text-faint">· {r.in_sample.words_flagged}</span></Td>
              <Td right mono>{pct(r.leave_one_out.clean_recall)} <span className="text-faint">· {pct(r.in_sample.clean_recall)}</span></Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

function InfluenceTable({ v }: { v: Validation }) {
  return (
    <div>
      <p className="mb-3 text-[13px] text-muted-foreground">
        For each script and each left-out delivery: the median shift of the per-word reference value, as a fraction of the usual
        spread (0.3 = a third of a typical take-to-take difference). In brackets, word measurements that drop out because fewer
        than two references remain.
      </p>
      <Table>
        <thead>
          <tr><Th>Script</Th><Th>Left out</Th>{CATEGORIES.map((c) => <Th key={c} right>{CATEGORY[c].label}</Th>)}</tr>
        </thead>
        <tbody>
          {Object.entries(v.reference.influence).flatMap(([speech, byTake]) =>
            Object.entries(byTake).map(([take, cells]) => (
              <tr key={speech + take}>
                <Td className="whitespace-nowrap">{speechName(speech)}</Td>
                <Td muted className="whitespace-nowrap">clean {take.split("_")[1]}</Td>
                {CATEGORIES.map((c) => (
                  <Td key={c} right mono>{fmt(cells[c]?.median, 2)} <span className="text-faint">({cells[c]?.cells_lost ?? 0})</span></Td>
                ))}
              </tr>
            )),
          )}
        </tbody>
      </Table>
    </div>
  );
}

function Reproducibility({ v }: { v: Validation }) {
  const m = v.metadata;
  const [cfgName, cfgHash] = Object.entries(m.config)[0] ?? ["config.yaml", ""];
  return (
    <div className="text-[14px] leading-relaxed text-muted-foreground">
      <p>
        All numbers on these pages are read from the exported evaluation reports. The reports carry no timestamps: the same inputs and
        code give byte-identical results. They were produced with {cfgName} <span className="font-mono text-[12px] text-ink/70">{cfgHash.slice(0, 12)}…</span>,{" "}
        {Object.keys(m.code).length} hashed code files and {m.n_inputs} cached inputs, on Python {m.python}.
      </p>
      <Disclosure title="Code and library versions" className="mt-4 border-b">
        <div className="grid grid-cols-2 gap-x-8 gap-y-1 font-mono text-[12px]">
          {Object.entries(m.libraries).map(([k, ver]) => (
            <div key={k} className="flex justify-between gap-3"><span>{k}</span><span className="text-faint">{ver}</span></div>
          ))}
        </div>
        <div className="mt-4 space-y-0.5 font-mono text-[11.5px]">
          {Object.entries(m.code).map(([f, h]) => (
            <div key={f} className="flex justify-between gap-3"><span className="text-ink/75">{f}</span><span className="text-faint">{h.slice(0, 16)}…</span></div>
          ))}
        </div>
      </Disclosure>
    </div>
  );
}

export function ReadingSkeleton() {
  return (
    <div className="mx-auto max-w-4xl space-y-4 px-8 pt-12">
      <div className="shimmer h-3 w-40 rounded" />
      <div className="shimmer h-12 w-2/3 rounded-lg" />
      <div className="shimmer h-4 w-full rounded" />
      <div className="shimmer h-4 w-5/6 rounded" />
      <div className="shimmer mt-10 h-40 w-full rounded-2xl" />
    </div>
  );
}
