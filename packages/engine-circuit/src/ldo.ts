// Fixed-output linear regulator. Not an experiment file.
/**
 * `ldo-regulator@1`. In regulation `OUT = vOut − rOut·I`. In dropout
 * `OUT = IN − dropout(I)`. The two meet in a softmin. Past `iLimit`, and
 * below 0 A, a C1 wall holds the pass current. `iGround` leaves `IN`
 * into `GND` once `IN` is above the bias knee. No per-step state: the
 * law is the solve.
 *
 * The wall is not a reverse diode. A datasheet path from `OUT` back to
 * `IN` stays in the part's omits unless that sheet gives a DC law.
 */
import {
  type DropoutKnot,
  type LdoParams,
  ldoError,
} from "@sfab-bench/contract";

import { gStamp, type PowerSplit, type StampCtx, volt } from "./context";
import type { Element } from "./element";

export type { DropoutKnot, LdoParams };

/** Softmin width, volts. Deep in one region the other term is exp-small. */
const SOFT_V = 0.001;
/** Wall width, amperes. Leakage outside `[0, iLimit]` is a few times this. */
const WALL_A = 1e-5;
/** Volts of wall per (ampere / WALL_A) squared. */
const WALL_V = 1;
/**
 * Ground current turns on around this input, volts. Assumed: the
 * datasheet quiescent is the on value, not a curve.
 */
const BIAS_ON_V = 1.5;
const BIAS_W_V = 0.2;

/** Dropout voltage at `amps`, flat outside the first and last knots. */
export function dropoutAt(
  knots: readonly DropoutKnot[],
  amps: number
): { volts: number; slope: number } {
  const first = knots[0];
  const last = knots[knots.length - 1];
  if (!first || !last) return { volts: 0, slope: 0 };
  if (amps <= first[0]) return { volts: first[1], slope: 0 };
  if (amps >= last[0]) return { volts: last[1], slope: 0 };
  for (let i = 1; i < knots.length; i++) {
    const hi = knots[i];
    const lo = knots[i - 1];
    if (!hi || !lo || amps > hi[0]) continue;
    const span = hi[0] - lo[0];
    const slope = span === 0 ? 0 : (hi[1] - lo[1]) / span;
    return { volts: lo[1] + slope * (amps - lo[0]), slope };
  }
  return { volts: last[1], slope: 0 };
}

function sigmoid(x: number): number {
  if (x > 40) return 1;
  if (x < -40) return 0;
  const e = Math.exp(-x);
  return 1 / (1 + e);
}

/** Quiescent current at an input voltage, amperes. */
export function ldoBias(iGround: number, vin: number): number {
  return iGround * sigmoid((vin - BIAS_ON_V) / BIAS_W_V);
}

function biasSlope(iGround: number, vin: number): number {
  const s = sigmoid((vin - BIAS_ON_V) / BIAS_W_V);
  return (iGround * s * (1 - s)) / BIAS_W_V;
}

/** Output the law commands at this input and pass current, ground at 0. */
export function ldoRegulated(
  params: LdoParams,
  vin: number,
  amps: number,
  sourceScale = 1
): number {
  const drop = dropoutAt(params.dropout, amps);
  const vReg = params.vOut * sourceScale - params.rOut * amps;
  const vDo = vin - drop.volts;
  return softmin(vReg, vDo).v;
}

function softmin(a: number, b: number): { v: number; da: number; db: number } {
  const m = a < b ? a : b;
  const ea = Math.exp((m - a) / SOFT_V);
  const eb = Math.exp((m - b) / SOFT_V);
  const sum = ea + eb;
  return { v: m - SOFT_V * Math.log(sum), da: ea / sum, db: eb / sum };
}

/** Positive outside the interval, zero with zero slope inside. */
function wall(over: number): { v: number; d: number } {
  if (over <= 0) return { v: 0, d: 0 };
  const x = over / WALL_A;
  return { v: WALL_V * x * x, d: (2 * WALL_V * x) / WALL_A };
}

type Law = {
  /** Branch residual. Zero is the device law. */
  f: number;
  dVin: number;
  dVout: number;
  dGnd: number;
  dI: number;
  iG: number;
  g: number;
};

