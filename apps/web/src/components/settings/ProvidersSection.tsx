import { loginHintCopy } from "@/chat/model-picker";
import { CommandBlock } from "@/components/chat/CommandBlock";
import { Button } from "@/components/ui/button";
import { useHarnesses } from "@/hooks/useHarnesses";
import type { HarnessInfo } from "@/lib/harness";
import { harnessStatusLabel } from "@/lib/settings";
import { cn } from "@/lib/utils";

function statusDotClass(status: string): string {
  if (status === "ready") return "bg-emerald-500";
  if (status === "needs-auth") return "bg-amber-500";
  if (status === "missing-cli") return "bg-destructive";
  return "bg-muted-foreground";
}

function ProviderRow({
  info,
  onCheckAgain,
}: {
  info: HarnessInfo;
  onCheckAgain: () => void;
}) {
  const copy = loginHintCopy({
    label: info.label,
    status: info.status,
    detail: info.detail,
  });
  const ready = info.status === "ready";
  return (
    <div className="space-y-2 rounded-md border border-border p-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              statusDotClass(info.status)
            )}
          />
          <span className="truncate text-sm font-medium">{info.label}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {harnessStatusLabel(info.status)}
          </span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 px-2 text-xs"
          onClick={onCheckAgain}
        >
          Check again
        </Button>
      </div>
      {ready ? null : (
        <div className="space-y-1.5">
          <p className="text-xs text-amber-800 dark:text-amber-400">
            {copy.headline}
          </p>
          {copy.command ? <CommandBlock command={copy.command} /> : null}
          {copy.secondary ? (
            <p className="text-xs text-muted-foreground">{copy.secondary}</p>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function ProvidersSection() {
  const { harnesses, ready, error, refresh } = useHarnesses();
  if (!ready && harnesses.length === 0) {
    return <p className="text-sm text-muted-foreground">Checking providers…</p>;
  }
  if (error && harnesses.length === 0) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          Couldn&apos;t load providers.
        </p>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          onClick={() => refresh("retry")}
        >
          Check again
        </Button>
      </div>
    );
  }
  if (harnesses.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Open a folder to see providers.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {harnesses.map((info) => (
        <ProviderRow
          key={info.id}
          info={info}
          onCheckAgain={() => refresh("retry")}
        />
      ))}
    </div>
  );
}
