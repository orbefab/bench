import type { HarnessId } from "@sfab-bench/contract";
import { PROVIDER_MARK } from "@/lib/provider-marks";
import { cn } from "@/lib/utils";

export function ProviderMark({
  id,
  className,
}: {
  id: HarnessId;
  className?: string;
}) {
  const mark = PROVIDER_MARK[id];
  return (
    <svg
      viewBox={mark.viewBox}
      fill="currentColor"
      aria-hidden
      className={cn("size-4 shrink-0 text-foreground", className)}
    >
      {mark.paths.map((p) => (
        <path
          key={p.d.slice(0, 24)}
          d={p.d}
          fillRule={p.evenodd ? "evenodd" : undefined}
          clipRule={p.evenodd ? "evenodd" : undefined}
        />
      ))}
    </svg>
  );
}
