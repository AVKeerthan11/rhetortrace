import { toast } from "sonner";
import { API, isRunId } from "./api";
import { audioUrl } from "./data";
import type { Take } from "./types";

function download(url: string, name: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
}

export function downloadAnalysis(take: Pick<Take, "id">) {
  download(isRunId(take.id) ? `${API}/results/${take.id}` : `/data/${take.id}.json`, `${take.id}.analysis.json`);
  toast("Analysis JSON downloading", { description: `${take.id}.analysis.json` });
}

export function downloadAudio(take: Pick<Take, "id" | "audio">) {
  download(audioUrl(take.audio), `${take.id}.flac`);
  toast("Audio downloading", { description: `${take.id}.flac` });
}

export async function copyLink() {
  try {
    await navigator.clipboard.writeText(location.href);
    toast.success("Link copied", { description: "It opens this exact view, including the selected finding." });
  } catch {
    toast.error("Could not copy the link", { description: location.href });
  }
}
