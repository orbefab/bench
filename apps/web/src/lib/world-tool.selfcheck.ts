import { ok as expect } from "node:assert/strict";
import { parkGuard, parkOutcome } from "./world-park";
import {
  isPortTool,
  isPoseTool,
  reduceWorldTool,
  toolEscape,
  toolForKey,
  toolLabel,
  toolTitle,
  WORLD_TOOL_START,
  WORLD_TOOLS,
  type WorldToolMode,
} from "./world-tool";

expect(WORLD_TOOL_START.mode === "select", "Select is the default");
expect(!WORLD_TOOL_START.gesture, "no gesture at the start");

const moved = reduceWorldTool(WORLD_TOOL_START, { type: "pick", mode: "move" });
expect(moved.mode === "move", "a button picks Move");
const rotated = reduceWorldTool(moved, { type: "pick", mode: "rotate" });
expect(rotated.mode === "rotate", "one mode at a time: Rotate replaces Move");
expect(
  reduceWorldTool(rotated, { type: "pick", mode: "rotate" }) === rotated,
  "picking the active mode changes nothing"
);
expect(
  reduceWorldTool(rotated, { type: "pick", mode: "select" }).mode === "select",
  "the Select button leaves the tool"
);

const dragging = reduceWorldTool(moved, { type: "begin" });
expect(dragging.gesture && dragging.mode === "move", "a drag begins");
expect(
  reduceWorldTool(dragging, { type: "begin" }) === dragging,
  "a second begin changes nothing"
);
expect(!reduceWorldTool(dragging, { type: "end" }).gesture, "a drag ends");
expect(
  reduceWorldTool(dragging, { type: "end" }).mode === "move",
  "a finished drag stays in the tool"
);
expect(
  !reduceWorldTool(dragging, { type: "pick", mode: "rotate" }).gesture,
  "picking a tool drops a drag"
);
expect(
  reduceWorldTool(dragging, { type: "reset" }) === WORLD_TOOL_START,
  "a closed document resets the tool"
);

// Esc: the gesture first, then the tool, then it is the selection's.
const first = toolEscape(dragging);
expect(first.did === "cancel-gesture", "Esc cancels a drag first");
expect(
  first.state.mode === "move" && !first.state.gesture,
  "cancelling a drag stays in the tool"
);
const second = toolEscape(first.state);
expect(second.did === "leave-tool", "the next Esc leaves the tool");
expect(second.state.mode === "select", "leaving the tool returns to Select");
const third = toolEscape(second.state);
expect(third.did === null, "in Select Esc is left to the selection clear");
expect(third.state === second.state, "an unclaimed Esc changes nothing");

// Wire is one more mode. W enters it and W again leaves it, whatever the
// gesture; a held first port is a gesture, so Esc cancels it first.
const wired = reduceWorldTool(WORLD_TOOL_START, { type: "pick", mode: "wire" });
expect(wired.mode === "wire" && !wired.gesture, "a button picks Wire");
expect(
  reduceWorldTool(moved, { type: "pick", mode: "wire" }).mode === "wire",
  "Wire replaces Move"
);
const keyed = reduceWorldTool(WORLD_TOOL_START, {
  type: "toggle",
  mode: "wire",
});
expect(keyed.mode === "wire", "W enters Wire from Select");
expect(
  reduceWorldTool(keyed, { type: "toggle", mode: "wire" }).mode === "select",
  "W again leaves Wire"
);
expect(
  reduceWorldTool(moved, { type: "toggle", mode: "wire" }).mode === "wire",
  "W from Move enters Wire"
);
const holding = reduceWorldTool(wired, { type: "begin" });
expect(holding.gesture && holding.mode === "wire", "a held port is a gesture");
const leftHeld = reduceWorldTool(holding, { type: "toggle", mode: "wire" });
expect(
  leftHeld.mode === "select" && !leftHeld.gesture,
  "W with a port held leaves Wire and drops the port"
);
const cancelHeld = toolEscape(holding);
expect(cancelHeld.did === "cancel-gesture", "Esc cancels a held port first");
expect(
  cancelHeld.state.mode === "wire" && !cancelHeld.state.gesture,
  "cancelling a held port stays in Wire"
);
const leaveWire = toolEscape(cancelHeld.state);
expect(
  leaveWire.did === "leave-tool" && leaveWire.state.mode === "select",
  "the next Esc leaves Wire"
);
expect(
  toolEscape(leaveWire.state).did === null,
  "then Esc is the selection's again"
);
expect(
  isPoseTool("move") && isPoseTool("rotate"),
  "Move and Rotate are pose tools"
);
expect(
  !isPoseTool("wire") && !isPoseTool("select"),
  "Wire and Select take no gizmo"
);

