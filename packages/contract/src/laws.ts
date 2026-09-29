/**
 * Shapes both the document layer and the circuit engine read.
 * `ocvAt` lives here so the linter and the battery element share one curve.
 */
import type { OcvKnot } from "./layered";

/**
 * `vAxis` is `V(across[0]) − V(across[1])`.
 * `iAxis` is current into `across[0]` when `iSense` is 1, and current
 * out of that port when `iSense` is -1. A source's output is negative
 * under the port convention.
 */
export type TableLaw = {
  across: readonly [string, string];
  iSense: 1 | -1;
  iAxis: readonly number[];
  vAxis: readonly number[];
};

export type BatteryParams = {
  ocv: readonly OcvKnot[];
  rInternal: number;
  capacity: number;
  soc0: number;
  vCutoff?: number;
};

/** `[amps, volts]`, current rising, dropout not falling. */
export type DropoutKnot = readonly [number, number];

export type LdoParams = {
  vOut: number;
  dropout: readonly DropoutKnot[];
  iGround: number;
  iLimit: number;
  rOut: number;
};

/** The first thing wrong with a `battery@1` parameter set, or `null`. */
export function batteryError(params: BatteryParams): string | null {
  const knots = params.ocv;
  const first = knots[0];
  const last = knots[knots.length - 1];
  if (!first || !last || knots.length < 2) {
    return "battery@1 ocv needs at least two knots";
  }
  if (first[0] !== 0 || last[0] !== 1) {
    return "battery@1 ocv must run from soc 0 to soc 1";
  }
  if (!Number.isFinite(first[1]) || first[1] < 0) {
    return "battery@1 ocv voltage must be finite and >= 0";
  }
  for (let i = 1; i < knots.length; i++) {
    const prev = knots[i - 1];
    const knot = knots[i];
    if (!prev || !knot) return "battery@1 ocv needs at least two knots";
    if (!(knot[0] > prev[0])) return "battery@1 ocv soc must increase";
    if (!(knot[1] >= prev[1])) {
      return "battery@1 ocv voltage must not fall as soc rises";
    }
    if (!Number.isFinite(knot[1]) || knot[1] < 0) {
      return "battery@1 ocv voltage must be finite and >= 0";
    }
  }
  if (!(params.rInternal >= 0) || !Number.isFinite(params.rInternal)) {
    return "battery@1 rInternal must be >= 0";
  }
  if (!(params.capacity > 0) || !Number.isFinite(params.capacity)) {
    return "battery@1 capacity must be positive";
  }
  if (
    !(params.soc0 >= 0) ||
    !(params.soc0 <= 1) ||
    !Number.isFinite(params.soc0)
  ) {
    return "battery@1 soc0 must be from 0 to 1";
  }
  if (params.vCutoff !== undefined && !Number.isFinite(params.vCutoff)) {
    return "battery@1 vCutoff must be finite";
  }
  return null;
}

/** The first thing wrong with an `ldo-regulator@1` parameter set, or `null`. */
export function ldoError(params: LdoParams): string | null {
  if (!Number.isFinite(params.vOut))
    return "ldo-regulator@1 vOut must be finite";
  if (!(params.iLimit > 0) || !Number.isFinite(params.iLimit)) {
    return "ldo-regulator@1 iLimit must be positive";
  }
  if (!(params.iGround >= 0) || !Number.isFinite(params.iGround)) {
    return "ldo-regulator@1 iGround must be >= 0";
  }
  if (!(params.rOut >= 0) || !Number.isFinite(params.rOut)) {
    return "ldo-regulator@1 rOut must be >= 0";
  }
  const knots = params.dropout;
  const first = knots[0];
  if (!first) return "ldo-regulator@1 dropout needs a knot";
  if (
    !Number.isFinite(first[0]) ||
    !Number.isFinite(first[1]) ||
    first[1] < 0
  ) {
    return "ldo-regulator@1 dropout knots must be finite, volts >= 0";
  }
  for (let i = 1; i < knots.length; i++) {
    const prev = knots[i - 1];
    const knot = knots[i];
    if (!prev || !knot) return "ldo-regulator@1 dropout needs a knot";
    if (!(knot[0] > prev[0])) {
      return "ldo-regulator@1 dropout current must increase";
    }
    if (!(knot[1] >= prev[1])) {
      return "ldo-regulator@1 dropout voltage must not fall as current rises";
    }
    if (!Number.isFinite(knot[1]) || knot[1] < 0) {
      return "ldo-regulator@1 dropout knots must be finite, volts >= 0";
    }
  }
  return null;
}

export function ocvAt(ocv: readonly OcvKnot[], soc: number): number {
  const s = soc <= 0 ? 0 : soc >= 1 ? 1 : soc;
  const first = ocv[0];
  const last = ocv[ocv.length - 1];
  if (!first || !last) return 0;
  if (s <= first[0]) return first[1];
  if (s >= last[0]) return last[1];
  for (let i = 1; i < ocv.length; i++) {
    const hi = ocv[i];
    const lo = ocv[i - 1];
    if (!hi || !lo || s > hi[0]) continue;
    const span = hi[0] - lo[0];
    const t = span === 0 ? 0 : (s - lo[0]) / span;
    return lo[1] + t * (hi[1] - lo[1]);
  }
  return last[1];
}
