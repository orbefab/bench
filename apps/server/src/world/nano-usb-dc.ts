/** Ported from layered-sim E4 (fd10742). DC sweep of a class-2 board input. */

import { ISource, Resistor, VSource } from "./circuit/elements";
import { Engine } from "./circuit/engine";
import { AVR_PIN } from "./circuit/pin";
import type { BoardStamp } from "./circuit-stamp";
import { realize } from "./circuit-stamp";

/**
 * Steady load-port voltage of a flattened class-2 netlist.
 * Capacitors are open at DC. Chip pins stay inputs, so an onboard
 * LED draws only its leakage.
 */
export function netlistDc(
  stamp: BoardStamp,
  supply: number,
  amps: number,
  rSeries: number,
  feed: "usb" | "header",
  loadPort: string
): number {
  const realized = realize(stamp, feed, AVR_PIN);
  const load = stamp.portNodes[loadPort];
  if (!load) throw new Error(`stamp has no ${loadPort} node`);
  const engine = new Engine(
    [
      new VSource("v", "src", "0", { kind: "dc", value: supply }),
      new Resistor("rs", "src", realized.feedNode, rSeries),
      ...realized.elements,
      new ISource("load", load, "0", { kind: "dc", value: amps }),
    ],
    { method: "be", h: 1e-3, atol: 1e-14, rtol: 1e-12 }
  );
  engine.operatingPoint();
  return engine.voltage(load);
}

/**
 * `V(p) − V(m)` of a composite alone. `m` is held at 0 V and the source
 * pushes `amps` into `p`, so an open diode node is not the unknown.
 */
export function branchDc(
  stamp: BoardStamp,
  p: string,
  m: string,
  amps: number
): number {
  const pNode = stamp.portNodes[p];
  const mNode = stamp.portNodes[m];
  if (!pNode) throw new Error(`stamp has no ${p} node`);
  if (!mNode) throw new Error(`stamp has no ${m} node`);
  const realized = realize(stamp, "header", AVR_PIN, {
    pins: false,
    keep: [pNode, mNode],
  });
  const held =
    mNode === "0"
      ? []
      : [new VSource("vm", mNode, "0", { kind: "dc", value: 0 })];
  const engine = new Engine(
    [
      ...realized.elements,
      ...held,
      new ISource("is", "0", pNode, { kind: "dc", value: amps }),
    ],
    { method: "be", h: 1e-3, atol: 1e-14, rtol: 1e-12 }
  );
  engine.operatingPoint();
  const vm = mNode === "0" ? 0 : engine.voltage(mNode);
  return engine.voltage(pNode) - vm;
}
