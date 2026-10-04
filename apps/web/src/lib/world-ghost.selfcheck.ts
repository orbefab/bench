import { ok as expect } from "node:assert/strict";
import type { WorldGhostState, WorldViewNode } from "@sfab-bench/contract";

import { ghostOffer, ghostReadout, ghostRobots } from "./world-ghost";

function servo(chosen: { class: 0 | 1 | 2 | 3; variant: string }) {
  return {
    id: "arm.servo",
    name: "servo",
    part: "sfab/sg90-servo@1.0.0",
    type: "servo",
    role: "part",
    pose: { position: [0, 0, 0], rotation: [1, 0, 0, 0] },
    ports: [],
    params: {},
    children: [],
    levels: [
      {
        axis: "behaviour",
        chosen,
        options: [
          { class: 1, variant: "group", label: "group", runnable: true },
          {
            class: 1,
            variant: "snap",
            label: "snapshot",
            runnable: true,
            source: "snapshot",
            ref: "sfab/sg90-servo@1.0.0",
          },
          { class: 2, variant: "netlist", label: "netlist", runnable: true },
        ],
      },
    ],
  } as WorldViewNode;
}

const detailed = ghostOffer(servo({ class: 2, variant: "netlist" }));
expect(
  detailed?.path === "arm.servo" &&
    detailed.class === 1 &&
    detailed.variant === "snap" &&
    detailed.ref === "sfab/sg90-servo@1.0.0",
  `a detailed behaviour offers its snapshot: ${JSON.stringify(detailed)}`
);
expect(
  ghostOffer(servo({ class: 1, variant: "snap" })) === null,
  "a part already on its snapshot offers no ghost"
);
const bare = servo({ class: 2, variant: "netlist" });
const axis = bare.levels[0];
if (axis) axis.options = axis.options.filter((option) => !option.ref);
expect(ghostOffer(bare) === null, "no snapshot option, no ghost");

const on: WorldGhostState = {
  path: "arm.servo",
  ref: "sfab/sg90-servo@1.0.0",
  impl: "snapshot",
  poses: {},
  joints: [
    { robot: "arm", joint: "shoulder", now: 0.004, max: 0.0054 },
    { robot: "cart", joint: "wheel", now: 0, max: 0 },
  ],
};
const readout = ghostReadout(on, "arm.servo");
expect(
  readout?.kind === "gap" &&
    readout.ref === "sfab/sg90-servo@1.0.0" &&
    readout.lines[0] === "arm/shoulder  now 0.23°  max 0.31°",
  `the readout names the joint and its gap in degrees: ${JSON.stringify(readout)}`
);
expect(
  ghostReadout(on, "other") === null,
  "another part's card says nothing about this ghost"
);
const failed = ghostReadout(
  { path: "arm.servo", error: "the ghost did not build" },
  "arm.servo"
);
expect(
  failed?.kind === "error" && failed.text === "the ghost did not build",
  "a ghost that failed says why"
);
const robots = ghostRobots(on);
expect(
  robots.has("arm") && !robots.has("cart"),
  "only robots that moved apart draw a ghost"
);

console.log("world-ghost.selfcheck ok");
