import { ROOT_PATH, type WorldViewNode } from "@sfab-bench/contract";
import {
  ChevronRight,
  CircleAlert,
  ListTree,
  Minus,
  Search,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  sendWorldCommand,
  sendWorldRedo,
  sendWorldUndo,
  stayWorldEdit,
} from "@/hooks/useWorldRun";
import {
  activeEscLayer,
  isEditableTarget,
  matchesShortcut,
  popupChatOwnsEscape,
  probeEscLayers,
} from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import {
  confirmActions,
  confirmBody,
  confirmLines,
  confirmTitle,
} from "@/lib/world-confirm";
import { instanceEditTarget, wireEditTarget } from "@/lib/world-edit-target";
import { editorKeyAction } from "@/lib/world-keys";
import { removeInstanceOp, renameInstanceOp, unwireOp } from "@/lib/world-ops";
import {
  filterTreeRows,
  findViewNode,
  nextCollapse,
  treeRows,
} from "@/lib/world-tree";
import {
  instanceWarningMap,
  warnedPaths,
  warningsFromRun,
  warningText,
} from "@/lib/world-warnings";
import { useWorld, worldStore } from "@/state/world";
import { breakWorldEdit, commitEdit, worldEditStore } from "@/state/world-edit";
import { escapeWorldTool, toggleWorldTool } from "@/state/world-tool";
import { useTreeFold, writeTreeFold } from "@/state/world-tree-fold";

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
      if (typeof action !== "string") {
        // A held key does not flicker the tool, and a question waits for its answer.
        if (event.repeat || worldEditStore.getState().pending) return;
        event.preventDefault();
        toggleWorldTool(action.tool);
        return;
      }
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
  // Capture phase and preventDefault: a tool takes Esc before the selection
  // clear, and no other layer is open (those keep Esc).
  useEffect(() => {
    if (!path) return;
    const onEsc = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (
        !matchesShortcut(event, "world-tool-escape", {
          mac: false,
          activeElement: document.activeElement,
        })
      ) {
        return;
      }
      const layers = {
        ...probeEscLayers(document),
        popupChat: popupChatOwnsEscape(document),
      };
      if (activeEscLayer(layers)) return;
      if (escapeWorldTool()) event.preventDefault();
    };
    window.addEventListener("keydown", onEsc, true);
    return () => window.removeEventListener("keydown", onEsc, true);
  }, [path]);
  return null;
}

