/**
 * A stamped part goes for a reason in its own connections, never for its
 * form. A form with a supply port (`ldo-regulator@1` IN, `comparator@1`
 * VP) runs its law when that port is powered: a fed node, or one reached
 * from it through other parts. Unpowered, the regulator is open and the
 * comparator sits at its negative rail. A node nothing else drives still
 * drops a part, except an output the part drives from its own supply.
 *
 * On the Uno's class-2 power input with VIN open: only the NCP1117 (fed
 * from VIN) goes; the LP2985 and the comparator run from +5V, and the
 * comparator holds T1's gate low. A powered sensor comparator added to
 * the stamp stays whatever the board's VIN does.
 */
import { ok as expect } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AssignedPart } from "@sfab-bench/sim/circuit-stamp";
import { UNO_U2_LDO } from "@sfab-bench/sim/power-path";
import { createRailCircuit } from "@sfab-bench/sim/rail-circuit";
import { boardStampOf, realize } from "./world/circuit-stamp";
import { catalogRoot } from "./world/plan";

const pin = JSON.parse(
  readFileSync(join(catalogRoot(), "parts/sfab/atmega328p@1.0.0.json"), "utf8")
).axes.behaviour["1"].variants.avr8js.params;
const uno = boardStampOf("sfab/uno-r3@1.0.0", "circuits", { boardId: "uno" });
expect(uno.regulatorNode === "uno.VIN", `VIN node ${uno.regulatorNode}`);

// Which parts each feed drops: the VIN regulator when VIN is open, and
// the fuse and switch when VBUS is.
const want: Record<"usb" | "header" | "vin", string[]> = {
  usb: ["uno.power.u1"],
  header: ["uno.power.f1", "uno.power.t1", "uno.power.u1"],
  vin: ["uno.power.f1", "uno.power.t1"],
};
for (const feed of ["usb", "header", "vin"] as const) {
  const got = realize(uno, feed, pin);
  expect(
    JSON.stringify(got.pruned) === JSON.stringify(want[feed]),
    `${feed} pruned ${JSON.stringify(got.pruned)}`
  );
  // The comparator and U2 run from +5V on every feed.
  for (const path of ["uno.power.u2", "uno.power.u5a"]) {
    expect(
      got.elements.some((el) => el.id === path),
      `${feed}: ${path} is not stamped`
    );
  }
}

// USB: T1's gate is the comparator's output, not ground, and the solve
// holds it low (VIN/2 = 0 V under the 3.3 V reference).
const usb = realize(uno, "usb", pin);
const gate = usb.ports.get("uno.power.t1.G");
expect(
  gate !== undefined &&
    gate !== "0" &&
    gate === usb.ports.get("uno.power.u5a.OUT"),
  `T1 gate node ${gate}`
);
const rail = createRailCircuit({
  vNom: 5,
  rSeries: 0.5,
  iLimit: 2,
  motors: [],
  stamp: uno,
  feed: "usb",
});
const LOAD = 0.05;
rail.setFixed(LOAD);
for (let ms = 0; ms < 20; ms++) rail.solve();
const gateV = rail.nodeVoltage(gate ?? "0");
const ref = rail.nodeVoltage(usb.ports.get("uno.power.u2.OUT") ?? "0");
expect(Math.abs(gateV) < 1e-9, `T1 gate ${gateV} V`);
expect(Math.abs(ref - 3.3) < 1e-6, `U2 output ${ref} V`);
// The supply carries the board load and U2's ground current.
const extra = rail.current - LOAD;
expect(
  Math.abs(extra - UNO_U2_LDO.iGround) < 1e-9,
  `supply ${rail.current} A: ${extra} A over the load`
);
console.log(
  `power-prune: uno USB keeps U2 and the comparator; T1 gate ${gateV.toExponential(1)} V, U2 ${ref.toFixed(4)} V, supply +${(extra * 1e6).toFixed(2)} µA over the load`
);

// A powered sensor comparator on the board's 5V stays whether or not the
// board's VIN is fed (the M2 audit's vin-prune probe).
const sensor: AssignedPart = {
  path: "sensor.compare",
  form: "comparator@1",
  typeId: "comparator",
  params: {},
  nodes: {
    P: uno.boardNode,
    N: "0",
    VP: uno.boardNode,
    VN: "0",
    OUT: "sensor-out",
  },
};
const withSensor = {
  ...uno,
  parts: [...uno.parts, sensor],
  pins: [...uno.pins, { port: "D2", bit: 2, node: "sensor-out" }],
};
for (const feed of ["usb", "header", "vin"] as const) {
  const got = realize(withSensor, feed, pin);
  expect(
    got.elements.some((el) => el.id === "sensor.compare") &&
      !got.pruned.includes("sensor.compare"),
    `${feed}: the sensor comparator went`
  );
}

// Power reaches a supply port through other parts: a comparator fed from
// 5V through a resistor runs; one fed from the open VIN sits at its
// negative rail; a regulator fed from the open VIN goes.
const extraParts: AssignedPart[] = [
  {
    path: "feed.r",
    form: "resistor@1",
    typeId: "resistor",
    params: { R: 100 },
    nodes: { A: uno.boardNode, B: "feed" },
  },
  {
    path: "fed.compare",
    form: "comparator@1",
    typeId: "comparator",
    params: {},
    nodes: { P: "feed", N: "0", VP: "feed", VN: "0", OUT: "fed-out" },
  },
  {
    path: "vin.compare",
    form: "comparator@1",
    typeId: "comparator",
    params: {},
    nodes: { P: "feed", N: "0", VP: "uno.VIN", VN: "0", OUT: "vin-out" },
  },
  {
    path: "vin.ldo",
    form: "ldo-regulator@1",
    typeId: "ldo",
    params: {},
    nodes: { IN: "uno.VIN", OUT: "vin-ldo-out", GND: "0" },
    ldo: UNO_U2_LDO,
  },
];
const reach = realize(
  { ...uno, parts: [...uno.parts, ...extraParts] },
  "usb",
  pin
);
expect(
  reach.ports.get("fed.compare.VP") === "feed",
  `fed comparator VP ${reach.ports.get("fed.compare.VP")}`
);
expect(
  reach.ports.get("vin.compare.VP") === "0" &&
    reach.elements.some((el) => el.id === "vin.compare"),
  `unpowered comparator VP ${reach.ports.get("vin.compare.VP")}`
);
expect(
  reach.pruned.includes("vin.ldo"),
  `the regulator on the open VIN stayed: ${JSON.stringify(reach.pruned)}`
);
console.log(
  "power-prune: pruned usb [u1], header [f1, t1, u1], vin [f1, t1]; sensor comparator kept on every feed; power reaches through a resistor; unpowered comparator at its negative rail, unpowered regulator open"
);
console.log("power-prune.selfcheck ok");
