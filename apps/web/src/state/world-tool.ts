/**
 * The world tool mode and the commit a tool is waiting to make. The
 * transitions are pure (`lib/world-tool.ts`); this holds them for the stage,
 * the toolbar and the Esc key. `state/viewer.ts` stays the CAD tool state.
 */

import type { EditOp } from "@sfab-bench/contract";
import { useStore as useZustandStore } from "zustand";
import { createStore } from "zustand/vanilla";

import { sendWorldCommand, sendWorldEdit } from "@/hooks/useWorldRun";
import { type ParkChoice, parkGuard, parkOutcome } from "@/lib/world-park";
import {
  reduceWorldTool,
  toolEscape,
  WORLD_TOOL_START,
  type WorldToolMode,
  type WorldToolState,
} from "@/lib/world-tool";
import { type WireTap, wireCommit, wireStep } from "@/lib/world-wire";
import { clearPreviews, previewPose } from "@/scene/world-preview";
import { phaseNow } from "@/state/part-tabs";
import { worldStore } from "@/state/world";

export type ToolCommit = {
  ops: EditOp[];
  part?: string;
  label: string;
  /** Run path of the previewed instance, put back on Stay. */
  previewPath?: string;
};

type WorldToolStore = WorldToolState & {
  pending: ToolCommit | null;
  /** Counts Stay choices, so a card field drops the value that was refused. */
  stays: number;
  /** The first port of a wire, held until the second is picked. */
  wireFrom: string | null;
};

export const worldToolStore = createStore<WorldToolStore>()(() => ({
  ...WORLD_TOOL_START,
  pending: null,
  stays: 0,
  wireFrom: null,
}));

export function useWorldTool<T>(selector: (state: WorldToolStore) => T): T {
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

function holdWire(ref: string) {
  worldToolStore.setState({ wireFrom: ref });
  beginToolGesture(() => worldToolStore.setState({ wireFrom: null }));
}

function dropWire() {
  worldToolStore.setState({ wireFrom: null });
  endToolGesture();
}

function stepWire(tap: WireTap) {
  const state = worldToolStore.getState();
  if (state.mode !== "wire" || state.pending) return;
  const next = wireStep(state.wireFrom, tap);
  if (next.hold !== state.wireFrom) {
    if (next.hold === null) dropWire();
    else holdWire(next.hold);
  }
  if (next.commit) {
    commitToolEdit(wireCommit(next.commit, worldStore.getState().path));
  }
}

/** A click on a port marker: the first port holds, the second commits. */
export function tapWirePort(ref: string) {
  stepWire({ type: "port", ref });
}

/** A click on anything that is not a port lets go of a held first port. */
export function tapWireEmpty() {
  if (worldToolStore.getState().wireFrom === null) return;
  stepWire({ type: "empty" });
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

/**
 * A tool commit is an ordinary edit. A playing run asks first, because an
 * edit restarts it; a paused or idle run commits without asking.
 */
export function commitToolEdit(commit: ToolCommit) {
  if (parkGuard(phaseNow()) === "ask") {
    worldToolStore.setState({ pending: commit });
    return;
  }
  sendToolEdit(commit);
}

function sendToolEdit(commit: ToolCommit) {
  sendWorldEdit({ ops: commit.ops, part: commit.part, label: commit.label });
}

function answerToolCommit(choice: ParkChoice) {
  const pending = worldToolStore.getState().pending;
  if (!pending) return;
  if (parkOutcome(choice) === "stay") {
    worldToolStore.setState((s) => ({ pending: null, stays: s.stays + 1 }));
    if (pending.previewPath) previewPose(pending.previewPath, null);
    else clearPreviews();
    return;
  }
  worldToolStore.setState({ pending: null });
  sendWorldCommand("pause");
  sendToolEdit(pending);
}

export function stayToolCommit() {
  answerToolCommit("stay");
}

export function stopToolCommit() {
  answerToolCommit("stop");
}

function resetWorldTool() {
  // A drag in flight must let go of its window listeners and the orbit.
  const cancel = cancelGesture;
  cancelGesture = null;
  cancel?.();
  apply({ type: "reset" });
  if (worldToolStore.getState().pending) {
    worldToolStore.setState({ pending: null });
  }
  clearPreviews();
}

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
