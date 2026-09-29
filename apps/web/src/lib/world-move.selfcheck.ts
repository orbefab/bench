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

function tree(
  part: string,
  nodes: WorldViewNode[],
  stage = "sfab/scene@1.0.0"
): WorldViewTree {
  return {
    part,
    stage,
    play: { gravity: [0, 0, -9.81], seed: 1 },
    nodes,
  };
}

const SCENE_FILE = "parts/sfab/scene@1.0.0.json";
const BENCH_FILE = "parts/sfab/bench@1.0.0.json";

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

const uno = moveTarget(scene, "uno", SCENE_FILE);
expect(uno.ok, "a board the open part owns can move");
if (uno.ok) {
  expect(
    uno.target.id === "uno" &&
      uno.target.document === SCENE_FILE &&
      uno.target.part === undefined,
    "the edit names the tab's file"
  );
}
expect(
  moveTarget(scene, "arm", SCENE_FILE).ok,
  "a robot the open part owns can move"
);
expect(
  moveTarget(scene, "box", SCENE_FILE).ok,
  "a box the open part owns can move"
);
expect(moveTarget(scene, "rig", SCENE_FILE).ok, "a direct assembly can move");

const nested = moveTarget(scene, "rig.servo", SCENE_FILE);
expect(
  !nested.ok && nested.reason === REASON_OPEN_PART,
  "a nested instance says to open its part"
);
const origin = moveTarget(scene, "$root", SCENE_FILE);
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
const under = moveTarget(bench, "uno", BENCH_FILE);
expect(
  !under.ok && under.reason === REASON_OPEN_PART,
  "a stage child is nested from the bench"
);
expect(moveTarget(bench, "cube", BENCH_FILE).ok, "a bench child can move");
const ground = moveTarget(bench, "ground", BENCH_FILE);
expect(!ground.ok && ground.reason === REASON_GROUND, "the ground stays put");
const goal = moveTarget(bench, "goal", BENCH_FILE);
expect(!goal.ok && goal.reason === REASON_RUN, "a target is moved by the run");

// The shape `examples/arm` gives on the arm-bench root tab: the bench owns
// `scene` and `ground`, the run is unwrapped, so the scene is `$root`. The
// scene is the bench's own child and moves; its children are nested.
const armBench = tree(
  "sfab/arm-bench@1.0.0",
  [
    node("$root", "sfab/arm-scene@1.0.0", "assembly", [
      node("uno", "sfab/uno-r3@1.0.0", "board"),
    ]),
    node("ground", "sfab/ground-plane@1.0.0", "ground"),
  ],
  "sfab/arm-scene@1.0.0"
);
const ARM_BENCH_FILE = "parts/sfab/arm-bench@1.0.0.json";
const armScene = moveTarget(armBench, "$root", ARM_BENCH_FILE);
expect(armScene.ok, "the scene a bench owns can move");
if (armScene.ok) {
  expect(
    armScene.target.id === "scene" &&
      armScene.target.document === ARM_BENCH_FILE &&
      armScene.target.part === undefined,
    "the scene is edited as the bench's instance, by the tab's file"
  );
  const scenePose = poseCommit(armScene, "$root", {
    position: [0.1, 0, 0],
    rotation: [1, 0, 0, 0],
  });
  expect(
    scenePose?.ops[0]?.kind === "set-pose" &&
      scenePose.ops[0].id === "scene" &&
      scenePose.part === undefined &&
      scenePose.label === "Move scene",
    "a scene move is one set-pose on the bench"
  );
}
const armUno = moveTarget(armBench, "uno", ARM_BENCH_FILE);
expect(
  !armUno.ok && armUno.reason === REASON_OPEN_PART,
  "the scene's board is nested from the bench"
);
const armGround = moveTarget(armBench, "ground", ARM_BENCH_FILE);
expect(
  !armGround.ok && armGround.reason === REASON_GROUND,
  "the bench's ground stays put"
);

const none = moveTarget(scene, null, SCENE_FILE);
expect(!none.ok && none.reason === "Select a part", "no selection has a hint");
expect(!moveTarget(null, "uno", SCENE_FILE).ok, "no tree, no target");
expect(
  !moveTarget(scene, "gone", SCENE_FILE).ok,
  "an unknown path is not a target"
);

// One gesture is one set-pose; a pose the document already has sends nothing.
const arrow = moveTarget(scene, "uno", SCENE_FILE);
if (arrow.ok) {
  const moved = poseCommit(arrow, "uno", {
    position: [0.1, 0, 0.006],
    rotation: [1, 0, 0, 0],
  });
  expect(moved !== null && moved.ops.length === 1, "a move is one op");
  const op = moved?.ops[0];
  expect(
    op?.kind === "set-pose" &&
      op.document === SCENE_FILE &&
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
