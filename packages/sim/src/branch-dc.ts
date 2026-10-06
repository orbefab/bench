/** Ported from layered-sim E4 (fd10742). DC drop of a composite's own ports. */

import {
  AVR_PIN,
  Diode,
  Engine,
  ISource,
  VSource,
} from "@sfab-bench/engine-circuit";
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
  const volts = engine.voltage(pNode) - vm;
  if (!Number.isFinite(volts)) {
    throw new Error(`${amps} A into ${p}: the drop is not finite`);
  }
  // A converged point can still be the solver's own leak: a reverse diode
  // carries only gmin, so 1 µA reads about −1 MV. When most of the current
  // takes that path, no part carries it and the number is not the part's.
  const leak = gminLeak(engine);
  if (amps !== 0 && leak > 0.5 * Math.abs(amps)) {
    throw new Error(
      `${amps} A into ${p}: ${leak} A of it is the solver's gmin leak, not a path through the part (${volts} V)`
    );
  }
  return volts;
}

/** Amperes the diodes' gmin conductances carry at the solved point. */
function gminLeak(engine: Engine): number {
  let leak = 0;
  for (const el of engine.elements) {
    if (!(el instanceof Diode)) continue;
    const junction = el.params.Rs > 0 ? `${el.id}#j` : el.aName;
    leak += Math.abs(
      el.gmin * (engine.voltage(junction) - engine.voltage(el.kName))
    );
  }
  return leak;
}
