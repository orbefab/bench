import type { WorldViewNode } from "@sfab-bench/contract";

import { treeRows } from "./world-tree";

function expect(cond: boolean, label: string) {
  if (!cond) throw new Error(label);
}

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

console.log("world-tree.selfcheck ok");
