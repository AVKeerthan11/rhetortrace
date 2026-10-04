import { useEffect, useLayoutEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { takeRange } from "@/lib/findings";
import { captureFlights } from "@/lib/flight";
import { isTypingTarget } from "@/lib/keys";
import { player } from "@/lib/player";
import { useUi } from "@/lib/store";
import { explorePath, findingPath, overviewPath } from "@/lib/takes";
import { findingAt, stepWord } from "@/lib/time";
import type { Take } from "@/lib/types";
import { releaseHold, startHold } from "./hold";
import { useStage, type Level } from "./store";

// The keyboard model of a recording, the same on its three screens (see ShortcutsDialog):
//   Space      play / pause (on a finding: play the moment)
//   J / K      next / previous finding (overview: jump the playhead to it; finding: open it;
//              explorer: select it, in time order)
//   Enter      open the finding under the playhead or highlighted (overview)
//   ← / →      previous / next word        Home / End   start / end
//   − / =      zoom out / in               0            fit the whole recording
//   L          loop the current finding    R            reference range on / off
//   Esc        up one level (close the finding, fit, back to the overview)
//   Shift      hold: hear the reference delivery at the same point of the script
// [ / ] (speed), ? and ⌘K stay global (AppShell).

export function useStageKeys({ take, level, rank, ranking, ranks, focus, onStep }: {
  take: Take; level: Level; rank: number | null; ranking: number[]; ranks: number[]; focus: number | null; onStep: (dir: 1 | -1) => void;
}) {
  const navigate = useNavigate();
  const state = useRef({ take, level, rank, ranking, ranks, focus, onStep });
  useLayoutEffect(() => {
    state.current = { take, level, rank, ranking, ranks, focus, onStep };
  });

  useEffect(() => {
    const byTime = () => {
      const t = state.current.take;
      return t.flaws.map((_, i) => i).sort((a, b) => t.flaws[a].start - t.flaws[b].start);
    };
    /** keep t on screen: pan the camera when the playhead leaves the window */
    const reveal = (t: number) => {
      const { view: [a, b], setView } = useStage.getState();
      if (t < a || t > b) setView([t - (b - a) * 0.3, t + (b - a) * 0.7]);
    };
    /** the finding the current action is about */
    const current = (): number | null => {
      const { take: tk, level: lv, focus: fc } = state.current;
      const s = useStage.getState();
      if (lv === "finding") return fc;
      if (lv === "explore" && s.selected !== null) return s.selected;
      if (s.hovered !== null) return s.hovered;
      const at = findingAt(tk, player.time);
      return at >= 0 ? at : null;
    };

    // Shift held on its own for a moment: hear the reference (a Shift+key chord never starts it)
    let holdTimer = 0;
    const cancelHold = () => {
      clearTimeout(holdTimer);
      holdTimer = 0;
      releaseHold();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") cancelHold();
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Shift") {
        if (!e.repeat && !isTypingTarget(e) && !e.metaKey && !e.ctrlKey && !e.altKey)
          holdTimer = window.setTimeout(() => startHold(state.current.take), 180);
        return;
      }
      if (holdTimer && !player.ghost) {
        clearTimeout(holdTimer);
        holdTimer = 0;
      }
      if (isTypingTarget(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const { take: tk, level: lv, rank: rk, ranking: rg, ranks: rs, focus: fc, onStep: step } = state.current;
      const s = useStage.getState();
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      let handled = true;
      switch (key) {
        case " ":
          if (lv === "finding" && fc !== null) {
            const label = `Finding ${rk} · this recording`;
            if (player.playing && player.label === label) player.stop();
            else player.playSegment(...takeRange(tk, tk.flaws[fc]), label);
          } else player.toggle();
          break;
        case "j":
        case "k": {
          const dir = key === "j" ? 1 : -1;
          if (lv === "finding" && rk !== null) {
            const next = rk + dir;
            if (next >= 1 && next <= rg.length) {
              player.stop();
              navigate(findingPath(tk.id, next));
            }
          } else if (lv === "explore") step(dir);
          else {
            // overview: move the playhead to the next / previous finding in time
            const order = byTime();
            if (!order.length) break;
            const t = player.time;
            const target = dir === 1
              ? order.find((i) => tk.flaws[i].start > t + 0.05) ?? order[0]
              : [...order].reverse().find((i) => tk.flaws[i].start < t - 0.3) ?? order[order.length - 1];
            player.seek(tk.flaws[target].start);
            s.setHovered(target);
          }
          break;
        }
        case "Enter": {
          if (lv !== "overview") return;
          const i = current();
          if (i === null) return;
          captureFlights(document.querySelector(`[data-finding-row="${rs[i]}"]`), rs[i]);
          navigate(findingPath(tk.id, rs[i]));
          break;
        }
        case "ArrowLeft":
        case "ArrowRight": {
          const t = stepWord(tk, player.time, key === "ArrowRight" ? 1 : -1);
          if (t === null) break;
          player.seek(t);
          reveal(t);
          break;
        }
        case "Home":
          player.seek(0);
          reveal(0);
          break;
        case "End":
          player.seek(Math.max(0, tk.duration - 0.05));
          reveal(tk.duration);
          break;
        case "-":
        case "_":
        case "=":
        case "+": {
          const [a, b] = s.view;
          const c = player.time >= a && player.time <= b ? player.time : undefined;
          s.zoom(key === "-" || key === "_" ? 1.6 : 1 / 1.6, c);
          break;
        }
        case "0":
          s.fit();
          break;
        case "l": {
          if (player.loop) {
            player.setLoop(null);
            toast("Loop off", { id: "loop", duration: 1200 });
            break;
          }
          const i = current();
          if (i === null) {
            toast("Nothing to loop here: point at a finding or move the playhead into one", { id: "loop", duration: 1800 });
            break;
          }
          const range = takeRange(tk, tk.flaws[i]);
          player.setLoop(range);
          if (player.time < range[0] || player.time > range[1]) player.seek(range[0]);
          toast(`Looping finding ${rs[i]}`, { id: "loop", duration: 1200 });
          break;
        }
        case "r": {
          const ui = useUi.getState();
          ui.toggleLayer("reference");
          toast(`Reference range ${useUi.getState().layers.reference ? "on" : "off"}`, { id: "ref", duration: 1200 });
          break;
        }
        case "Escape":
          if (lv === "finding") navigate(overviewPath(tk.id));
          else if (lv === "explore") {
            const [a, b] = s.view;
            if (s.selected !== null) navigate(explorePath(tk.id), { replace: true });
            else if (a > 0.01 || b < tk.duration - 0.01) s.fit();
            else navigate(overviewPath(tk.id));
          } else s.fit();
          break;
        default:
          handled = false;
      }
      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", cancelHold);
    return () => {
      cancelHold();
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", cancelHold);
    };
  }, [navigate]);

  // a loop belongs to the moment it was set on
  useEffect(() => () => player.setLoop(null), [level, focus]);
}
