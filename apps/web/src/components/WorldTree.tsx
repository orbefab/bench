import type { WorldViewNode } from "@sfab-bench/contract";
import { CircleAlert } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";

import { fileLabel } from "@/cad/loadCadReview";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  breakWorldEdit,
  sendWorldCommand,
  sendWorldEdit,
  sendWorldRedo,
  sendWorldUndo,
  stayWorldEdit,
} from "@/hooks/useWorldRun";
import { isEditableTarget } from "@/lib/shortcuts";
import { confirmActions, confirmLines } from "@/lib/world-confirm";
import { instanceEditTarget, wireEditTarget } from "@/lib/world-edit-target";
import { historyButtons } from "@/lib/world-history";
import { editorKeyAction } from "@/lib/world-keys";
import { findViewNode, nextCollapse, treeRows } from "@/lib/world-tree";
import {
  instanceWarningMap,
  warnedPaths,
  warningsFromRun,
  warningText,
} from "@/lib/world-warnings";
import { useWorld, worldStore } from "@/state/world";

export function WorldTopBar() {
  const path = useWorld((s) => s.path);
  const part = useWorld((s) => s.tree?.part ?? "");
  const history = useWorld((s) => s.history);
  const buttons = historyButtons(history);
  const label = useWorld((s) => s.editLabel);
  const name = fileLabel(path);
  return (
    <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
      <span
        className="max-w-64 truncate text-sm font-medium"
        title={part || name}
      >
        {name}
      </span>
      <div className="min-w-0 flex-1" />
      {label ? (
        <span className="hidden truncate text-xs text-muted-foreground sm:inline">
          {label}
        </span>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        disabled={!buttons.canUndo}
        onClick={() => sendWorldUndo()}
      >
        Undo
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        disabled={!buttons.canRedo}
        onClick={() => sendWorldRedo()}
      >
        Redo
      </Button>
    </header>
  );
}

export function WorldHotkeys() {
  const path = useWorld((s) => s.path);
  useEffect(() => {
    if (!path) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const typing = isEditableTarget(event.target, document.activeElement);
      const action = editorKeyAction(
        {
          key: event.key,
          meta: event.metaKey,
          ctrl: event.ctrlKey,
          shift: event.shiftKey,
          alt: event.altKey,
        },
        typing
      );
      if (!action) return;
      const target = event.target;
      const tag =
        target && typeof target === "object" && "tagName" in target
          ? String(target.tagName)
          : "";
      if (action === "play" && (tag === "BUTTON" || tag === "A")) return;
      event.preventDefault();
      const state = worldStore.getState();
      if (action === "undo") sendWorldUndo();
      else if (action === "redo") sendWorldRedo();
      else if (action === "play") {
        if (state.runErrors.length > 0) return;
        sendWorldCommand(state.playing ? "pause" : "play");
      } else if (action === "rename") {
        state.requestRename();
      } else if (action === "delete" && !state.confirm) {
        deleteSelection();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [path]);
  return null;
}

function deleteSelection() {
  const state = worldStore.getState();
  const tree = state.tree;
  if (!tree) return;
  if (state.wire) {
    const target = wireEditTarget(tree, state.wire.owner, state.wire.index);
    if (!target) return;
    sendWorldEdit({
      part: target.part,
      ops: [
        {
          kind: "unwire",
          document: target.document,
          a: target.a,
          b: target.b,
        },
      ],
    });
    return;
  }
  if (!state.selection || state.selection.path === "$root") return;
  const target = instanceEditTarget(tree, state.selection.path);
  if (!target) return;
  sendWorldEdit({
    part: target.part,
    ops: [
      {
        kind: "remove-instance",
        document: target.document,
        id: target.id,
      },
    ],
  });
}

export function WorldConfirmDialog() {
  const confirm = useWorld((s) => s.confirm);
  if (!confirm) return null;
  const lines = confirmLines(confirm);
  const actions = confirmActions(confirm);
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) stayWorldEdit();
      }}
    >
      <AlertDialogContent>
        <AlertDialogTitle>This edit drops fixed ports</AlertDialogTitle>
        <AlertDialogDescription>{confirm.message}</AlertDialogDescription>
        <ul className="mt-3 space-y-2 text-sm">
          {lines.map((line) => (
            <li key={line.port}>
              <span className="font-mono">{line.port}</span>
              <span className="text-muted-foreground">
                {" "}
                — {line.dependents}
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => stayWorldEdit()}
          >
            Stay
          </Button>
          <Button type="button" onClick={() => breakWorldEdit()}>
            {actions.breakLabel}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function WorldTree() {
  const tree = useWorld((s) => s.tree);
  const selection = useWorld((s) => s.selection);
  const wire = useWorld((s) => s.wire);
  const report = useWorld((s) => s.report);
  const diagnostics = useWorld((s) => s.diagnostics);
  const renameTick = useWorld((s) => s.renameTick);
  const path = useWorld((s) => s.path);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [seededPath, setSeededPath] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const grouped = useMemo(
    () => instanceWarningMap(warningsFromRun(report, diagnostics)),
    [report, diagnostics]
  );
  const warnings = useMemo(() => warnedPaths(grouped), [grouped]);
  const rows = useMemo(
    () => (tree ? treeRows(tree.nodes, warnings, collapsed) : []),
    [tree, warnings, collapsed]
  );
  useLayoutEffect(() => {
    if (!tree || !path) return;
    const target = wire ? wire.owner : (selection?.path ?? null);
    const kind = wire ? "wire" : "instance";
    setCollapsed((current) => {
      const step = nextCollapse({
        collapsed: current,
        nodes: tree.nodes,
        documentPath: path,
        seededPath,
        target,
        kind,
      });
      return step.wrote ? step.collapsed : current;
    });
    if (seededPath !== path) setSeededPath(path);
  }, [tree, path, seededPath, selection?.path, wire]);
  useEffect(() => {
    if (renameTick === 0) return;
    const path = worldStore.getState().selection?.path;
    if (!path || path === "$root") return;
    setRenaming(path);
  }, [renameTick]);

  return (
    <nav
      aria-label="Part tree"
      className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-card"
    >
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {rows.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            Reading the world…
          </p>
        ) : (
          rows.map((row) => {
            const node = tree ? findViewNode(tree.nodes, row.path) : null;
            const selected =
              row.kind === "wire"
                ? wire?.owner === row.path && wire.index === row.wireIndex
                : selection?.path === row.path && !wire;
            const warned = row.warning || row.collapsedWarning;
            const why = row.warning
              ? warningText(grouped.get(row.path) ?? [])
              : row.collapsedWarning
                ? "A part inside has a warning"
                : "";
            const canFold =
              row.kind === "instance" &&
              node !== null &&
              (node.children.length > 0 || (node.wires?.length ?? 0) > 0);
            return (
              <div
                key={row.key}
                className={
                  selected
                    ? "flex items-center gap-1 bg-muted px-1 py-0.5"
                    : "flex items-center gap-1 px-1 py-0.5 hover:bg-muted/60"
                }
                style={{ paddingLeft: 8 + row.depth * 12 }}
              >
                {canFold ? (
                  <button
                    type="button"
                    className="w-3 shrink-0 text-[10px] text-muted-foreground"
                    aria-label={collapsed.has(row.path) ? "Expand" : "Collapse"}
                    onClick={() => {
                      const next = new Set(collapsed);
                      if (next.has(row.path)) next.delete(row.path);
                      else next.add(row.path);
                      setCollapsed(next);
                    }}
                  >
                    {collapsed.has(row.path) ? "▸" : "▾"}
                  </button>
                ) : (
                  <span className="w-3 shrink-0" />
                )}
                {renaming === row.path && row.kind === "instance" ? (
                  <RenameField node={node} onDone={() => setRenaming(null)} />
                ) : (
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left text-[13px]"
                    onClick={() => {
                      if (row.kind === "wire" && row.wireIndex !== undefined) {
                        worldStore.getState().selectWire({
                          owner: row.path,
                          index: row.wireIndex,
                        });
                        return;
                      }
                      worldStore.getState().select({
                        kind: "instance",
                        path: row.path,
                      });
                    }}
                    onDoubleClick={() => {
                      if (row.kind !== "instance" || row.path === "$root")
                        return;
                      setRenaming(row.path);
                    }}
                  >
                    {row.name}
                  </button>
                )}
                {warned ? (
                  <span title={why} className="shrink-0">
                    <CircleAlert
                      className="size-3 text-amber-700 dark:text-amber-400"
                      aria-label={why}
                    />
                  </span>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </nav>
  );
}

function RenameField({
  node,
  onDone,
}: {
  node: WorldViewNode | null;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(node?.name ?? "");
  return (
    <input
      className="min-w-0 flex-1 rounded border border-border bg-background px-1 text-[13px]"
      value={draft}
      autoFocus
      onChange={(event) => setDraft(event.target.value)}
      onBlur={onDone}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onDone();
          return;
        }
        if (event.key !== "Enter") return;
        event.preventDefault();
        const tree = worldStore.getState().tree;
        const path = node?.id;
        if (!tree || !path) {
          onDone();
          return;
        }
        const target = instanceEditTarget(tree, path);
        const to = draft.trim();
        if (!target || !to || to === node?.name) {
          onDone();
          return;
        }
        sendWorldEdit({
          part: target.part,
          ops: [
            {
              kind: "rename-instance",
              document: target.document,
              id: target.id,
              to,
            },
          ],
        });
        onDone();
      }}
    />
  );
}
