/**
 * Supplies whose grounds meet are one island, whatever port a ground net's
 * wires start from. A composite shell (an assembly's servo at class 2) has
 * no run pin, and the plan may star a net out from its port: the ground
 * walk passes through it. A 5V net through a shell does not tie grounds.
 */
import { ok as expect } from "node:assert/strict";

import type { RunPlan } from "../src/plan";
import { powerIslands } from "../src/wiring";

const pin = (kind: string, output = false) => ({
  kind,
  output,
  digital: false,
  pwm: false,
});
const supply = (id: string) => ({
  id,
  positivePin: "5V",
  groundPin: "GND",
  pins: { "5V": pin("power", true), GND: pin("ground") },
});
const board = (id: string) => ({
  id,
  pins: { "5V": pin("power"), GND: pin("ground") },
  powerInputs: ["5V"],
});

function islands(wires: [string, string][]): string[] {
  const plan = {
    boards: [board("a.uno"), board("b.uno")],
    parts: [],
    supplies: [supply("a.usb"), supply("b.usb")],
    wires,
  } as unknown as RunPlan;
  return powerIslands(plan).map((island) => island.supplyIds.join("+"));
}

// Each assembly's own nets, starred from its servo shell.
const own = (x: string): [string, string][] => [
  [`${x}.servo.GND`, `${x}.usb.GND`],
  [`${x}.servo.GND`, `${x}.uno.GND`],
  [`${x}.servo.V+`, `${x}.usb.5V`],
  [`${x}.servo.V+`, `${x}.uno.5V`],
];

const apart = islands([...own("a"), ...own("b")]);
expect(apart.join() === "a.usb,b.usb", `untied ${apart.join()}`);

// a.GND–b.GND: the one ground net now stars out from a's servo shell.
const tied = islands([
  ...own("a").filter(([head]) => !head.endsWith(".GND")),
  ...own("b").filter(([head]) => !head.endsWith(".GND")),
  ["a.servo.GND", "a.usb.GND"],
  ["a.servo.GND", "a.uno.GND"],
  ["a.servo.GND", "b.servo.GND"],
  ["a.servo.GND", "b.usb.GND"],
  ["a.servo.GND", "b.uno.GND"],
]);
expect(
  tied.join() === "a.usb+b.usb",
  `ground tie through a shell ${tied.join()}`
);

// a.5V–b.5V with grounds apart: one positive net, two islands.
const railOnly = islands([
  ...own("a").filter(([head]) => !head.endsWith(".V+")),
  ...own("b").filter(([head]) => !head.endsWith(".V+")),
  ["a.servo.V+", "a.usb.5V"],
  ["a.servo.V+", "a.uno.5V"],
  ["a.servo.V+", "b.servo.V+"],
  ["a.servo.V+", "b.usb.5V"],
  ["a.servo.V+", "b.uno.5V"],
]);
expect(
  railOnly.join() === "a.usb,b.usb",
  `a 5V net through a shell tied grounds: ${railOnly.join()}`
);

console.log(
  "ground-shell: untied a.usb, b.usb; ground through a's servo shell a.usb+b.usb; 5V through it stays a.usb, b.usb"
);
console.log("ground-shell.selfcheck ok");
