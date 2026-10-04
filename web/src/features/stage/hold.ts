import { refTimeAt, takeTimeAt } from "@/lib/align";
import { player } from "@/lib/player";
import { referenceName } from "@/lib/takes";
import type { Take } from "@/lib/types";
import { useStage } from "./store";

/** Hear the reference delivery chosen in "Compare with" from the point of the script the playhead
 *  is at, until releaseHold(). The playhead follows the reference through the script. */
export function startHold(take: Take) {
  const k = useStage.getState().refIdx;
  const r = take.references[k];
  if (!r) return;
  const rt = refTimeAt(take, k, player.time);
  if (rt === null) return;
  player.holdReference(r.audio, rt, (t) => takeTimeAt(take, k, t), `Reference ${referenceName(take, r.take_id)} · same point`);
}

export const releaseHold = () => player.releaseReference();
