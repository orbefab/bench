/** Which supply feeds a port: the supplies on its electrical net, whatever the net's hub. */
import { ok as expect } from "node:assert/strict";

import { type PowerWiring, suppliesOnPort } from "@sfab-bench/sim/wiring";

const power = { kind: "power", output: false, digital: false, pwm: false };
const supplyPin = { ...power, output: true };

function wiring(wires: [string, string][]): PowerWiring {
  return {
    boards: [{ id: "nano", pins: { VIN: power, "5V": power } }],
    parts: [],
    supplies: [
      { id: "pack", positivePin: "V+", pins: { "V+": supplyPin } },
      { id: "other", positivePin: "V+", pins: { "V+": supplyPin } },
    ],
    wires,
  } as unknown as PowerWiring;
}

{
  const plan = wiring([
    ["c1.A", "nano.VIN"],
    ["c1.A", "pack.V+"],
  ]);
  expect(
    suppliesOnPort(plan, "nano", "VIN").join() === "pack",
    "a net that stars out from a part outside the plan still feeds VIN"
  );
}

{
  const plan = wiring([
    ["nano.5V", "pack.V+"],
    ["nano.5V", "rtop.A"],
  ]);
  expect(
    suppliesOnPort(plan, "rtop", "A").join() === "pack",
    "a divider leg on the 5V net is fed by the supply on that net"
  );
  expect(suppliesOnPort(plan, "nano", "5V").join() === "pack");
}

{
  const plan = wiring([
    ["nano.VIN", "pack.V+"],
    ["nano.5V", "other.V+"],
  ]);
  expect(suppliesOnPort(plan, "nano", "VIN").join() === "pack");
  expect(suppliesOnPort(plan, "nano", "5V").join() === "other");
  expect(
    suppliesOnPort(plan, "rtop", "A").length === 0,
    "a port on no wire has no supply"
  );
}

console.log("supply-feed.selfcheck ok");
