import type { WorldViewTree } from "@sfab-bench/contract";

import {
  instanceEditTarget,
  stageEditTarget,
  wireEditTarget,
} from "./world-edit-target";

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

const BENCH_FILE = "parts/sfab/bench@1.0.0.json";
const SCENE_FILE = "parts/sfab/scene@1.0.0.json";

/**
 * What the socket accepts (`documentNames` in `apps/server/src/world/edit.ts`):
 * with `part`, that part's id or file; without it, the open tab's file.
 */
function accepted(
  target: { part?: string; document: string } | null,
  tabFile: string
): boolean {
  if (!target) return false;
  return target.part === undefined
    ? target.document === tabFile
    : target.document === target.part;
}

const nano = instanceEditTarget(nested, "nano", BENCH_FILE);
expect(
  nano?.part === "sfab/scene@1.0.0" &&
    nano.id === "nano" &&
    nano.document === "sfab/scene@1.0.0" &&
    accepted(nano, BENCH_FILE),
  "a stage child is edited in the stage part"
);
const power = instanceEditTarget(nested, "nano.power", BENCH_FILE);
expect(
  power?.part === "sfab/nano@1.0.0" &&
    power.id === "power" &&
    accepted(power, BENCH_FILE),
  "a nested instance is edited in the part that owns it"
);
const ground = instanceEditTarget(nested, "ground", BENCH_FILE);
expect(
  ground?.part === undefined &&
    ground?.document === BENCH_FILE &&
    ground?.id === "ground" &&
    accepted(ground, BENCH_FILE),
  "a document slot is edited by the tab's file, not the part id"
);
expect(
  instanceEditTarget(nested, "$root", BENCH_FILE) === null,
  "the stage itself is not an instance edit"
);

// The stage scene is the bench's own instance, named by its id there.
const stage = stageEditTarget(nested, BENCH_FILE);
expect(
  stage?.part === undefined &&
    stage?.document === BENCH_FILE &&
    stage?.id === "scene" &&
    accepted(stage, BENCH_FILE),
  "an unwrapped stage is edited as a bench instance"
);

// A part tab opened through Open part: the tab is the scene's own file.
const opened: WorldViewTree = {
  part: "sfab/scene@1.0.0",
  stage: "sfab/scene@1.0.0",
  play: { gravity: [0, 0, -9.81], seed: 1 },
  nodes: [
    leaf("$root", "sfab/scene@1.0.0", [
      leaf("uno", "sfab/uno-r3@1.0.0"),
      leaf("rig", "sfab/rig@1.0.0", [leaf("rig.servo", "sfab/sg90@1.0.0")]),
    ]),
  ],
};
const uno = instanceEditTarget(opened, "uno", SCENE_FILE);
expect(
  uno?.part === undefined &&
    uno?.document === SCENE_FILE &&
    uno?.id === "uno" &&
    accepted(uno, SCENE_FILE),
  "a part tab's own child is named by the part tab's file"
);
const servoIn = instanceEditTarget(opened, "rig.servo", SCENE_FILE);
expect(
  servoIn?.part === "sfab/rig@1.0.0" && accepted(servoIn, SCENE_FILE),
  "a nested instance on a part tab is named by its owner part"
);
expect(
  stageEditTarget(opened, SCENE_FILE) === null,
  "a stage that is the document has no owner to edit it"
);

const flat: WorldViewTree = {
  ...nested,
  stage: "sfab/bench@1.0.0",
  nodes: [
    leaf("$root", "sfab/bench@1.0.0", [leaf("servo", "sfab/sg90@1.0.0")]),
  ],
};
const servo = instanceEditTarget(flat, "servo", BENCH_FILE);
expect(
  servo?.part === undefined &&
    servo?.document === BENCH_FILE &&
    servo?.id === "servo",
  "a root instance is edited in the open document"
);

const wire = wireEditTarget(nested, "nano", 0, BENCH_FILE);
expect(
  wire?.part === "sfab/nano@1.0.0" &&
    wire.a === "power.5V" &&
    wire.b === "usb.5V" &&
    accepted(wire, BENCH_FILE),
  "a wire is removed from the assembly that owns it"
);
const rootWire = wireEditTarget(
  {
    ...flat,
    nodes: [leaf("$root", "sfab/bench@1.0.0", [], [{ a: "a.x", b: "b.y" }])],
  },
  "$root",
  0,
  BENCH_FILE
);
expect(
  rootWire?.part === undefined &&
    rootWire?.document === BENCH_FILE &&
    accepted(rootWire, BENCH_FILE),
  "a wire in the open document is named by the tab's file"
);

console.log("world-edit-target.selfcheck ok");
