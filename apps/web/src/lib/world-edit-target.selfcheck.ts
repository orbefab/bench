import type { WorldViewTree } from "@sfab-bench/contract";

import { instanceEditTarget, wireEditTarget } from "./world-edit-target";

function expect(cond: boolean, label: string) {
  if (!cond) throw new Error(label);
}

const pose = {
  position: [0, 0, 0] as [number, number, number],
  rotation: [1, 0, 0, 0] as [number, number, number, number],
};

function leaf(
  id: string,
  part: string,
  children: WorldViewTree["nodes"] = [],
  wires?: { a: string; b: string }[]
): WorldViewTree["nodes"][number] {
  const name = id === "$root" ? "scene" : id.slice(id.lastIndexOf(".") + 1);
  return {
    id,
    name,
    part,
    type: "part",
    role: children.length > 0 || wires ? "assembly" : "part",
    pose,
    ports: [],
    params: {},
    ...(wires ? { wires } : {}),
    levels: [],
    children,
  };
}

const nested: WorldViewTree = {
  part: "sfab/bench@1.0.0",
  stage: "sfab/scene@1.0.0",
  play: { gravity: [0, 0, -9.81], seed: 1 },
  nodes: [
    leaf("$root", "sfab/scene@1.0.0", [
      leaf(
        "nano",
        "sfab/nano@1.0.0",
        [leaf("nano.power", "sfab/power@1.0.0")],
        [{ a: "power.5V", b: "usb.5V" }]
      ),
    ]),
    leaf("ground", "sfab/ground-plane@1.0.0"),
  ],
};

const nano = instanceEditTarget(nested, "nano");
expect(
  nano?.part === "sfab/scene@1.0.0" &&
    nano.id === "nano" &&
    nano.document === "sfab/scene@1.0.0",
  "a stage child is edited in the stage part"
);
const power = instanceEditTarget(nested, "nano.power");
expect(
  power?.part === "sfab/nano@1.0.0" && power.id === "power",
  "a nested instance is edited in the part that owns it"
);
const ground = instanceEditTarget(nested, "ground");
expect(
  ground?.part === undefined &&
    ground?.document === "sfab/bench@1.0.0" &&
    ground?.id === "ground",
  "a document slot is edited in the root part"
);
expect(
  instanceEditTarget(nested, "$root") === null,
  "the stage itself is not an instance edit"
);

const flat: WorldViewTree = {
  ...nested,
  stage: "sfab/bench@1.0.0",
  nodes: [
    leaf("$root", "sfab/bench@1.0.0", [leaf("servo", "sfab/sg90@1.0.0")]),
  ],
};
const servo = instanceEditTarget(flat, "servo");
expect(
  servo?.part === undefined &&
    servo?.document === "sfab/bench@1.0.0" &&
    servo?.id === "servo",
  "a root instance is edited in the open document"
);

const wire = wireEditTarget(nested, "nano", 0);
expect(
  wire?.part === "sfab/nano@1.0.0" &&
    wire.a === "power.5V" &&
    wire.b === "usb.5V",
  "a wire is removed from the assembly that owns it"
);

console.log("world-edit-target.selfcheck ok");
