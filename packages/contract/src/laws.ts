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
