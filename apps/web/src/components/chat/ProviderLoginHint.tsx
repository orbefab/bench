import { loginHintCopy } from "@/chat/model-picker";
import { CommandBlock } from "@/components/chat/CommandBlock";
import { Button } from "@/components/ui/button";
import type { HarnessInfo } from "@/lib/harness";

export function ProviderLoginHint({
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
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs text-amber-800 dark:text-amber-400">
        {copy.headline}
      </p>
      {copy.command ? <CommandBlock command={copy.command} /> : null}
      {copy.secondary ? (
        <p className="text-[11px] text-muted-foreground">{copy.secondary}</p>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 self-start px-2 text-xs"
        onClick={onCheckAgain}
      >
        Check again
      </Button>
    </div>
  );
}
