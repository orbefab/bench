// A supply with a state of charge. The step is the ptc-fuse pattern: stamp, solve, then move the state. Not an experiment file.
/**
 * `battery@1`. Each master step the terminal is a Thevenin source,
 * `V = ocv(soc)` and `R = rInternal`. After the solve, `soc` moves by
 * `−I·dt/capacity`. At `soc = 0` or when the terminal is at or below
 * `vCutoff`, the next stamp is an ideal voltage `ocv(0)` and the run
 * warns once. The run does not stop.
 */
import { type BatteryParams, ocvAt } from "@sfab-bench/contract";

import { type PowerSplit, type StampCtx, vBranch, volt } from "./context";
import type { Element } from "./element";

export type { BatteryParams };

function batteryError(params: BatteryParams): string | null {
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

const EMPTY = "empty cell keeps its internal resistance; the run continues";

export class BatteryElement implements Element {
  readonly form = "battery@1";
  readonly nonlinear = false;
  /** Charge left after the latest step, 0 to 1. */
  soc: number;
  /** Charge the stamp used for the latest step. */
  stampedSoc: number;
  /** Set once, when the cell first reads empty. */
  warning: string | null = null;
  warnCount = 0;
  /** Ohms in the stamp. An empty cell keeps `rInternal`. */
  private ohms: number;
  /** Volts in the stamp. */
  private volts: number;
  /** Ohms already in the factored matrix. */
  private applied: number;
  private empty = false;
  private ip = -1;
  private im = -1;
  private ibr = -1;

  constructor(
    readonly id: string,
    readonly pName: string,
    readonly mName: string,
    readonly params: BatteryParams
  ) {
    const error = batteryError(params);
    if (error) throw new Error(`${id}: ${error}`);
    this.soc = params.soc0;
    this.stampedSoc = params.soc0;
    this.volts = ocvAt(params.ocv, params.soc0);
    this.ohms = params.rInternal;
    this.applied = this.ohms;
    if (!(this.soc > 0)) this.latch(0);
  }

  nodes(): readonly string[] {
    return [this.pName, this.mName];
  }
  branches(): readonly string[] {
    return [this.id];
  }
  bind(
    nodeOf: (name: string) => number,
    branchOf: (name: string) => number
  ): void {
    this.ip = nodeOf(this.pName);
    this.im = nodeOf(this.mName);
    this.ibr = branchOf(this.id);
  }
  signature(): string {
    return String(this.ohms);
  }
  /**
   * True once, when the resistance changed since the last pull.
   * The caller drops the factored matrix.
   */
  pull(): boolean {
    if (this.ohms === this.applied) return false;
    this.applied = this.ohms;
    return true;
  }
  stamp(ctx: StampCtx): void {
    vBranch(ctx, this.ip, this.im, this.ibr, this.ohms, this.volts);
  }
  commit(): void {}
  /**
   * One coulomb step from the current the solve just accepted.
   * Positive `amps` discharges. An empty cell stays empty.
   */
  advance(amps: number, dt: number): void {
    this.stampedSoc = this.soc;
    if (this.empty) return;
    const terminal = this.volts - amps * this.ohms;
    const next = this.soc - (amps * dt) / this.params.capacity;
    const hitSoc = !(next > 0);
    const cutoff = this.params.vCutoff;
    const hitV = cutoff !== undefined && !(terminal > cutoff);
    if (hitSoc || hitV) {
      this.latch(hitSoc ? 0 : next > 1 ? 1 : next);
      return;
    }
    this.soc = next > 1 ? 1 : next;
    this.volts = ocvAt(this.params.ocv, this.soc);
  }
  power(ctx: StampCtx): PowerSplit {
    const i = ctx.x[this.ibr] as number;
    const vt = volt(ctx, this.ip) - volt(ctx, this.im);
    const iLoad = -i;
    return {
      absorbed: vt * i,
      delivered: this.volts * iLoad,
      dissipated: iLoad * iLoad * this.ohms,
      storedDot: 0,
      mechanical: 0,
    };
  }
  leaving(ctx: StampCtx): ReadonlyArray<readonly [number, number]> {
    const i = ctx.x[this.ibr] as number;
    return [
      [this.ip, i],
      [this.im, -i],
    ];
  }

  private latch(soc: number): void {
    this.empty = true;
    this.soc = soc;
    this.volts = ocvAt(this.params.ocv, 0);
    if (this.warning !== null) return;
    this.warning = EMPTY;
    this.warnCount = 1;
  }
}
