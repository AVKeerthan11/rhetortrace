import { Link } from "react-router-dom";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { CATEGORY } from "@/lib/categories";
import { useIndex } from "@/lib/data";
import { plainTitle } from "@/lib/findings";
import { fmt } from "@/lib/format";
import type { RobustnessSummary } from "@/lib/types";
import { CONDITIONS, FEATURE_LABEL, VERDICT_LABEL, pct, splitTrack, verdict, type Verdict } from "@/lib/validation";
import { cn } from "@/lib/utils";
import { Disclosure } from "@/components/Disclosure";
import { EvaluationTabs } from "@/components/EvaluationTabs";
import { Note, PageHeader, ReadingPage, Section, Table, Td, Th } from "@/components/Page";
import { PageState } from "@/components/PageState";
import { ReadingSkeleton } from "./Evaluation";

const VERDICT_STYLE: Record<Verdict, string> = {
  stable: "border-ink/15 text-muted-foreground",
  "false-alarms": "border-ink/40 text-ink bg-ink/[0.05]",
  breaks: "border-ink bg-ink text-primary-foreground",
};

export function Robustness() {
  const { data: index, error } = useIndex();
  if (error) return <PageState title="Could not load the robustness report" detail={error} />;
  if (!index) return <ReadingSkeleton />;
  const rob = index.validation.robustness;
  const rows = CONDITIONS.filter((c) => rob[c.key]).map((c) => ({ ...c, r: rob[c.key], v: verdict(rob[c.key]) }));
  // conditions present in the data but not labelled above still show up, under their raw key
  for (const k of Object.keys(rob)) if (!rows.some((r) => r.key === k)) rows.push({ key: k, group: "Other", label: k, r: rob[k], v: verdict(rob[k]) });
  const base = rows[0]?.r;
  const clarityShare = (r: RobustnessSummary) => (r.new_tracks ? (r.new_by_track["clarity/None"] ?? 0) / r.new_tracks : 0);
  const totalNew = rows.reduce((s, x) => s + x.r.new_tracks, 0);
  const totalClarity = rows.reduce((s, x) => s + (x.r.new_by_track["clarity/None"] ?? 0), 0);

  return (
    <ReadingPage wide>
      <PageHeader eyebrow="Evaluation · robustness" title="Does it hold up on worse audio?">
        <p>
          Each of the six clean recordings was degraded (louder, quieter, compressed, resampled, or mixed with noise), then run
          again through the unchanged pipeline, from word timing to findings, and compared with its results on the original audio.
        </p>
        <p>
          Two things matter: whether real flaws are still found (the injection tests are repeated on the degraded audio), and how
          many new false alarms the degradation causes on recordings that had nothing wrong with them.
        </p>
      </PageHeader>
      <EvaluationTabs />

      <Section i={3} title="Ten audio conditions" lead={
        <>
          Volume changes and resampling to 22 kHz barely change anything. Compression, telephone-band audio and light noise keep
          finding the real flaws but add false alarms. Across all conditions, {pct(totalNew ? totalClarity / totalNew : 0)} of the
          new false alarms are in clarity, the aspect that listens to the sound of the voice itself. Heavy noise is where it
          breaks: word timings drift and real flaws are missed.
        </>
      }>
        <Table>
          <thead>
            <tr>
              <Th>Condition</Th>
              <Th right>Real flaws found</Th>
              <Th right>Findings kept</Th>
              <Th right>New false alarms</Th>
              <Th right>Word timing shift</Th>
              <Th>Reading</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ key, group, label, r, v }, i) => (
              <tr key={key}>
                <Td>
                  {(i === 0 || rows[i - 1].group !== group) && <span className="block text-[10.5px] font-medium tracking-[0.1em] text-faint uppercase">{group}</span>}
                  {label}
                </Td>
                <Td right mono>
                  {pct(r.injection_recall_perturbed, 1)}
                  <span className={cn("block text-[11px]", r.injection_recall_perturbed < r.injection_recall_clean - 0.0005 ? "text-ink/70" : "text-faint")}>
                    {r.injection_recall_perturbed === r.injection_recall_clean ? "unchanged" : `${fmt((r.injection_recall_perturbed - r.injection_recall_clean) * 100, 1)} pts`}
                  </span>
                </Td>
                <Td right mono>{r.kept_tracks} <span className="text-faint">/ {r.clean_tracks}</span></Td>
                <Td right mono>
                  {r.new_tracks}
                  {r.new_tracks > 0 && <span className="block text-[11px] text-faint">{pct(clarityShare(r))} clarity</span>}
                </Td>
                <Td right mono>
                  {Math.round(r.alignment_mean_shift_s * 1000)} ms
                  <span className="block text-[11px] text-faint">{r.words_shifted_gt_50ms} words &gt; 50 ms</span>
                </Td>
                <Td>
                  <span className={cn("inline-flex h-[19px] items-center rounded-[5px] border px-1.5 text-[11px] font-medium whitespace-nowrap", VERDICT_STYLE[v])}>
                    {VERDICT_LABEL[v]}
                  </span>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <Note>
          Real flaws found: share of injected flaws detected on the degraded audio
          {base ? ` (${pct(base.injection_recall_clean, 1)} on the original)` : ""}. Findings kept: original findings on the clean
          recordings that are still there. New false alarms: findings that appear only after degrading. Word timing shift: mean
          movement of the word boundaries. The reading is a summary rule: “misses real flaws” when 10 or more points of detection are
          lost; “more false alarms” when the new ones exceed half the original count.
        </Note>
      </Section>

      <Section i={4} title="Where the new false alarms come from" lead="New findings on the degraded clean recordings, by what they claim.">
        <Table>
          <thead><tr><Th>Condition</Th><Th>New findings</Th></tr></thead>
          <tbody>
            {rows.map(({ key, label, r }) => (
              <tr key={key}>
                <Td className="w-[230px]">{label}</Td>
                <Td muted className="text-[12.5px]">
                  {r.new_tracks === 0 ? <span className="text-faint">none</span> : (
                    <span className="flex flex-wrap gap-x-4 gap-y-1">
                      {Object.entries(r.new_by_track).sort((a, b) => b[1] - a[1]).map(([k, n]) => {
                        const t = splitTrack(k);
                        return (
                          <span key={k} className="flex items-center gap-1.5 whitespace-nowrap">
                            <span className="size-2 rounded-full" style={{ background: CATEGORY[t.category].color }} />
                            {plainTitle(t).toLowerCase()} <span className="font-mono text-ink/80">{n}</span>
                          </span>
                        );
                      })}
                    </span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Section>

      <Section i={5} title="How much the measurements move" lead={
        <>
          The median change of each word measurement, in units of that word's usual variation between good speakers: 1.0 means
          the degradation moved it as much as switching to a different good speaker would.
        </>
      }>
        <DriftTable rows={rows} />
        <Disclosure title="Measurements lost" aside="words that could no longer be measured" className="mt-6 border-b">
          <LostTable rows={rows} />
        </Disclosure>
      </Section>

      <div className="mt-14 flex items-center justify-between border-t border-hairline pt-6">
        <Link to="/evaluation" className="inline-flex items-center gap-1.5 text-[13.5px] text-muted-foreground transition-colors hover:text-ink">
          <ArrowLeft className="size-4" /> Performance
        </Link>
        <Link to="/method"
          className="group inline-flex h-11 items-center gap-2 rounded-full border border-hairline bg-surface pr-5 pl-6 text-[14px] font-medium transition-colors hover:border-ink/25">
          How the analysis works
          <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
        </Link>
      </div>
    </ReadingPage>
  );
}

type Row = { key: string; label: string; r: RobustnessSummary };

function featureKeys(rows: Row[], field: "z_drift_median" | "values_lost") {
  const keys = new Set<string>();
  rows.forEach(({ r }) => Object.keys(r[field]).forEach((k) => keys.add(k)));
  return Object.keys(FEATURE_LABEL).filter((k) => keys.has(k)).concat([...keys].filter((k) => !(k in FEATURE_LABEL)));
}

function DriftTable({ rows }: { rows: Row[] }) {
  const keys = featureKeys(rows, "z_drift_median");
  return (
    <Table>
      <thead><tr><Th>Condition</Th>{keys.map((k) => <Th key={k} right>{FEATURE_LABEL[k] ?? k}</Th>)}</tr></thead>
      <tbody>
        {rows.map(({ key, label, r }) => (
          <tr key={key}>
            <Td>{label}</Td>
            {keys.map((k) => {
              const d = r.z_drift_median[k];
              return (
                <Td key={k} right mono className={cn(d >= 1 ? "font-medium text-ink" : d >= 0.3 ? "text-ink/75" : "text-faint")}>
                  {fmt(d, 2)}
                </Td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function LostTable({ rows }: { rows: Row[] }) {
  const keys = featureKeys(rows, "values_lost");
  const n = rows[0]?.r.n_words ?? 0;
  return (
    <div>
      <p className="mb-3 text-[13px] text-muted-foreground">Out of {n} words across the six clean recordings.</p>
      <Table>
        <thead><tr><Th>Condition</Th>{keys.map((k) => <Th key={k} right>{FEATURE_LABEL[k] ?? k}</Th>)}</tr></thead>
        <tbody>
          {rows.map(({ key, label, r }) => (
            <tr key={key}>
              <Td>{label}</Td>
              {keys.map((k) => <Td key={k} right mono muted={!r.values_lost[k]}>{r.values_lost[k] ?? 0}</Td>)}
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
