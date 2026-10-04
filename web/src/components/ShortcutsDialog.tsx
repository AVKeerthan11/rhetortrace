import { MOD } from "@/lib/keys";
import { useUi } from "@/lib/store";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";

const GROUPS: { title: string; keys: [string[], string][] }[] = [
  {
    title: "Anywhere",
    keys: [
      [[MOD, "K"], "Search findings and recordings"],
      [["?"], "This list"],
      [["["], "Slower playback"],
      [["]"], "Faster playback"],
    ],
  },
  {
    title: "On a recording: time",
    keys: [
      [["Space"], "Play / pause (on a finding: play the moment)"],
      [["←", "→"], "Previous / next word"],
      [["Home", "End"], "Start / end"],
      [["Drag"], "Scrub (on the audio or the ruler)"],
      [["L"], "Loop the current finding"],
      [["Shift"], "Hold: hear the reference at the same point"],
    ],
  },
  {
    title: "On a recording: findings",
    keys: [
      [["J"], "Next finding"],
      [["K"], "Previous finding"],
      [["Enter"], "Open the finding at the playhead (overview)"],
      [["Esc"], "Up one level"],
    ],
  },
  {
    title: "On a recording: view",
    keys: [
      [["−", "="], "Zoom out / in"],
      [["0"], "Fit the whole recording"],
      [["R"], "Reference range on / off"],
      [["Scroll"], "Zoom (explorer; elsewhere with " + MOD + ")"],
      [["Drag"], "Pan (on the other lanes)"],
    ],
  },
];

export function ShortcutsDialog() {
  const open = useUi((s) => s.shortcutsOpen);
  const setOpen = useUi((s) => s.setShortcutsOpen);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="w-[min(92vw,600px)] p-6">
        <DialogTitle className="font-display text-[28px] leading-none">Keyboard shortcuts</DialogTitle>
        <div className="mt-5 grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2">
          {GROUPS.map((g) => (
            <section key={g.title}>
              <h3 className="mb-2 text-[10.5px] font-medium tracking-[0.12em] text-faint uppercase">{g.title}</h3>
              <ul className="space-y-1.5">
                {g.keys.map(([keys, label]) => (
                  <li key={label} className="flex items-center justify-between gap-3 text-[13px]">
                    <span className="text-muted-foreground">{label}</span>
                    <span className="flex gap-1">{keys.map((k) => <Kbd key={k}>{k}</Kbd>)}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
