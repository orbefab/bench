/**
 * The world tool mode. One at a time; Select is the default. A tool is a
 * mode on the stage that commits ordinary edit ops (D1), so nothing here
 * touches the document. Probe joins as one more mode.
 */

export type WorldToolMode = "select" | "move" | "rotate" | "wire" | "probe";

export type WorldToolState = {
  mode: WorldToolMode;
  /** A drag or a held first port is in progress. Esc cancels it before it leaves the tool. */
  gesture: boolean;
};

export const WORLD_TOOL_START: WorldToolState = {
  mode: "select",
  gesture: false,
};

export type WorldToolAction =
  | { type: "pick"; mode: WorldToolMode }
  /** A key that enters a tool, and leaves it when it is already the tool. */
  | { type: "toggle"; mode: WorldToolMode }
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
    case "toggle":
      return {
        mode: state.mode === action.mode ? "select" : action.mode,
        gesture: false,
      };
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

/** Move and Rotate act on the selection through the gizmo; Wire does not. */
export function isPoseTool(mode: WorldToolMode): boolean {
  return mode === "move" || mode === "rotate";
}

/** Wire and Probe draw the port markers, and a marker wins over a body there. */
export function isPortTool(mode: WorldToolMode): boolean {
  return mode === "wire" || mode === "probe";
}

export function toolLabel(mode: WorldToolMode): string {
  if (mode === "move") return "Move";
  if (mode === "rotate") return "Rotate";
  if (mode === "wire") return "Wire";
  if (mode === "probe") return "Probe";
  return "Select";
}