function lawAt(
  params: LdoParams,
  vin: number,
  vout: number,
  vgnd: number,
  amps: number,
  sourceScale: number
): Law {
  const vIn = vin - vgnd;
  const drop = dropoutAt(params.dropout, amps);
  const vReg = params.vOut * sourceScale - params.rOut * amps;
  const vDo = vIn - drop.volts;
  const blend = softmin(vReg, vDo);
  const hi = wall(amps - params.iLimit);
  const lo = wall(-amps);
  const f = vout - vgnd - blend.v + hi.v - lo.v;
  const dvCmd = blend.da * -params.rOut + blend.db * -drop.slope;
  return {
    f,
    dVin: -blend.db,
    dVout: 1,
    dGnd: -1 + blend.db,
    dI: -dvCmd + hi.d - lo.d,
    iG: ldoBias(params.iGround, vIn),
    g: biasSlope(params.iGround, vIn),
  };
}

type Frozen = {
  dVin: number;
  dVout: number;
  dGnd: number;
  dI: number;
  g: number;
};

const ZERO_FROZEN: Frozen = { dVin: 0, dVout: 1, dGnd: -1, dI: 0, g: 0 };

export class LdoRegulator implements Element {
  readonly form = "ldo-regulator@1";
  readonly nonlinear = true;
  private iIn = -1;
  private iOut = -1;
  private iGnd = -1;
  private ibr = -1;
  private frozen: Frozen = ZERO_FROZEN;

  constructor(
    readonly id: string,
    readonly inName: string,
    readonly outName: string,
    readonly gndName: string,
    readonly params: LdoParams
  ) {
    const error = ldoError(params);
    if (error) throw new Error(`${id}: ${error}`);
  }

  nodes(): readonly string[] {
    return [this.inName, this.outName, this.gndName];
  }
  branches(): readonly string[] {
    return [this.id];
  }
  bind(
    nodeOf: (name: string) => number,
    branchOf: (name: string) => number
  ): void {
    this.iIn = nodeOf(this.inName);
    this.iOut = nodeOf(this.outName);
    this.iGnd = nodeOf(this.gndName);
    this.ibr = branchOf(this.id);
  }
  signature(): string {
    return "";
  }
  stamp(ctx: StampCtx): void {
    const vin = volt(ctx, this.iIn);
    const vout = volt(ctx, this.iOut);
    const vgnd = volt(ctx, this.iGnd);
    const amps = volt(ctx, this.ibr);
    const now = lawAt(this.params, vin, vout, vgnd, amps, ctx.sourceScale);
    const row = ctx.rhsOnly ? this.frozen : now;
    if (!ctx.rhsOnly) {
      this.frozen = {
        dVin: now.dVin,
        dVout: now.dVout,
        dGnd: now.dGnd,
        dI: now.dI,
        g: now.g,
      };
      const { A, n } = ctx;
      const ibr = this.ibr;
      if (this.iIn >= 0) {
        A[this.iIn * n + ibr] = (A[this.iIn * n + ibr] as number) + 1;
        A[ibr * n + this.iIn] = row.dVin;
      }
      if (this.iOut >= 0) {
        A[this.iOut * n + ibr] = (A[this.iOut * n + ibr] as number) - 1;
        A[ibr * n + this.iOut] = row.dVout;
      }
      if (this.iGnd >= 0) A[ibr * n + this.iGnd] = row.dGnd;
      A[ibr * n + ibr] = row.dI;
      gStamp(ctx, this.iIn, this.iGnd, row.g);
    }
    const dot =
      row.dVin * vin + row.dVout * vout + row.dGnd * vgnd + row.dI * amps;
    ctx.z[this.ibr] = (ctx.z[this.ibr] as number) + (dot - now.f);
    const i0 = now.iG - row.g * (vin - vgnd);
    if (this.iIn >= 0) ctx.z[this.iIn] = (ctx.z[this.iIn] as number) - i0;
    if (this.iGnd >= 0) ctx.z[this.iGnd] = (ctx.z[this.iGnd] as number) + i0;
  }
  commit(): void {}
  power(ctx: StampCtx): PowerSplit {
    const vin = volt(ctx, this.iIn);
    const vout = volt(ctx, this.iOut);
    const vgnd = volt(ctx, this.iGnd);
    const amps = volt(ctx, this.ibr);
    const iG = ldoBias(this.params.iGround, vin - vgnd);
    const heat = (vin - vout) * amps + (vin - vgnd) * iG;
    return {
      absorbed: heat,
      delivered: 0,
      dissipated: heat,
      storedDot: 0,
      mechanical: 0,
    };
  }
  leaving(ctx: StampCtx): ReadonlyArray<readonly [number, number]> {
    const vin = volt(ctx, this.iIn);
    const vgnd = volt(ctx, this.iGnd);
    const amps = volt(ctx, this.ibr);
    const iG = ldoBias(this.params.iGround, vin - vgnd);
    return [
      [this.iIn, amps + iG],
      [this.iOut, -amps],
      [this.iGnd, -iG],
    ];
  }
}