// Probe is one more mode with no key: the button enters it, a click on a
// port is not a gesture, and Esc leaves it.
const probing = reduceWorldTool(WORLD_TOOL_START, {
  type: "pick",
  mode: "probe",
});
expect(probing.mode === "probe" && !probing.gesture, "a button picks Probe");
expect(
  reduceWorldTool(wired, { type: "pick", mode: "probe" }).mode === "probe",
  "Probe replaces Wire"
);
expect(
  reduceWorldTool(probing, { type: "pick", mode: "wire" }).mode === "wire",
  "Wire replaces Probe"
);
expect(
  reduceWorldTool(probing, { type: "pick", mode: "probe" }) === probing,
  "picking Probe again changes nothing"
);
const leaveProbe = toolEscape(probing);
expect(
  leaveProbe.did === "leave-tool" && leaveProbe.state.mode === "select",
  "Esc leaves Probe when nothing is pending"
);
expect(
  reduceWorldTool(probing, { type: "reset" }) === WORLD_TOOL_START,
  "a closed document resets Probe"
);
expect(!isPoseTool("probe"), "Probe takes no gizmo");
expect(
  isPortTool("wire") && isPortTool("probe") && !isPortTool("move"),
  "Wire and Probe draw the port markers"
);

expect(toolLabel("probe") === "Probe", "Probe label");
expect(toolLabel("select") === "Select", "Select label");
expect(toolLabel("wire") === "Wire", "Wire label");
expect(toolLabel("move") === "Move", "Move label");
expect(toolLabel("rotate") === "Rotate", "Rotate label");

// One table lists the tools. The answers below are what the hand-written
// lists gave before it: they must not move.
const MODES: readonly WorldToolMode[] = [
  "select",
  "move",
  "rotate",
  "wire",
  "probe",
];
expect(
  WORLD_TOOLS.map((tool) => tool.mode).join() === MODES.join(),
  "the table keeps the toolbar order"
);
expect(
  new Set(WORLD_TOOLS.map((tool) => tool.mode)).size === WORLD_TOOLS.length,
  "a mode is listed once"
);
for (const tool of WORLD_TOOLS) {
  expect(tool.label.length > 0, `${tool.mode} has a label`);
  expect(
    tool.group === "select" || tool.group === "pose" || tool.group === "port",
    `${tool.mode} has a group`
  );
  expect(Boolean(tool.icon), `${tool.mode} has an icon`);
}
expect(
  MODES.filter(isPoseTool).join() === "move,rotate",
  "isPoseTool answers as before for all five modes"
);
expect(
  MODES.filter(isPortTool).join() === "wire,probe",
  "isPortTool answers as before for all five modes"
);
expect(
  WORLD_TOOLS.filter((tool) => "hotkey" in tool)
    .map((tool) => tool.mode)
    .join() === "wire",
  "only Wire has a hotkey"
);
expect(toolTitle("wire") === "Wire (W)", "the Wire tooltip names its key");
expect(
  MODES.filter((mode) => mode !== "wire").every(
    (mode) => toolTitle(mode) === toolLabel(mode)
  ),
  "a tool without a key has its label for a tooltip"
);
expect(toolForKey("w") === "wire", "the table maps w to Wire");
expect(toolForKey("W") === "wire", "the table maps W to Wire");
expect(
  toolForKey("m") === null &&
    toolForKey("F2") === null &&
    toolForKey(" ") === null,
  "a key no tool owns maps to nothing"
);

// A tool commit restarts the run, so it asks with the park guard: a
// playing run asks, Stay drops the gesture, Stop pauses and applies it.
expect(parkGuard("playing") === "ask", "a playing run asks");
expect(parkGuard("paused") === "go", "a paused run commits");
expect(parkGuard("idle") === "go", "an idle run commits");
expect(parkOutcome("stay") === "stay", "Stay drops the gesture");
expect(
  parkOutcome("stop") === "stop-and-continue",
  "Stop and continue pauses, then applies"
);

console.log("world-tool.selfcheck ok");
