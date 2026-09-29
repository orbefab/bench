import { ok as expect } from "node:assert/strict";
import type { WorldViewNode } from "@sfab-bench/contract";

import { initialCollapsed, revealCollapsed, treeRows } from "./world-tree";

const pose = {
  position: [0, 0, 0] as [number, number, number],
  rotation: [1, 0, 0, 0] as [number, number, number, number],
};

function node(
  id: string,
  children: WorldViewNode[] = [],
  wires?: { a: string; b: string }[]
): WorldViewNode {
  return {
    id,
    name: id.slice(id.lastIndexOf(".") + 1),
    part: "sfab/part@1.0.0",
    type: "part",
    role: wires ? "assembly" : "part",
    pose,
    ports: [],
    params: {},
    ...(wires ? { wires } : {}),
    levels: [],
    children,
  };
}

const tree = [
  node("scene", [
    node(
      "scene.nano",
      [node("scene.nano.led")],
      [{ a: "led.A", b: "nano.D13" }]
    ),
  ]),
];

const open = treeRows(tree, new Set(["scene.nano.led"]), new Set());
const names = open.map((row) => row.name).join("|");
expect(names === "scene|nano|led|led.A → nano.D13", `rows ${names}`);
const depths = open.map((row) => row.depth).join(",");
expect(depths === "0,1,2,2", `depth ${depths}`);
expect(open.filter((row) => row.kind === "wire").length === 1, "one wire row");
const led = open.find((row) => row.path === "scene.nano.led");
expect(
  led?.warning === true && led.collapsedWarning === false,
  "the led row is warned"
);
const nano = open.find(
  (row) => row.path === "scene.nano" && row.kind === "instance"
);
expect(
  nano?.warning === false && nano.collapsedWarning === false,
  "an open parent does not borrow the icon"
);

const closed = treeRows(
  tree,
  new Set(["scene.nano.led"]),
  new Set(["scene.nano"])
);
expect(
  closed.some((row) => row.path === "scene.nano.led") === false,
  "a collapsed parent hides its children"
);
const folded = closed.find((row) => row.path === "scene.nano");
expect(
  folded?.collapsedWarning === true && folded.warning === false,
  "a collapsed parent shows a descendant warning"
);
expect(
  closed.some((row) => row.kind === "wire") === false,
  "a collapsed parent hides its wires"
);

const seeded = initialCollapsed(tree);
expect(!seeded.has("scene"), "the top level starts open");
expect(seeded.has("scene.nano"), "a stage child with parts starts collapsed");
const top = treeRows(tree, new Set(), seeded);
expect(
  top.map((row) => row.name).join("|") === "scene|nano",
  `top rows ${top.map((row) => row.name).join("|")}`
);
const kept = new Set(seeded);
kept.delete("scene.nano");
const reloaded = treeRows(tree, new Set(), kept);
expect(
  reloaded.some((row) => row.path === "scene.nano.led"),
  "a reload keeps a row the user expanded"
);
const revealed = revealCollapsed(seeded, tree, "scene.nano.led", "instance");
expect(
  !revealed.has("scene.nano") &&
    treeRows(tree, new Set(), revealed).some(
      (row) => row.path === "scene.nano.led"
    ),
  "selecting a nested part opens its ancestors"
);
expect(
  revealCollapsed(revealed, tree, "scene.nano.led", "instance") === revealed,
  "an already open path keeps the same collapsed set"
);
expect(
  revealCollapsed(seeded, tree, "missing", "instance") === seeded,
  "a missing path keeps the same collapsed set"
);

console.log("world-tree.selfcheck ok");
