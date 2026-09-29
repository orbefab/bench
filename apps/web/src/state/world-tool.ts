/**
 * The world tool mode and the commit a tool is waiting to make. The
 * transitions are pure (`lib/world-tool.ts`); this holds them for the stage,
 * the toolbar and the Esc key. `state/viewer.ts` stays the CAD tool state.
 */

import type { EditOp } from "@sfab-bench/contract";
import { useStore as useZustandStore } from "zustand";
import { createStore } from "zustand/vanilla";

import {
  reduceWorldTool,
  toolEscape,
  WORLD_TOOL_START,
  type WorldToolMode,
  type WorldToolState,
} from "@/lib/world-tool";
import { invalidateSceneNow } from "@/scene/invalidate";
import { clearPreviews } from "@/scene/world-preview";
import { worldStore } from "@/state/world";
import { commitEdit, dropPendingEdit } from "@/state/world-edit";

export type ToolCommit = {
  ops: EditOp[];
  part?: string;
  label: string;
  /** Run path of the previewed instance, put back on Stay. */
  previewPath?: string;
};

export const worldToolStore = createStore<WorldToolState>()(() => ({
  ...WORLD_TOOL_START,
}));

export function useWorldTool<T>(selector: (state: WorldToolState) => T): T {
  return useZustandStore(worldToolStore, selector);
}

/** Puts the stage back when a gesture is cancelled mid-drag. */
let cancelGesture: (() => void) | null = null;

function apply(action: Parameters<typeof reduceWorldTool>[1]) {
  const state = worldToolStore.getState();
  const next = reduceWorldTool(state, action);
  if (next.mode === state.mode && next.gesture === state.gesture) return;
  worldToolStore.setState({ mode: next.mode, gesture: next.gesture });
}

export function pickWorldTool(mode: WorldToolMode) {
  if (worldToolStore.getState().gesture) cancelWorldGesture();
  apply({ type: "pick", mode });
}

/** W: enter the tool, or leave it when it is already the tool. */
export function toggleWorldTool(mode: WorldToolMode) {
  if (worldToolStore.getState().gesture) cancelWorldGesture();
  apply({ type: "toggle", mode });
}

export function beginToolGesture(cancel: () => void) {
  cancelGesture = cancel;
  apply({ type: "begin" });
}

export function endToolGesture() {
  cancelGesture = null;
  apply({ type: "end" });
}

function cancelWorldGesture() {
  const cancel = cancelGesture;
  cancelGesture = null;
  cancel?.();
  apply({ type: "end" });
}

/** True when Esc was ours. The selection clear runs only when it was not. */
export function escapeWorldTool(): boolean {
  const state = worldToolStore.getState();
  const { did } = toolEscape(state);
  if (did === "cancel-gesture") {
    cancelWorldGesture();
    return true;
  }
  if (did === "leave-tool") {
    apply({ type: "pick", mode: "select" });
    return true;
  }
  return false;
}

/** A tool commit is an ordinary edit: `commitEdit` decides whether to ask. */
export function commitToolEdit(commit: ToolCommit) {
  const { ops, ...request } = commit;
  commitEdit(ops, request);
}

function resetWorldTool() {
  // A drag in flight must let go of its window listeners and the orbit.
  const cancel = cancelGesture;
  cancelGesture = null;
  cancel?.();
  apply({ type: "reset" });
  dropPendingEdit();
  clearPreviews();
}

// The canvas draws on demand: a new tool must ask for a frame, or the
// previous tool's markers stay on screen.
worldToolStore.subscribe((state, prev) => {
  if (state.mode !== prev.mode) invalidateSceneNow();
});

let watchedPath = worldStore.getState().path;
let watchedLoad = worldStore.getState().loadId;
let watchedError = worldStore.getState().editError;
worldStore.subscribe((state) => {
  if (state.path !== watchedPath || state.loadId !== watchedLoad) {
    const documentChanged = state.path !== watchedPath;
    watchedPath = state.path;
    watchedLoad = state.loadId;
    if (documentChanged) resetWorldTool();
  }
  if (state.editError !== watchedError) {
    watchedError = state.editError;
    if (state.editError) clearPreviews();
  }
});
