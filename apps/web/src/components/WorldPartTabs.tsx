/**
 * Part tabs and the breadcrumb under them. One browser tab holds many
 * part files; only the focused one is live.
 */

import { useEffect } from "react";

import { RunPlayingDialog } from "@/components/RunPlayingDialog";
import { partTabLabel } from "@/lib/world-part-tabs";
import {
  closePartFile,
  notePartTabName,
  showPartFile,
  stayPartPark,
  stopPartPark,
  usePartTabs,
} from "@/state/part-tabs";
import { useWorld } from "@/state/world";

export function PartTabStrip() {
  const { model } = usePartTabs();
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
      {model.tabs.map((tab) => {
        const focused = tab.file === model.focused;
        return (
          <div
            key={tab.file}
            className={
              focused
                ? "flex h-7 max-w-48 shrink-0 items-center rounded-md bg-muted pl-2"
                : "flex h-7 max-w-48 shrink-0 items-center rounded-md pl-2 hover:bg-muted/60"
            }
          >
            <button
              type="button"
              className="min-w-0 truncate text-left text-sm font-medium"
              aria-current={focused ? "page" : undefined}
              title={tab.file}
              onClick={() =>
                showPartFile(tab.file, {
                  origin: "sidebar",
                  history: "replace",
                })
              }
            >
              {tab.name}
            </button>
            {tab.readOnly ? (
              <span className="ml-1 shrink-0 text-[10px] text-muted-foreground">
                read-only
              </span>
            ) : null}
            <button
              type="button"
              className="ml-0.5 h-7 shrink-0 px-1.5 text-xs text-muted-foreground hover:text-foreground"
              aria-label={`Close ${tab.name}`}
              onClick={() => closePartFile(tab.file)}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function PartBreadcrumb() {
  const { model } = usePartTabs();
  const path = useWorld((s) => s.path);
  const part = useWorld((s) => s.tree?.part ?? "");
  useEffect(() => {
    if (!path || !part) return;
    notePartTabName(path, part);
  }, [path, part]);
  const focused = model.tabs.find((tab) => tab.file === model.focused);
  const chain = focused?.chain ?? [];
  if (chain.length === 0) return null;
  return (
    <nav
      aria-label="Part breadcrumb"
      className="flex h-6 items-center gap-1 border-t border-border px-3 text-[11px]"
    >
      {chain.map((crumb, index) => {
        const current = crumb.file === model.focused;
        return (
          <span
            key={`${crumb.file}:${index}`}
            className="flex min-w-0 items-center gap-1"
          >
            {index > 0 ? (
              <span className="text-muted-foreground" aria-hidden>
                ›
              </span>
            ) : null}
            <button
              type="button"
              className={
                current
                  ? "truncate font-medium text-foreground"
                  : "truncate text-muted-foreground hover:text-foreground"
              }
              onClick={() =>
                showPartFile(crumb.file, {
                  origin: "crumb",
                  history: "replace",
                })
              }
            >
              {crumb.name}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

export function PartParkDialog() {
  const { pending } = usePartTabs();
  if (!pending) return null;
  const leaving = pending.kind === "close" ? "close" : "leave";
  return (
    <RunPlayingDialog
      description={
        leaving === "close"
          ? "Closing this part drops the live run. The recording stays on the timeline."
          : "Parking this part drops the live run. The recording stays on the timeline."
      }
      onStay={stayPartPark}
      onStop={stopPartPark}
    />
  );
}

export function openPartFile(file: string, instance: string, partId: string) {
  showPartFile(file, {
    origin: "open-part",
    instance,
    name: partTabLabel(partId.includes("/") ? `${partId}.json` : partId),
    history: "push",
  });
}