function deleteSelection() {
  const state = worldStore.getState();
  const tree = state.tree;
  if (!tree) return;
  if (state.wire) {
    const target = wireEditTarget(
      tree,
      state.wire.owner,
      state.wire.index,
      state.path
    );
    if (!target) return;
    commitEdit([unwireOp(target)], { part: target.part });
    return;
  }
  if (!state.selection || state.selection.path === ROOT_PATH) return;
  const target = instanceEditTarget(tree, state.selection.path, state.path);
  if (!target) return;
  commitEdit([removeInstanceOp(target)], { part: target.part });
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
        <AlertDialogTitle>{confirmTitle(confirm.ops)}</AlertDialogTitle>
        <AlertDialogDescription>
          {confirmBody(confirm.ops, confirm)}
        </AlertDialogDescription>
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

const TREE_INDENT = 12;
const TWISTIE = 16;

function IndentGuides({ depth }: { depth: number }) {
  if (depth === 0) return null;
  return Array.from({ length: depth }, (_, level) => (
    <span
      key={level}
      aria-hidden
      className="pointer-events-none absolute inset-y-0 w-px -translate-x-1/2 bg-border"
      style={{ left: level * TREE_INDENT + TWISTIE / 2 }}
    />
  ));
}

export function WorldTree({ floating = false }: { floating?: boolean }) {
  const tree = useWorld((s) => s.tree);
  const selection = useWorld((s) => s.selection);
  const wire = useWorld((s) => s.wire);
  const report = useWorld((s) => s.report);
  const diagnostics = useWorld((s) => s.diagnostics);
  const renameTick = useWorld((s) => s.renameTick);
  const path = useWorld((s) => s.path);
  const fold = useTreeFold();
  const collapsed = fold.collapsed;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState(false);
  const grouped = useMemo(
    () => instanceWarningMap(warningsFromRun(report, diagnostics)),
    [report, diagnostics]
  );
  const warnings = useMemo(() => warnedPaths(grouped), [grouped]);
  const queryActive = floating && query.trim().length > 0;
  const rows = useMemo(() => {
    if (!tree) return [];
    const source = treeRows(
      tree.nodes,
      warnings,
      queryActive ? new Set<string>() : collapsed
    );
    return queryActive ? filterTreeRows(source, query) : source;
  }, [tree, warnings, collapsed, query, queryActive]);
  useLayoutEffect(() => {
    if (!tree || !path) return;
    const target = wire ? wire.owner : (selection?.path ?? null);
    const kind = wire ? "wire" : "instance";
    const step = nextCollapse({
      collapsed,
      nodes: tree.nodes,
      documentPath: path,
      seededPath: fold.seededPath,
      target,
      kind,
    });
    if (step.wrote || step.seededPath !== fold.seededPath) {
      writeTreeFold({
        collapsed: step.collapsed,
        seededPath: step.seededPath,
      });
    }
  }, [tree, path, fold, collapsed, selection?.path, wire]);
  useEffect(() => {
    if (renameTick === 0) return;
    const path = worldStore.getState().selection?.path;
    if (!path || path === ROOT_PATH) return;
    setRenaming(path);
  }, [renameTick]);

  const toggleFold = (rowPath: string) => {
    const next = new Set(collapsed);
    if (next.has(rowPath)) next.delete(rowPath);
    else next.add(rowPath);
    writeTreeFold({ collapsed: next, seededPath: fold.seededPath });
  };

  if (floating && closed) {
    return (
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        className="pointer-events-auto size-9 self-start rounded-xl border-border bg-background shadow-lg"
        aria-label="Show parts"
        title="Show parts"
        onClick={() => setClosed(false)}
      >
        <ListTree />
      </Button>
    );
  }

  const list =
    rows.length === 0 ? (
      <p
        className={
          floating
            ? "px-2 py-1.5 text-sm text-muted-foreground"
            : "px-3 py-2 text-xs text-muted-foreground"
        }
      >
        {queryActive ? "No parts" : "Reading the world…"}
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
        const folded = !queryActive && collapsed.has(row.path);
        return (
          <div
            key={row.key}
            className={
              floating
                ? cn(
                    "relative flex h-7 items-center gap-1 rounded-md pr-2 text-sm",
                    selected
                      ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                      : "hover:bg-sidebar-accent/60"
                  )
                : selected
                  ? "flex items-center gap-1 bg-muted px-1 py-0.5"
                  : "flex items-center gap-1 px-1 py-0.5 hover:bg-muted/60"
            }
            style={{
              paddingLeft: floating
                ? row.depth * TREE_INDENT
                : 8 + row.depth * 12,
            }}
          >
            {floating ? <IndentGuides depth={row.depth} /> : null}
            {canFold ? (
              <button
                type="button"
                className={
                  floating
                    ? "flex size-4 shrink-0 items-center justify-center text-muted-foreground"
                    : "w-3 shrink-0 text-[10px] text-muted-foreground"
                }
                aria-label={folded ? "Expand" : "Collapse"}
                onClick={() => toggleFold(row.path)}
              >
                {floating ? (
                  <ChevronRight
                    className={cn(
                      "size-2.5 transition-[rotate] duration-150",
                      !folded && "rotate-90"
                    )}
                  />
                ) : folded ? (
                  "▸"
                ) : (
                  "▾"
                )}
              </button>
            ) : (
              <span className={floating ? "size-4 shrink-0" : "w-3 shrink-0"} />
            )}
            {renaming === row.path && row.kind === "instance" ? (
              <RenameField node={node} onDone={() => setRenaming(null)} />
            ) : (
              <button
                type="button"
                className={
                  floating
                    ? "min-w-0 flex-1 truncate text-left"
                    : "min-w-0 flex-1 truncate text-left text-[13px]"
                }
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
                  if (row.kind !== "instance" || row.path === ROOT_PATH) return;
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
    );

  if (!floating) {
    return (
      <nav
        aria-label="Part tree"
        className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-card"
      >
        <div className="min-h-0 flex-1 overflow-auto py-1">{list}</div>
      </nav>
    );
  }

  return (
    <nav
      aria-label="Part tree"
      data-slot="world-tree"
      className="pointer-events-auto flex max-h-[45%] min-h-0 shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-lg"
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-1.5 py-1.5">
        <Search className="ml-1 size-3.5 shrink-0 text-muted-foreground" />
        <input
          aria-label="Filter parts"
          className="h-7 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          placeholder="Filter..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Minimize parts"
          title="Minimize"
          onClick={() => setClosed(true)}
        >
          <Minus />
        </Button>
      </div>
      <div role="tree" className="min-h-0 overflow-y-auto p-1">
        {list}
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
        const target = instanceEditTarget(
          tree,
          path,
          worldStore.getState().path
        );
        const op = target
          ? renameInstanceOp(target, node?.name ?? "", draft)
          : null;
        if (target && op) commitEdit([op], { part: target.part });
        onDone();
      }}
    />
  );
}
