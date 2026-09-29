import type {
  Domain,
  WorldViewNode,
  WorldViewTree,
} from "@sfab-bench/contract";

import {
  type PortBody,
  RING_GAP,
  RING_LIFT,
  ROBOT_HALF,
  ringSlots,
  type Vec3,
  wireMarkers,
} from "./world-ports";

function expect(cond: boolean, label: string) {
  if (!cond) throw new Error(label);
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-12;
const nearVec = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((v, i) => near(v, b[i] ?? Number.NaN));

const identity = {
  position: [0, 0, 0] as Vec3,
  rotation: [1, 0, 0, 0] as [number, number, number, number],
};

type PortSpec = [name: string, domain: Domain | null, wired: boolean];

function node(
  id: string,
  role: WorldViewNode["role"],
  ports: PortSpec[] = [],
  children: WorldViewNode[] = [],
  pose: WorldViewNode["pose"] = identity
): WorldViewNode {
  return {
    id,
    name: id === "$root" ? "scene" : id.slice(id.lastIndexOf(".") + 1),
    part: id === "$root" ? "sfab/scene@1.0.0" : `sfab/${id}@1.0.0`,
    type: "part",
    role,
    pose,
    ports: ports.map(([name, domain, wired]) => ({
      name,
      source: "type",
      fixed: true,
      ...(domain ? { domain } : {}),
      wired,
    })),
    params: {},
    levels: [],
    children,
  };
}

const FILE = "parts/sfab/scene@1.0.0.json";
const scene = (children: WorldViewNode[]): WorldViewTree => ({
  part: "sfab/scene@1.0.0",
  stage: "sfab/scene@1.0.0",
  play: { gravity: [0, 0, -9.81], seed: 1 },
  nodes: [node("$root", "assembly", [], children)],
});

// The ring: slot i is at angle 2πi/n from +X on an ellipse standing off the
// body, above its top face.
const half: Vec3 = [0.03, 0.02, 0.005];
const four = ringSlots(half, 4);
const a = half[0] + RING_GAP;
const b = half[1] + RING_GAP;
const z = half[2] + RING_LIFT;
expect(four.length === 4, "one slot per port");
expect(nearVec(four[0]?.position ?? [], [a, 0, z]), "slot 0 is on +X");
expect(
  near(four[1]?.position[0] ?? 1, 0) && near(four[1]?.position[1] ?? 0, b),
  "slot 1 is a quarter turn on, on +Y"
);
expect(near(four[2]?.position[0] ?? 0, -a), "slot 2 is on -X");
expect(
  four.every((slot) => near(slot.position[2], z)),
  "every slot sits at one height"
);
expect(ringSlots(half, 0).length === 0, "no ports, no slots");
const firstRing = JSON.stringify(ringSlots(half, 7));
const secondRing = JSON.stringify(ringSlots([...half], 7));
expect(firstRing === secondRing, "the ring is deterministic");
for (const count of [1, 2, 8, 20, 40, 200]) {
  const radius = ringSlots(half, count)[0]?.radius ?? 0;
  expect(
    radius >= 0.0015 && radius <= 0.005,
    `the radius is clamped at ${count}`
  );
}
const dense = ringSlots(half, 20);
let closest = Number.POSITIVE_INFINITY;
for (let i = 0; i < dense.length; i++) {
  for (let j = i + 1; j < dense.length; j++) {
    const p = dense[i]?.position ?? [0, 0, 0];
    const q = dense[j]?.position ?? [0, 0, 0];
    closest = Math.min(closest, Math.hypot(p[0] - q[0], p[1] - q[1]));
  }
}
expect(
  closest > 2 * (dense[0]?.radius ?? 1),
  "twenty markers on a board do not overlap"
);

// Markers: direct children with a drawn body, ports ordered by name.
const bodies: PortBody[] = [
  { id: "uno", half: [0.034, 0.026, 0.008] },
  { id: "servo", half: [0.012, 0.006, 0.011] },
  { id: "arm", half: ROBOT_HALF },
  { id: "rig", half: [0.02, 0.02, 0.02] },
  { id: "rig.inner", half: [0.02, 0.02, 0.02] },
];
const tree = scene([
  node("uno", "board", [
    ["D10", "electrical", false],
    ["D9", "electrical", true],
    ["5V", "electrical", true],
  ]),
  node("servo", "part", [
    ["signal", "electrical", true],
    ["shaft", "rotational", true],
    ["mount", null, false],
  ]),
  node("arm", "robot", [["shoulder", "rotational", true]]),
  node("gone", "part", [["p", "electrical", false]]),
  node("empty", "part"),
  node(
    "rig",
    "assembly",
    [["out", "electrical", false]],
    [node("rig.inner", "part", [["p", "electrical", false]])]
  ),
]);
const markers = wireMarkers(tree, bodies, FILE);
const refs = markers.map((marker) => marker.ref);
expect(
  refs.join() ===
    "uno.5V,uno.D10,uno.D9,servo.mount,servo.shaft,servo.signal,arm.shoulder,rig.out",
  `ports are ordered by name per instance: ${refs.join()}`
);
expect(
  !refs.some((ref) => ref.startsWith("gone.") || ref.startsWith("rig.inner")),
  "a part with no drawn body and a nested instance get no markers"
);
const d10 = markers.find((marker) => marker.ref === "uno.D10");
expect(
  d10?.domain === "electrical" && d10.wired === false && d10.instance === "uno",
  "a marker carries its domain, wired flag and instance"
);
expect(
  markers.find((marker) => marker.ref === "uno.D9")?.wired === true,
  "a wired port is marked wired"
);
const mount = markers.find((marker) => marker.ref === "servo.mount");
expect(mount !== undefined && !("domain" in mount), "no domain, none invented");
expect(
  JSON.stringify(wireMarkers(tree, bodies, FILE)) === JSON.stringify(markers),
  "the same tree gives the same markers"
);
expect(
  JSON.stringify(wireMarkers(tree, [...bodies].reverse(), FILE)) ===
    JSON.stringify(markers),
  "the order the bodies are drawn in does not move a marker"
);

// A pose moves the ring with the body: quarter turn about Z.
const turned = scene([
  node("uno", "board", [["D9", "electrical", false]], [], {
    position: [0.1, 0.2, 0.3],
    rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
  }),
]);
const only = wireMarkers(
  turned,
  [{ id: "uno", half: [0.03, 0.02, 0.005] }],
  FILE
);
expect(only.length === 1, "one port, one marker");
expect(
  nearVec(only[0]?.position ?? [], [
    0.1,
    0.2 + 0.03 + RING_GAP,
    0.3 + 0.005 + RING_LIFT,
  ]),
  "the ring turns and moves with the body"
);

// Only what the open part owns: from a bench, the scene's children are nested.
const bench: WorldViewTree = {
  part: "sfab/bench@1.0.0",
  stage: "sfab/scene@1.0.0",
  play: { gravity: [0, 0, -9.81], seed: 1 },
  nodes: [
    node(
      "$root",
      "assembly",
      [],
      [node("uno", "board", [["D9", "electrical", false]])]
    ),
    node("ground", "ground", [["g", "electrical", false]]),
    node("goal", "target", [["g", "electrical", false]]),
    node("cube", "part", [["p", "electrical", false]]),
  ],
};
const benchMarkers = wireMarkers(
  bench,
  [
    { id: "uno", half: [0.03, 0.02, 0.005] },
    { id: "ground", half: [1, 1, 0.01] },
    { id: "goal", half: [0.01, 0.01, 0.01] },
    { id: "cube", half: [0.01, 0.01, 0.01] },
  ],
  "parts/sfab/bench@1.0.0.json"
);
expect(
  benchMarkers.map((marker) => marker.ref).join() === "cube.p",
  `a bench owns its own children only: ${benchMarkers.map((marker) => marker.ref).join()}`
);
expect(wireMarkers(null, bodies, FILE).length === 0, "no tree, no markers");

console.log("world-ports.selfcheck ok");
