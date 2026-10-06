import {
  HARNESS_LABEL,
  type HarnessId,
  type HarnessInfo,
} from "@sfab-bench/contract";
import { useEffect, useState } from "react";
import {
  firstSetupCopy,
  inFlightHarness,
  shouldLatchFirstSetup,
  showFirstSetupHint,
} from "@/chat/composer-recovery";
import type { HarnessRefreshReason } from "@/chat/model-picker";
import { usePrefs } from "@/state/prefs";

/** Line under the composer while this machine installs the selected provider. */
export function useFirstSetupHint(
  status: string,
  catalog: {
    harnesses: HarnessInfo[];
    refresh: (reason?: HarnessRefreshReason) => void;
  }
): string | null {
  const live = usePrefs((s) => s.chatHarness);
  const { harnesses, refresh } = catalog;
  const [frozen, setFrozen] = useState<HarnessId | null>(null);
  const [latched, setLatched] = useState(() => new Set<string>());
  const next = inFlightHarness({ status, live, frozen });
  const harness = next.harness;

  useEffect(() => {
    setFrozen(next.frozen);
  }, [next.frozen]);

  useEffect(() => {
    if (
      !shouldLatchFirstSetup({
        status,
        harness,
        latched,
      })
    ) {
      return;
    }
    setLatched((cur) => {
      if (cur.has(harness)) return cur;
      const copy = new Set(cur);
      copy.add(harness);
      return copy;
    });
    refresh("retry");
  }, [harness, latched, refresh, status]);

  const info = harnesses.find((h) => h.id === harness);
  if (
    !showFirstSetupHint({
      status,
      bridgeReady: info?.bridgeReady,
      latched: latched.has(harness),
    })
  ) {
    return null;
  }
  return firstSetupCopy(HARNESS_LABEL[harness]);
}
