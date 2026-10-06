import type { WorldViewNode } from "@sfab-bench/contract";
import { Box, Hash, Minus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { requestInsertPartMention } from "@/lib/part-mention";
import {
  activeEscLayer,
  compactChatSheetOpen,
  isEditableTarget,
  probeEscLayers,
} from "@/lib/shortcuts";
import { accuracyView } from "@/lib/world-accuracy";
import { formatSimTime } from "@/lib/world-issues";
import { partFileName } from "@/lib/world-rename-part";
import { findViewNode } from "@/lib/world-tree";
import {
  documentWarnings,
  inspectorBodyClass,
  instanceWarnings,
  warningsFromRun,
} from "@/lib/world-warnings";
import { usePartTabs } from "@/state/part-tabs";
import { useWorld, worldStore } from "@/state/world";
import { useWorldTimeline } from "@/state/world-timeline";
import { InstanceBody, RenamePartFile } from "./world-inspector/instance-card";
import { PlayFields } from "./world-inspector/params";
import { Field, WarningList } from "./world-inspector/parts";
import { AccuracyBlock } from "./world-inspector/run-card";

function useWorldSelectionEsc() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (!worldStore.getState().selection) return;
      if (isEditableTarget(event.target, document.activeElement)) return;
      const layers = {
        ...probeEscLayers(document),
        compactChat: compactChatSheetOpen(document),
      };
      if (activeEscLayer(layers)) return;
      worldStore.getState().select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function leafRoot(
  tree: { nodes: WorldViewNode[] } | null
): WorldViewNode | null {
  const node = tree?.nodes.length === 1 ? tree.nodes[0] : undefined;
  if (!node || node.children.length > 0) return null;
  if (node.role === "leaf" || node.role === "robot") return node;
  return null;
}

export function WorldInspector({ floating = false }: { floating?: boolean }) {
  useWorldSelectionEsc();
  const tabs = usePartTabs();
  const selection = useWorld((s) => s.selection);
  const wire = useWorld((s) => s.wire);
  const tree = useWorld((s) => s.tree);
  const outline = useWorld((s) => s.outline);
  const report = useWorld((s) => s.report);
  const diagnostics = useWorld((s) => s.diagnostics);
  const editError = useWorld((s) => s.editError);
  const playhead = useWorldTimeline().playhead;
  const warnings = useMemo(
    () => warningsFromRun(report, diagnostics),
    [report, diagnostics]
  );
  const accuracy = useMemo(() => accuracyView(report), [report]);
  const node =
    selection && tree ? findViewNode(tree.nodes, selection.path) : null;
  const wireNode = wire && tree ? findViewNode(tree.nodes, wire.owner) : null;
  const ends = wire ? wireNode?.wires?.[wire.index] : undefined;
  const title = wire ? "Wire" : node ? node.name : (tree?.part ?? "Part");
  const focused = tabs.model.tabs.find(
    (tab) => tab.file === tabs.model.focused
  );
  const openSource = focused?.readOnly
    ? ("library" as const)
    : ("project" as const);
  const lone = leafRoot(tree);
  const selectionKey = wire
    ? `wire:${wire.owner}:${wire.index}`
    : (selection?.path ?? "");
  const [minimized, setMinimized] = useState(false);
  const [trackedKey, setTrackedKey] = useState(selectionKey);
  if (trackedKey !== selectionKey) {
    setTrackedKey(selectionKey);
    setMinimized(false);
  }
  const clearSelection = () => {
    worldStore.getState().select(null);
    worldStore.getState().selectWire(null);
  };
  if (floating && minimized) {
    return (
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        className="pointer-events-auto size-9 self-start rounded-xl border-border bg-background shadow-lg"
        aria-label="Show details"
        title={title}
        onClick={() => setMinimized(false)}
      >
        <Box />
      </Button>
    );
  }
  const header = floating ? (
    <header className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
      <span className="min-w-0 flex-1 truncate text-sm font-medium">
        {title}
      </span>
      {node && !wire ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Add to chat"
          title="Add to chat"
          onClick={() =>
            requestInsertPartMention({ id: node.id, name: node.name })
          }
        >
          <Hash />
        </Button>
      ) : null}
      {selection || wire ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-muted-foreground"
          onClick={clearSelection}
        >
          Clear
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Minimize details"
        title="Minimize"
        onClick={() => setMinimized(true)}
      >
        <Minus />
      </Button>
    </header>
  ) : (
    <header className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
      <span className="truncate text-[13px] font-medium">{title}</span>
      {selection || wire ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-muted-foreground"
          onClick={clearSelection}
        >
          Clear
        </Button>
      ) : null}
    </header>
  );
  const shellClass = floating
    ? "pointer-events-auto flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-lg"
    : "flex h-full w-80 shrink-0 flex-col border-l border-border bg-card";
  const Shell = floating ? "section" : "aside";
  return (
    <Shell
      aria-label={floating ? "Part details" : undefined}
      data-slot={floating ? "world-detail" : undefined}
      className={shellClass}
    >
      {header}
      <div className={inspectorBodyClass}>
        {playhead !== null ? (
          <p className="mb-2 text-[11px] text-muted-foreground">
            Recorded at {formatSimTime(playhead)}
          </p>
        ) : null}
        {editError ? (
          <p className="mb-2 break-words text-[12px] text-error">{editError}</p>
        ) : null}
        {wire && ends ? (
          <>
            <Field label="From" value={ends.a} />
            <Field label="To" value={ends.b} />
          </>
        ) : node ? (
          <InstanceBody
            node={node}
            link={selection?.link}
            outline={outline}
            warnings={instanceWarnings(warnings, node.id)}
            rootPart={tree?.part}
          />
        ) : (
          <>
            {tree ? (
              <PlayFields play={tree.play} />
            ) : (
              <p className="text-[12px] text-muted-foreground">
                Reading the world…
              </p>
            )}
            {accuracy ? <AccuracyBlock view={accuracy} summary /> : null}
            {tree ? (
              <RenamePartFile
                name={partFileName(tree.part)}
                source={openSource}
                rootPart={tree.part}
              />
            ) : null}
            <WarningList
              rows={
                lone
                  ? [
                      ...documentWarnings(warnings),
                      ...instanceWarnings(warnings, lone.id),
                    ]
                  : documentWarnings(warnings)
              }
            />
          </>
        )}
      </div>
    </Shell>
  );
}
