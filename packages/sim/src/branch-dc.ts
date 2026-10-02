/** Ported from layered-sim E4 (fd10742). DC drop of a composite's own ports. */

import { AVR_PIN, Engine, ISource, VSource } from "@sfab-bench/engine-circuit";
import type { BoardStamp } from "./circuit-stamp";
import { realize } from "./circuit-stamp";

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
