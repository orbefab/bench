import type { WorldViewNode, WorldViewTree } from "@sfab-bench/contract";

import {
  moveTarget,
  poseCommit,
  REASON_GROUND,
  REASON_OPEN_PART,
  REASON_ORIGIN,
  REASON_RUN,
} from "./world-move";

function expect(cond: boolean, label: string) {
  if (!cond) throw new Error(label);
}

const pose = {
  position: [0, 0, 0] as [number, number, number],
  rotation: [1, 0, 0, 0] as [number, number, number, number],
};

function node(
  id: string,
  part: string,
  role: WorldViewNode["role"],
  children: WorldViewNode[] = []
): WorldViewNode {
  return {
    id,
    name: id === "$root" ? "scene" : id.slice(id.lastIndexOf(".") + 1),
    part,
    type: "part",
    role,
    pose,
    ports: [],
    params: {},
    levels: [],
    children,
  };
}

function tree(part: string, nodes: WorldViewNode[]): WorldViewTree {
  return {
    part,
    stage: "sfab/scene@1.0.0",
    play: { gravity: [0, 0, -9.81], seed: 1 },
    nodes,
  };
}

// The scene is the open part: its children are direct.
const scene = tree("sfab/scene@1.0.0", [
  node("$root", "sfab/scene@1.0.0", "assembly", [
    node("uno", "sfab/uno-r3@1.0.0", "board"),
    node("arm", "sfab/arm@1.0.0", "robot"),
    node("box", "sfab/box@1.0.0", "part"),
    node("rig", "sfab/rig@1.0.0", "assembly", [
      node("rig.servo", "sfab/sg90@1.0.0", "part"),
    ]),
  ]),
]);

const uno = moveTarget(scene, "uno");
expect(uno.ok, "a board the open part owns can move");
if (uno.ok) {
  expect(
    uno.target.id === "uno" &&
      uno.target.document === "sfab/scene@1.0.0" &&
      uno.target.part === undefined,
    "the edit names the open document"
  );
}
expect(moveTarget(scene, "arm").ok, "a robot the open part owns can move");
expect(moveTarget(scene, "box").ok, "a box the open part owns can move");
expect(moveTarget(scene, "rig").ok, "a direct assembly can move");

const nested = moveTarget(scene, "rig.servo");
expect(
  !nested.ok && nested.reason === REASON_OPEN_PART,
  "a nested instance says to open its part"
);
const origin = moveTarget(scene, "$root");
expect(!origin.ok && origin.reason === REASON_ORIGIN, "the open part is fixed");

// A bench opened over a scene: the scene's children belong to the scene.
const bench = tree("sfab/bench@1.0.0", [
  node("$root", "sfab/scene@1.0.0", "assembly", [
    node("uno", "sfab/uno-r3@1.0.0", "board"),
  ]),
  node("ground", "sfab/ground-plane@1.0.0", "ground"),
  node("goal", "sfab/goal@1.0.0", "target"),
  node("cube", "sfab/cube@1.0.0", "part"),
]);
const under = moveTarget(bench, "uno");
expect(
  !under.ok && under.reason === REASON_OPEN_PART,
  "a stage child is nested from the bench"
);
expect(moveTarget(bench, "cube").ok, "a bench child can move");
const ground = moveTarget(bench, "ground");
expect(!ground.ok && ground.reason === REASON_GROUND, "the ground stays put");
const goal = moveTarget(bench, "goal");
expect(!goal.ok && goal.reason === REASON_RUN, "a target is moved by the run");

const none = moveTarget(scene, null);
expect(!none.ok && none.reason === "Select a part", "no selection has a hint");
expect(!moveTarget(null, "uno").ok, "no tree, no target");
expect(!moveTarget(scene, "gone").ok, "an unknown path is not a target");

// One gesture is one set-pose; a pose the document already has sends nothing.
const arrow = moveTarget(scene, "uno");
if (arrow.ok) {
  const moved = poseCommit(arrow, "uno", {
    position: [0.1, 0, 0.006],
    rotation: [1, 0, 0, 0],
  });
  expect(moved !== null && moved.ops.length === 1, "a move is one op");
  const op = moved?.ops[0];
  expect(
    op?.kind === "set-pose" &&
      op.document === "sfab/scene@1.0.0" &&
      op.id === "uno" &&
      op.pose?.position.join() === "0.1,0,0.006",
    "the op names the instance and carries the pose"
  );
  expect(
    moved?.part === undefined && moved?.previewPath === "uno",
    "a direct child sends no part"
  );
  expect(moved?.label === "Move uno", "the undo step is named");
  expect(
    poseCommit(arrow, "uno", pose) === null,
    "an unchanged pose sends nothing"
  );
}

console.log("world-move.selfcheck ok");
