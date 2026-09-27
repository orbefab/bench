/** Ported from layered-sim E4 (fd10742). Table stamped as one Thevenin segment in the shared MNA. */

import {
  segmentIndex,
  segmentThevenin,
  shiftedVoltage,
  type TableLaw,
  tableVoltage,
} from "../snapshot-law";
import type { StampCtx } from "./context";
import { type PowerSplit, vBranch, volt } from "./context";
import type { Element } from "./element";

type Region = "cv" | "cc" | "floor";

/**
 * Piecewise-linear `V(p) − V(m)` as one branch.
 * Feed replacement (`iLimit` set) is a Thevenin segment. Above `iLimit`
 * the branch holds that current, with the same enter, leave, and floor
 * rules as `thevenin-limit@1`. The axis for that path is current out of
 * `p` (`iSense` -1).
 * A plain branch (`iLimit` null) has no limit and no floor. Past the
 * knots it extrapolates the end segments.
 */
export class LawTable implements Element {
  readonly form = "table@1";
  readonly nonlinear = true;
  readonly use: "feed" | "branch";
  ip = -1;
  im = -1;
  ibr = -1;
  private region: Region = "cv";
  private segment = 0;
  factoredRegion: Region | null = null;
  factoredSegment = 0;
  /**
   * Set when a current-limit stamp is singular (the load cannot draw
   * exactly `iLimit`). The next stamp holds the rail at 0 V.
   */
  private holdFloor = false;
  /** Delivered-current limit. 0 on a plain branch, which never reads it. */
  private readonly limit: number;

  constructor(
    readonly id: string,
    private readonly pName: string,
    private readonly mName: string,
    private readonly law: TableLaw,
    private readonly supply: number,
    /** Null is a plain branch. A feed passes the source current limit. */
    readonly iLimit: number | null
  ) {
    if (law.iAxis.length < 2) throw new Error(`${id}: table needs two knots`);
    this.use = iLimit === null ? "branch" : "feed";
    this.limit = iLimit ?? 0;
    if (this.use === "feed" && !(this.limit > 0)) {
      throw new Error(`${id}: Ilim > 0`);
    }
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
    return "";
  }

  /** The current-limit row conflicted with the load. Hold 0 V next stamp. */
  fallToFloor(): boolean {
    if (this.use === "branch" || this.region !== "cc") return false;
    this.holdFloor = true;
    return true;
  }

  /** Stored-axis current for branch current `i` (leaves `p` into the element). */
  private axisAmps(branchI: number): number {
    return this.law.iSense === 1 ? branchI : -branchI;
  }

  private desired(ctx: StampCtx): { region: Region; segment: number } {
    if (this.use === "branch") {
      const axis = this.axisAmps((ctx.x[this.ibr] as number) ?? 0);
      return { region: "cv", segment: segmentIndex(this.law.iAxis, axis) };
    }
    const tol = 1e-9;
    if (this.holdFloor) {
      this.holdFloor = false;
      return { region: "floor", segment: this.segment };
    }
    const iLoad = -((ctx.x[this.ibr] as number) ?? 0);
    const vt = volt(ctx, this.ip) - volt(ctx, this.im);
    if (vt < -tol) return { region: "floor", segment: this.segment };
    if (this.region === "floor") {
      const vCv = tableVoltage(this.law, this.supply, iLoad);
      if (iLoad <= this.limit + tol && vCv > tol) {
        return {
          region: "cv",
          segment: segmentIndex(this.law.iAxis, iLoad),
        };
      }
      return { region: "floor", segment: this.segment };
    }
    if (this.region === "cv") {
      if (iLoad > this.limit + tol) {
        return { region: "cc", segment: this.segment };
      }
      return { region: "cv", segment: segmentIndex(this.law.iAxis, iLoad) };
    }
    const volts = shiftedVoltage(this.law, this.supply);
    const iUnc = unconstrainedAmps(volts, this.law.iAxis, vt);
    if (iUnc < this.limit - tol) {
      return { region: "cv", segment: segmentIndex(this.law.iAxis, iUnc) };
    }
    return { region: "cc", segment: this.segment };
  }

  stamp(ctx: StampCtx): void {
    const next =
      ctx.freezeNonlinear && this.factoredRegion !== null
        ? { region: this.factoredRegion, segment: this.factoredSegment }
        : this.desired(ctx);
    this.region = next.region;
    this.segment = next.segment;
    if (!ctx.rhsOnly) {
      this.factoredRegion = next.region;
      this.factoredSegment = next.segment;
    }
    if (next.region === "floor") {
      vBranch(ctx, this.ip, this.im, this.ibr, 0, 0);
      return;
    }
    if (next.region === "cc") {
      if (!ctx.rhsOnly) {
        vBranch(ctx, this.ip, this.im, this.ibr, 0, 0);
        currentRow(ctx, this.ibr, -this.limit);
      } else {
        ctx.z[this.ibr] = -this.limit;
      }
      return;
    }
    const volts = shiftedVoltage(this.law, this.supply);
    const { r, voc } = segmentThevenin(volts, this.law.iAxis, next.segment);
    if (this.use === "branch" && this.law.iSense === 1) {
      // Axis current is the branch current. `v = voc − r·i` becomes
      // `v + r·i = voc` in the stamp, so the resistance sign flips.
      vBranch(ctx, this.ip, this.im, this.ibr, -r, voc);
      return;
    }
    vBranch(ctx, this.ip, this.im, this.ibr, r, voc);
  }

  commit(): void {}

  accepted(ctx: StampCtx): boolean {
    const next = this.desired(ctx);
    return next.region === this.region && next.segment === this.segment;
  }

  power(ctx: StampCtx): PowerSplit {
    const i = ctx.x[this.ibr] as number;
    const vt = volt(ctx, this.ip) - volt(ctx, this.im);
    const iLoad = -i;
    const absorbed = vt * i;
    return {
      absorbed,
      delivered: vt * iLoad,
      dissipated: 0,
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
}

/** Current the piecewise law would supply at `vt`, with the ends extrapolated. */
function unconstrainedAmps(
  volts: readonly number[],
  iAxis: readonly number[],
  vt: number
): number {
  const last = iAxis.length - 2;
  const tol = 1e-9;
  for (let k = 0; k <= last; k++) {
    const { r, voc } = segmentThevenin(volts, iAxis, k);
    if (!(r > 0)) {
      if (k === last && vt < voc - tol) return Number.POSITIVE_INFINITY;
      continue;
    }
    const i = (voc - vt) / r;
    const i0 = iAxis[k] ?? 0;
    const i1 = iAxis[k + 1] ?? i0;
    const lo = k === 0 ? Number.NEGATIVE_INFINITY : i0;
    const hi = k === last ? Number.POSITIVE_INFINITY : i1;
    if (i >= lo - tol && i <= hi + tol) return i;
  }
  return Number.POSITIVE_INFINITY;
}

function currentRow(ctx: StampCtx, iCol: number, value: number): void {
  const { A, z, n } = ctx;
  const row = iCol * n;
  for (let j = 0; j < n; j++) A[row + j] = 0;
  A[row + iCol] = 1;
  z[iCol] = value;
}
