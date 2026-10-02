import { Button } from "@/components/ui/button";
import { captureProgress } from "@/lib/world-capture";
import { stopWorldCapture, useCapture } from "@/state/world-capture";

/**
 * Progress of the capture running in this world, above the play
 * controls. The run itself is not touched by a capture.
 */
export function CaptureBar() {
  const state = useCapture((s) => s);
  const progress = captureProgress(state);
  if (!progress) return null;
  const total =
    progress.total > 0 ? ` ${progress.done} / ${progress.total}` : "";
  return (
    <div
      className="flex items-center gap-2 text-[11px]"
      data-slot="capture-bar"
    >
      <span className="min-w-0 flex-1 truncate" title={progress.label}>
        {progress.label}
        <span className="tabular-nums text-muted-foreground">{total}</span>
      </span>
      <div
        className="h-1.5 w-40 shrink-0 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label="Capture progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress.fraction * 100)}
      >
        <div
          className="h-full bg-brand"
          style={{ width: `${progress.fraction * 100}%` }}
        />
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-6 px-2 text-xs"
        onClick={() => stopWorldCapture()}
      >
        Abort
      </Button>
    </div>
  );
}
