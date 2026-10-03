import { CircleAlert } from "lucide-react";
import { explainError, type ApiError } from "@/lib/api";

/** A typed analysis-server error: plain title, the server's message, what to do, and the code. */
export function ErrorCallout({ error, action }: { error: Pick<ApiError, "code" | "kind" | "detail" | "message" | "stage">; action?: React.ReactNode }) {
  const { title, hint } = explainError(error);
  return (
    <div role="alert" className="rounded-xl border border-destructive/20 bg-destructive/[0.05] px-4 py-3.5">
      <div className="flex items-start gap-3">
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <div className="text-[14.5px] font-medium">{title}</div>
          {error.message && <p className="mt-1 text-[13.5px] leading-snug text-ink/80">{error.message}</p>}
          {hint && <p className="mt-1 text-[13px] leading-snug text-muted-foreground">{hint}</p>}
          <p className="mt-2 font-mono text-[11px] text-faint">{error.code}{error.stage ? ` · ${error.stage}` : ""}</p>
        </div>
      </div>
      {action && <div className="mt-3 pl-7">{action}</div>}
    </div>
  );
}
