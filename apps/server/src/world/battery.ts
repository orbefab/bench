// A supply with a state of charge. The step is the ptc-fuse pattern: stamp, solve, then move the state. Not an experiment file.
/**
 * `battery@1`. Each master step the terminal is a Thevenin source,
 * `V = ocv(soc)` and `R = rInternal`. After the solve, `soc` moves by
 * `−I·dt/capacity`. At `soc = 0` or when the terminal is at or below
 * `vCutoff`, the next stamp is an ideal voltage `ocv(0)` and the run
 * warns once. The run does not stop.
 */
import type { FormParam, OcvKnot } from "@sfab-bench/contract";

import {
  type PowerSplit,
  type StampCtx,
  vBranch,
  volt,
} from "./circuit/context";
import type { Element } from "./circuit/element";
import { isScalarParam } from "./parts/si";

export type BatteryParams = {
  ocv: readonly OcvKnot[];
  rInternal: number;
  capacity: number;
  soc0: number;
  vCutoff?: number;
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

function readOcv(value: FormParam | undefined): readonly OcvKnot[] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const knots: OcvKnot[] = [];
  for (const row of value) {
    if (!Array.isArray(row) || row.length !== 2) return null;
    const soc = row[0];
    const volts = row[1];
    if (typeof soc !== "number" || typeof volts !== "number") return null;
    knots.push([soc, volts]);
  }
  return knots;
}

function scalar(
  override: number | string | boolean | undefined,
  value: FormParam | undefined
): number | undefined {
  if (override !== undefined) {
    return typeof override === "number" && Number.isFinite(override)
      ? override
      : undefined;
  }
  if (!value || !isScalarParam(value)) return undefined;
  const n = typeof value === "number" ? value : value.v;
  return Number.isFinite(n) ? n : undefined;
}

/** Catalog params plus instance number overrides. `ocv` is not overridden. */
export function batteryFrom(
  params: Record<string, FormParam>,
  overrides: Record<string, number | string | boolean>
): { ok: true; params: BatteryParams } | { ok: false; error: string } {
  const ocv = readOcv(params.ocv);
  if (!ocv) {
    return { ok: false, error: "battery@1 ocv must be [soc, volts] knots" };
  }
  const rInternal = scalar(overrides.rInternal, params.rInternal);
  const capacity = scalar(overrides.capacity, params.capacity);
  const soc0 = scalar(overrides.soc0, params.soc0);
  if (rInternal === undefined || capacity === undefined || soc0 === undefined) {
    return {
      ok: false,
      error: "battery@1 needs rInternal, capacity, and soc0",
    };
  }
  const hasCutoff =
    overrides.vCutoff !== undefined || params.vCutoff !== undefined;
  const vCutoff = hasCutoff
    ? scalar(overrides.vCutoff, params.vCutoff)
    : undefined;
  if (hasCutoff && vCutoff === undefined) {
    return { ok: false, error: "battery@1 vCutoff must be a voltage" };
  }
  const built: BatteryParams = {
    ocv,
    rInternal,
    capacity,
    soc0,
    ...(vCutoff !== undefined ? { vCutoff } : {}),
  };
  const error = batteryError(built);
  if (error) return { ok: false, error };
  return { ok: true, params: built };
}

const EMPTY =
  "terminal is at the empty open-circuit voltage; the run continues";

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
  /** Ohms in the stamp. 0 once the cell is empty, so the terminal is `ocv(0)`. */
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
    this.ohms = 0;
    if (this.warning !== null) return;
    this.warning = EMPTY;
    this.warnCount = 1;
  }
}
