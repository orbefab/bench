// Ported from layered-sim E3 src/harness.ts @ fc7e8d3 (pin levels only; no avr8js).

import { capacitor, resistor, vSource } from "./elements";
import { Engine } from "./engine";
import { PIN_ROH, PIN_ROL, Pin, type PinMode } from "./pin";

/** Edge-exact is the live level. Averaged duty is the cheaper one. */
export type PinLevelName = "edge" | "averaged";

export type PinLevel = {
  name: PinLevelName;
  /** Effects this level leaves out. Averaged duty lists ripple. */
  omits: readonly string[];
};

export const EDGE_EXACT: PinLevel = { name: "edge", omits: [] };
export const AVERAGED_DUTY: PinLevel = { name: "averaged", omits: ["ripple"] };

/** Default live level for a pin net. */
export const DEFAULT_PIN_LEVEL: PinLevel = EDGE_EXACT;

export type PwmSample = { t: number; v: number };

/**
 * Charge-balance Thevenin of a pin that is high for `duty` of each period,
 * into a series resistor. Ripple is not in this equivalent.
 */
export function averagedThevenin(opts: {
  duty: number;
  rail: number;
  rSeries: number;
  roh?: number;
  rol?: number;
}): { v: number; r: number } {
  const d = Math.min(1, Math.max(0, opts.duty));
  const rh = (opts.roh ?? PIN_ROH) + opts.rSeries;
  const rl = (opts.rol ?? PIN_ROL) + opts.rSeries;
  const geq = d / rh + (1 - d) / rl;
  if (!(geq > 0)) return { v: 0, r: 1e12 };
  return { v: (d * opts.rail) / rh / geq, r: 1 / geq };
}

/**
 * PWM into an RC. `edge` steps to each pin edge. `averaged` takes one
 * backward-Euler step per period at the charge-balance voltage.
 */
export function simulatePinPwm(opts: {
  level: PinLevelName;
  duty: number;
  period: number;
  rail: number;
  rSeries: number;
  c: number;
  tStop: number;
  /** Sub-step between edges. Ignored by the averaged level. */
  h: number;
}): PwmSample[] {
  if (opts.level === "averaged") return runAveraged(opts);
  return runEdge(opts);
}

function runAveraged(opts: {
  duty: number;
  period: number;
  rail: number;
  rSeries: number;
  c: number;
  tStop: number;
}): PwmSample[] {
  const eq = averagedThevenin(opts);
  const eng = new Engine(
    [
      vSource("veq", "src", "0", { kind: "dc", value: eq.v }),
      resistor("req", "src", "out", eq.r),
      capacitor("c", "out", "0", opts.c),
    ],
    { method: "be", h: opts.period, uic: true }
  );
  eng.operatingPoint();
  const out: PwmSample[] = [{ t: 0, v: eng.voltage("out") }];
  let k = 1;
  while (k * opts.period <= opts.tStop + 1e-15) {
    eng.stepTo(k * opts.period);
    out.push({ t: eng.t, v: eng.voltage("out") });
    k += 1;
  }
  if (out[out.length - 1]!.t < opts.tStop - 1e-15) {
    eng.stepTo(opts.tStop);
    out.push({ t: eng.t, v: eng.voltage("out") });
  }
  return out;
}

function runEdge(opts: {
  duty: number;
  period: number;
  rail: number;
  rSeries: number;
  c: number;
  tStop: number;
  h: number;
}): PwmSample[] {
  const pin = new Pin("pwm", "pin", "rail");
  pin.setMode("high");
  const eng = new Engine(
    [
      vSource("vrail", "rail", "0", { kind: "dc", value: opts.rail }),
      ...pin.elements(),
      resistor("rf", "pin", "out", opts.rSeries),
      capacitor("c", "out", "0", opts.c),
    ],
    { method: "be", h: opts.h, uic: true }
  );
  eng.operatingPoint();
  const out: PwmSample[] = [{ t: 0, v: eng.voltage("out") }];
  const edges = pwmEdges(opts.duty, opts.period, opts.tStop);
  let t = 0;
  let edgeIndex = 0;
  while (t < opts.tStop - 1e-15) {
    const tEdge = edgeIndex < edges.length ? edges[edgeIndex]!.t : opts.tStop;
    const target = Math.min(tEdge, opts.tStop);
    let next = t + opts.h;
    while (next < target - 1e-15) {
      eng.stepTo(next);
      out.push({ t: eng.t, v: eng.voltage("out") });
      next += opts.h;
    }
    eng.stepTo(target);
    out.push({ t: eng.t, v: eng.voltage("out") });
    t = eng.t;
    if (edgeIndex < edges.length && target === edges[edgeIndex]!.t) {
      pin.setMode(edges[edgeIndex]!.mode);
      edgeIndex += 1;
    }
  }
  return out;
}

/** Mode to apply after integrating up to `t`. Starts high at t = 0. */
function pwmEdges(
  duty: number,
  period: number,
  tStop: number
): { t: number; mode: PinMode }[] {
  const d = Math.min(1, Math.max(0, duty));
  const edges: { t: number; mode: PinMode }[] = [];
  for (let k = 0; ; k++) {
    const rise = k * period;
    const fall = rise + d * period;
    if (rise >= tStop - 1e-15 && k > 0) break;
    if (fall > rise + 1e-15 && fall <= tStop + 1e-15) {
      edges.push({ t: fall, mode: "low" });
    }
    const next = (k + 1) * period;
    if (next <= tStop + 1e-15 && d < 1 - 1e-15) {
      edges.push({ t: next, mode: "high" });
    }
    if (next >= tStop - 1e-15) break;
  }
  return edges;
}
