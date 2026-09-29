/**
 * The world tool mode. One at a time; Select is the default. A tool is a
 * mode on the stage that commits ordinary edit ops (D1), so nothing here
 * touches the document. Wire and Probe join as more modes.
 */

import { type ParkChoice, type ParkPhase, parkGuard } from "@/lib/world-park";

export type WorldToolMode = "select" | "move" | "rotate";

export type WorldToolState = {
  mode: WorldToolMode;
  /** A drag is in progress. Esc cancels it before it leaves the tool. */
  gesture: boolean;
};

export const WORLD_TOOL_START: WorldToolState = {
  mode: "select",
  gesture: false,
};

export type WorldToolAction =
  | { type: "pick"; mode: WorldToolMode }
  | { type: "begin" }
  | { type: "end" }
  /** The document closed or reloaded under the gesture. */
  | { type: "reset" };

export function reduceWorldTool(
  state: WorldToolState,
  action: WorldToolAction
): WorldToolState {
  switch (action.type) {
    case "pick":
      if (state.mode === action.mode && !state.gesture) return state;
      return { mode: action.mode, gesture: false };
    case "begin":
      return state.gesture ? state : { ...state, gesture: true };
    case "end":
      return state.gesture ? { ...state, gesture: false } : state;
    case "reset":
      return WORLD_TOOL_START;
  }
}

/**
 * What Esc does. A gesture in progress is cancelled first, then the tool
 * is left for Select. In Select with no gesture Esc is not ours, and the
 * selection clear takes it.
 */
export function toolEscape(state: WorldToolState): {
  state: WorldToolState;
  did: "cancel-gesture" | "leave-tool" | null;
} {
  if (state.gesture) {
    return { state: { ...state, gesture: false }, did: "cancel-gesture" };
  }
  if (state.mode !== "select") {
    return { state: { mode: "select", gesture: false }, did: "leave-tool" };
  }
  return { state, did: null };
}

export function toolLabel(mode: WorldToolMode): string {
  if (mode === "move") return "Move";
  if (mode === "rotate") return "Rotate";
  return "Select";
}

/**
 * Every tool commit restarts the run, so a playing run asks first, with
 * the park dialog's guard. A paused or idle run commits without asking.
 */
export function toolCommitGuard(phase: ParkPhase): "ask" | "go" {
  return parkGuard(phase);
}

/** Stay drops the gesture. Stop pauses, then applies it. */
export function toolCommitOutcome(
  choice: ParkChoice
): "drop" | "stop-and-apply" {
  return choice === "stay" ? "drop" : "stop-and-apply";
}
