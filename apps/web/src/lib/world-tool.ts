/**
 * The world tool mode. One at a time; Select is the default. A tool is a
 * mode on the stage that commits ordinary edit ops (D1), so nothing here
 * touches the document.
 *
 * `WORLD_TOOLS` is the one list of tools (ADR 0012, Tools seam). The mode
 * type, the toolbar, the tool keys and the group helpers all read it. A new
 * tool is one entry here, plus its own layer and state. It is a compile-time
 * table, not a registry.
 */

import {
  Activity,
  Cable,
  type LucideIcon,
  MousePointer2,
  Move3d,
  Rotate3d,
} from "lucide-react";

/**
 * `select` is the default. `pose` tools act on the selection through the
 * gizmo. `port` tools draw the port markers, and a marker wins over a body.
 */
export type WorldToolGroup = "select" | "pose" | "port";

type WorldToolDef = {
  mode: string;
  label: string;
  group: WorldToolGroup;
  /** A bare key that toggles the tool. Lower case; shown upper case. */
  hotkey?: string;
  icon: LucideIcon;
};

/** Toolbar order. */
export const WORLD_TOOLS = [
  { mode: "select", label: "Select", group: "select", icon: MousePointer2 },
  { mode: "move", label: "Move", group: "pose", icon: Move3d },
  { mode: "rotate", label: "Rotate", group: "pose", icon: Rotate3d },
  { mode: "wire", label: "Wire", group: "port", hotkey: "w", icon: Cable },
  { mode: "probe", label: "Probe", group: "port", icon: Activity },
] as const satisfies readonly WorldToolDef[];

export type WorldToolMode = (typeof WORLD_TOOLS)[number]["mode"];

const TOOL_BY_MODE: ReadonlyMap<WorldToolMode, WorldToolDef> = new Map(
  WORLD_TOOLS.map((tool) => [tool.mode, tool])
);

function toolDef(mode: WorldToolMode): WorldToolDef {
  const tool = TOOL_BY_MODE.get(mode);
  if (!tool) throw new Error(`unknown tool mode: ${mode}`);
  return tool;
}

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
  return toolDef(mode).group === "pose";
}

/** Wire and Probe draw the port markers, and a marker wins over a body there. */
export function isPortTool(mode: WorldToolMode): boolean {
  return toolDef(mode).group === "port";
}

export function toolLabel(mode: WorldToolMode): string {
  return toolDef(mode).label;
}

/** The toolbar tooltip: the label, and the key when the tool has one. */
export function toolTitle(mode: WorldToolMode): string {
  const { label, hotkey } = toolDef(mode);
  return hotkey ? `${label} (${hotkey.toUpperCase()})` : label;
}

/** The tool a bare key toggles, or null. Case does not matter. */
export function toolForKey(key: string): WorldToolMode | null {
  const lower = key.toLowerCase();
  const tool = WORLD_TOOLS.find(
    (item) => "hotkey" in item && item.hotkey === lower
  );
  return tool ? tool.mode : null;
}
