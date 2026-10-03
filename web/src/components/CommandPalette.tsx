import { useNavigate } from "react-router-dom";
import { BookOpen, Check, FileJson, FileText, FlaskConical, Gauge, Home, Keyboard, Link2, Music, Pause, Play, ScanLine, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { copyLink, downloadAnalysis, downloadAudio } from "@/lib/actions";
import { CATEGORY } from "@/lib/categories";
import { useIndex, useTake } from "@/lib/data";
import { plainTitle, rankFindings } from "@/lib/findings";
import { fmtClock } from "@/lib/format";
import { player, usePlayerState } from "@/lib/player";
import { useUi, type Layers } from "@/lib/store";
import { evaluationPath, explorePath, findingPath, groupBySpeech, methodPath, overviewPath, robustnessPath, speechName, takeName } from "@/lib/takes";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { FindingNumber } from "./FindingNumber";
import { useCurrentTake } from "./layout/useCurrentTake";

const LAYER_LABEL: Record<keyof Layers, string> = {
  pitch: "Pitch contour", energy: "Energy contour", reference: "Reference range", deviation: "Deviation heat", truth: "Injected edits",
};

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPaletteOpen);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent top className="w-[min(92vw,620px)] overflow-hidden p-0">
        <DialogTitle className="sr-only">Search</DialogTitle>
        {open && <PaletteBody close={() => setOpen(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function PaletteBody({ close }: { close: () => void }) {
  const navigate = useNavigate();
  const { id, view } = useCurrentTake();
  const { data: index } = useIndex();
  const { data: take } = useTake(id ?? undefined);
  const { playing, rate } = usePlayerState();
  const layers = useUi((s) => s.layers);
  const toggleLayer = useUi((s) => s.toggleLayer);
  const openShortcuts = useUi((s) => s.setShortcutsOpen);

  const run = (fn: () => void) => () => {
    close();
    fn();
  };

  return (
    <Command loop>
      <CommandInput placeholder={take ? "Jump to a finding, recording or action…" : "Jump to a recording or action…"} autoFocus />
      <CommandList className="max-h-[min(62vh,480px)]">
        <CommandEmpty>Nothing matches.</CommandEmpty>

        {take && take.flaws.length > 0 && (
          <CommandGroup heading={`Findings · ${speechName(take.speech_id)} ${takeName(take).toLowerCase()}`}>
            {rankFindings(take).map((fi, r) => {
              const f = take.flaws[fi];
              return (
                <CommandItem key={fi} value={`finding ${r + 1} ${plainTitle(f)} ${CATEGORY[f.category].label} ${f.severity.label} ${f.words.join(" ")}`}
                  onSelect={run(() => navigate(findingPath(take.id, r + 1)))}>
                  <FindingNumber n={r + 1} category={f.category} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{plainTitle(f)}</span>
                    <span className="block truncate text-[12px] text-muted-foreground">“{f.words.join(" ")}”</span>
                  </span>
                  <span className="text-[11.5px] text-muted-foreground capitalize">{f.severity.label}</span>
                  <CommandShortcut>{fmtClock(f.start)}</CommandShortcut>
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}

        <CommandGroup heading="Go to">
          {take && view !== "overview" && (
            <CommandItem value="go to summary overview all findings" onSelect={run(() => navigate(overviewPath(take.id)))}><FileText /> Summary of this recording</CommandItem>
          )}
          {take && view !== "explore" && (
            <CommandItem value="open timeline explorer advanced" onSelect={run(() => navigate(explorePath(take.id)))}><ScanLine /> Timeline explorer</CommandItem>
          )}
          <CommandItem value="home all recordings" onSelect={run(() => navigate("/"))}><Home /> All recordings</CommandItem>
          <CommandItem value="evaluation performance precision recall accuracy" onSelect={run(() => navigate(evaluationPath))}><FlaskConical /> Evaluation: performance</CommandItem>
          <CommandItem value="robustness noise compression audio quality" onSelect={run(() => navigate(robustnessPath))}><ShieldCheck /> Evaluation: robustness to audio quality</CommandItem>
          <CommandItem value="method how it works pipeline" onSelect={run(() => navigate(methodPath))}><BookOpen /> How it works</CommandItem>
        </CommandGroup>

        {take && (
          <CommandGroup heading="Playback">
            <CommandItem value="play pause whole recording" onSelect={run(() => player.toggle())}>
              {playing ? <Pause /> : <Play />} {playing ? "Pause" : "Play the whole recording"}
            </CommandItem>
            {[0.75, 1, 1.25].map((r) => (
              <CommandItem key={r} value={`speed rate ${r}x`} onSelect={run(() => player.setRate(r))}>
                <Gauge /> Playback speed {r}×
                {rate === r && <Check className="ml-auto text-ink" />}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {index && (
          <CommandGroup heading="Recordings">
            {groupBySpeech(index.takes).flatMap((g) =>
              g.takes.map((t) => (
                <CommandItem key={t.id} value={`recording ${speechName(t.speech_id)} ${takeName(t)} ${t.take_id} ${g.opening}`}
                  onSelect={run(() => navigate(overviewPath(t.id)))}>
                  <FileText />
                  <span className="text-muted-foreground">{speechName(t.speech_id)}</span>
                  <span>{takeName(t)}</span>
                  {t.id === id && <span className="text-[11.5px] text-faint">current</span>}
                  <CommandShortcut>{t.n_flaws} findings</CommandShortcut>
                </CommandItem>
              )),
            )}
          </CommandGroup>
        )}

        {take && view === "explore" && (
          <CommandGroup heading="Timeline lanes">
            {(Object.keys(LAYER_LABEL) as (keyof Layers)[])
              .filter((k) => k !== "truth" || take.ground_truth)
              .map((k) => (
                <CommandItem key={k} value={`lane layer toggle ${LAYER_LABEL[k]}`} onSelect={run(() => toggleLayer(k))}>
                  <SlidersHorizontal /> {layers[k] ? "Hide" : "Show"} {LAYER_LABEL[k].toLowerCase()}
                  {layers[k] && <Check className="ml-auto text-ink" />}
                </CommandItem>
              ))}
          </CommandGroup>
        )}

        {take && (
          <CommandGroup heading="Export">
            <CommandItem value="export download analysis json" onSelect={run(() => downloadAnalysis(take))}><FileJson /> Download analysis (JSON)</CommandItem>
            <CommandItem value="export download audio flac" onSelect={run(() => downloadAudio(take))}><Music /> Download audio</CommandItem>
            <CommandItem value="copy share link url" onSelect={run(() => void copyLink())}><Link2 /> Copy link to this page</CommandItem>
          </CommandGroup>
        )}

        <CommandGroup heading="Help">
          <CommandItem value="keyboard shortcuts help" onSelect={run(() => openShortcuts(true))}>
            <Keyboard /> Keyboard shortcuts <CommandShortcut><Kbd>?</Kbd></CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </CommandList>
      <div className="flex items-center gap-4 border-t border-hairline bg-background/60 px-4 py-2 text-[11.5px] text-faint">
        <span className="flex items-center gap-1.5"><Kbd>↑</Kbd><Kbd>↓</Kbd> move</span>
        <span className="flex items-center gap-1.5"><Kbd>Enter</Kbd> open</span>
        <span className="flex items-center gap-1.5"><Kbd>Esc</Kbd> close</span>
      </div>
    </Command>
  );
}
