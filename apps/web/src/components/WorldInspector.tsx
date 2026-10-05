import type { WorldViewNode } from "@sfab-bench/contract";
import { useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
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

export function WorldInspector() {
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
  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-l border-border bg-card">
      <header className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <span className="truncate text-[13px] font-medium">{title}</span>
        {selection || wire ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground"
            onClick={() => {
              worldStore.getState().select(null);
              worldStore.getState().selectWire(null);
            }}
          >
            Clear
          </Button>
        ) : null}
      </header>
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
    </aside>
  );
}
