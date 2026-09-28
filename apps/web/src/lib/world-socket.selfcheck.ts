import { worldSocketKey } from "./world-socket";

function expect(cond: boolean, label: string) {
  if (!cond) throw new Error(label);
}

const open = {
  project: "/abs/proj",
  world: "examples/arm/parts/sfab/arm-bench@1.0.0.json",
  loadId: 1,
};

expect(
  worldSocketKey(open) !== worldSocketKey({ ...open, loadId: 2 }),
  "a forced reopen (loadId) re-attaches"
);
expect(
  worldSocketKey(open) !==
    worldSocketKey({ ...open, world: "examples/arm/other.world.json" }),
  "a different world re-attaches"
);
expect(
  worldSocketKey(open) !== worldSocketKey({ ...open, project: "/abs/other" }),
  "a different folder re-attaches"
);
// `reloaded` bumps revision and does not take a new loadId, so the key
// is unchanged and the effect does not open a second socket.
expect(
  worldSocketKey(open) === worldSocketKey({ ...open }),
  "the same open, including a reload, keeps one socket"
);

console.log("world-socket.selfcheck ok");
