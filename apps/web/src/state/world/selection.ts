import type { WorldViewTree } from "@sfab-bench/contract";

import { findViewNode, viewPaths } from "@/lib/world-tree";
import type {
  WorldSelection,
  WorldSelectionAction,
  WorldSlice,
  WorldWirePick,
} from "./types";

export function sameWorldSelection(
  a: WorldSelection,
  b: WorldSelection
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.path === b.path && (a.link ?? "") === (b.link ?? "");
}

/** Select, drop on close, or keep a selection only when the reload still has its path. */
export function reduceWorldSelection(
  selection: WorldSelection,
  action: WorldSelectionAction
): WorldSelection {
  if (action.type === "close") return null;
  if (action.type === "select") {
    return sameWorldSelection(selection, action.selection)
      ? selection
      : action.selection;
  }
  if (!selection) return null;
  return action.paths.includes(selection.path) ? selection : null;
}

function keptWire(
  tree: WorldViewTree,
  wire: WorldWirePick | null
): WorldWirePick | null {
  if (!wire) return null;
  const node = findViewNode(tree.nodes, wire.owner);
  const count = node?.wires?.length ?? 0;
  if (wire.index < 0 || wire.index >= count) return null;
  return wire;
}

/** This client's pick, the wire row, the outline, the tree, and F2 rename. */
export const selectionSlice: WorldSlice<
  "select" | "selectWire" | "setOutline" | "setTree" | "requestRename"
> = (set, get) => ({
  select: (selection) => {
    const next = reduceWorldSelection(get().selection, {
      type: "select",
      selection,
    });
    if (next === get().selection && get().wire === null) return;
    set({ selection: next, wire: null, editError: null });
  },
  selectWire: (wire) => {
    if (!wire) {
      if (get().wire === null) return;
      set({ wire: null });
      return;
    }
    set({ wire, selection: null, editError: null });
  },
  setOutline: (outline) => {
    set({ outline });
  },
  setTree: (tree) => {
    const current = get();
    if (current.tree === tree) return;
    const paths = tree ? viewPaths(tree.nodes) : null;
    const selection =
      paths === null
        ? current.selection
        : reduceWorldSelection(current.selection, { type: "reload", paths });
    const wire = selection || !tree ? null : keptWire(tree, current.wire);
    set({ tree, selection, wire });
  },
  requestRename: () => {
    set((state) => ({ renameTick: state.renameTick + 1 }));
  },
});
