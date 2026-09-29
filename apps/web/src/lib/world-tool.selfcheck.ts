import { parkGuard, parkOutcome } from "./world-park";
import {
  reduceWorldTool,
  toolEscape,
  toolLabel,
  WORLD_TOOL_START,
} from "./world-tool";

function expect(cond: boolean, label: string) {
  if (!cond) throw new Error(label);
}

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

expect(toolLabel("select") === "Select", "Select label");
expect(toolLabel("move") === "Move", "Move label");
expect(toolLabel("rotate") === "Rotate", "Rotate label");

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
