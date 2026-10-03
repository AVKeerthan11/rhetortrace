import { Link } from "react-router-dom";
import { RotateCw } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";

/** Centered message for empty / error states. */
export function PageState({ title, detail, retry = true }: { title: string; detail?: string; retry?: boolean }) {
  return (
    <div className="paper-grain grid h-full place-items-center px-6">
      <div className="max-w-sm text-center">
        <h1 className="font-display text-[28px] leading-tight">{title}</h1>
        {detail && <p className="mt-2 font-mono text-[12px] break-words text-muted-foreground">{detail}</p>}
        <div className="mt-5 flex justify-center gap-2">
          {retry && (
            <Button variant="outline" size="sm" onClick={() => location.reload()}>
              <RotateCw /> Try again
            </Button>
          )}
          <Link to="/" className={buttonVariants({ variant: "ghost", size: "sm" })}>All recordings</Link>
        </div>
      </div>
    </div>
  );
}
