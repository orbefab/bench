import { ChevronDown } from "lucide-react";

import { EFFORT_TRIGGER_TITLE } from "@/chat/model-picker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CHAT_EFFORT_LABEL,
  CHAT_EFFORTS,
  HARNESS_LABEL,
  harnessSupportsEffort,
  isChatEffort,
} from "@/lib/harness";
import { usePrefs } from "@/state/prefs";

export function EffortSelect() {
  const harness = usePrefs((s) => s.chatHarness);
  const effort = usePrefs((s) => s.chatEffort);
  const setChatEffort = usePrefs((s) => s.setChatEffort);
  const supported = harnessSupportsEffort(harness);
  if (!supported) {
    return (
      <button
        type="button"
        disabled
        aria-label="Reasoning effort"
        title={`Effort isn't available for ${HARNESS_LABEL[harness]}`}
        className="inline-flex h-7 max-w-20 min-w-0 shrink-0 cursor-not-allowed items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground opacity-50 outline-none select-none"
      >
        <span className="min-w-0 truncate">Effort</span>
        <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
      </button>
    );
  }
  return (
    <Select
      modal={false}
      value={effort}
      items={CHAT_EFFORTS.map((value) => ({
        value,
        label: CHAT_EFFORT_LABEL[value],
      }))}
      onValueChange={(value: string | null) => {
        if (value && isChatEffort(value)) setChatEffort(value);
      }}
    >
      <SelectTrigger
        aria-label="Reasoning effort"
        title={EFFORT_TRIGGER_TITLE}
        className="max-w-20 min-w-0 shrink-0"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent onClick={(event) => event.stopPropagation()}>
        {CHAT_EFFORTS.map((value) => (
          <SelectItem key={value} value={value}>
            {CHAT_EFFORT_LABEL[value]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
