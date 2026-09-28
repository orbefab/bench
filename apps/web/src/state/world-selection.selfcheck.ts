import type { WorldViewNode, WorldViewTree } from "@sfab-bench/contract";

import { reduceWorldSelection, worldStore } from "./world";

function expect(cond: unknown, label: string) {
  if (!cond) throw new Error(label);
}

const nano = { kind: "instance" as const, path: "scene.nano" };
const link = { kind: "instance" as const, path: "arm", link: "upper_arm" };

let selection = reduceWorldSelection(null, {
  type: "select",
  selection: nano,
});
expect(selection?.path === "scene.nano", "selects an instance");
selection = reduceWorldSelection(selection, {
  type: "select",
  selection: link,
});
expect(
  selection?.path === "arm" && selection.link === "upper_arm",
  "selects a link inside a robot"
);

const kept = reduceWorldSelection(selection, {
  type: "reload",
  paths: ["scene.nano", "arm"],
});
expect(kept === selection, "a reload that keeps the path keeps it");

const dropped = reduceWorldSelection(selection, {
  type: "reload",
  paths: ["scene.nano"],
});
expect(dropped === null, "a reload that removes the path clears it");
expect(
  reduceWorldSelection(selection, { type: "close" }) === null,
  "close clears a selection"
);
expect(
  reduceWorldSelection(null, { type: "select", selection: null }) === null,
  "selecting nothing stays clear"
);

function leaf(id: string): WorldViewNode {
  return {
    id,
    name: id,
    part: "sfab/stage@1",
    type: "part",
    role: "part",
    pose: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
    ports: [],
    params: {},
    levels: [],
    children: [],
  };
}

function tree(ids: string[]): WorldViewTree {
  return {
    part: "sfab/arm-bench@1",
    stage: "sfab/stage@1",
    play: { gravity: [0, 0, -9.81], seed: 1 },
    nodes: ids.map(leaf),
  };
}

worldStore.getState().open("examples/arm/parts/sfab/arm-bench@1.0.0.json");
worldStore.getState().select(link);
expect(
  worldStore.getState().selection?.link === "upper_arm",
  "the store selects a link"
);
worldStore.getState().close();
expect(worldStore.getState().selection === null, "the store clears on close");

worldStore.getState().open("examples/arm/parts/sfab/arm-bench@1.0.0.json");
worldStore.getState().select(nano);
worldStore.getState().setTree(tree(["scene.nano", "arm"]));
expect(
  worldStore.getState().selection?.path === "scene.nano",
  "the store keeps an instance the reloaded tree still has"
);
worldStore.getState().setTree(tree(["arm"]));
expect(
  worldStore.getState().selection === null,
  "the store clears an instance the reloaded tree dropped"
);
worldStore.getState().select(link);
worldStore.getState().setTree(tree(["arm"]));
expect(
  worldStore.getState().selection?.link === "upper_arm",
  "the store keeps a link when the robot path remains"
);
worldStore.getState().close();

console.log("world-selection.selfcheck ok");
