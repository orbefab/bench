/**
 * A VIN feed through a passive hub reaches the board. The plan marks the
 * board `vinFeed` from the net, so the power feed must read the same net:
 * a hub pin is not a power pin, and the walk must not stop at it.
 */

import { ok as expect } from "node:assert/strict";

import type { RunPlan } from "./world/plan";
import { powerFeedsOf } from "./world/wiring";

const pin = (kind: "gpio" | "power" | "ground" | "signal") => ({
  kind,
  output: false,
  digital: false,
  pwm: false,
});

function planOf(wires: [string, string][]): RunPlan {
  return {
    boards: [
      {
        id: "b",
        pins: { "5V": pin("power"), VIN: pin("power"), GND: pin("ground") },
        powerInputs: ["5V"],
        vinFeed: true,
        vinPin: "VIN",
      },
    ],
    parts: [
      {
        id: "hub",
        pins: { a: pin("signal"), b: pin("signal") },
      },
    ],
    rangers: [],
    supplies: [
      {
        id: "s",
        positivePin: "+",
        groundPin: "-",
        pins: { "+": pin("power"), "-": pin("ground") },
      },
    ],
    wires,
  } as unknown as RunPlan;
}

// Supply → hub pin → VIN: one net, and the hub pin is signal-kind.
const hubbed = powerFeedsOf(
  planOf([
    ["s.+", "hub.a"],
    ["hub.a", "b.VIN"],
  ])
);
expect(
  hubbed.boards.b === "s",
  `a VIN feed through a passive hub reaches the board, got ${hubbed.boards.b}`
);

// The same feed wired straight still does.
const direct = powerFeedsOf(planOf([["s.+", "b.VIN"]]));
expect(direct.boards.b === "s", "a direct VIN feed reaches the board");

// A hub with nothing on its far side feeds nothing.
const open = powerFeedsOf(planOf([["s.+", "hub.a"]]));
expect(open.boards.b === null, "an unwired VIN is not fed");

console.log("feeds-hub.selfcheck ok");
