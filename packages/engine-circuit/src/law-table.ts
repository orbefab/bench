/** Ported from layered-sim E4 (fd10742). Table stamped as one Thevenin segment in the shared MNA. */

import type { TableLaw } from "@sfab-bench/contract";

import type { StampCtx } from "./context";
import { type PowerSplit, vBranch, volt } from "./context";
import type { Element } from "./element";
import { segmentIndex, segmentThevenin } from "./table";

/**
 * Piecewise-linear `V(p) − V(m)` as one branch between two of the part's
 * ports. No current limit and no floor. Past the knots it extrapolates
 * the end segments. The supply is a separate part, not a term in this law.
 */
export class LawTable implements Element {
  readonly form = "table@1";
  readonly nonlinear = true;
  ip = -1;
  im = -1;
  ibr = -1;
  private segment = 0;
  factoredSegment = 0;
  /** Axis current and port voltage after the last accepted solve. */
  seenAxis = 0;
  seenVolts = 0;
  /** True after the first factor, so a frozen stamp can keep segment 0. */
  private frozen = false;

  constructor(
    readonly id: string,
    private readonly pName: string,
    private readonly mName: string,
    private readonly law: TableLaw
  ) {
    if (law.iAxis.length < 2) throw new Error(`${id}: table needs two knots`);
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

  /** A branch has no current-limit row, so it never holds the rail at 0 V. */
  fallToFloor(): boolean {
    return false;
  }

  /** Stored-axis current for branch current `i` (leaves `p` into the element). */
  private axisAmps(branchI: number): number {
    return this.law.iSense === 1 ? branchI : -branchI;
  }

  private desired(ctx: StampCtx): number {
    const axis = this.axisAmps((ctx.x[this.ibr] as number) ?? 0);
    return segmentIndex(this.law.iAxis, axis);
  }

  stamp(ctx: StampCtx): void {
    const segment =
      ctx.freezeNonlinear && this.frozen
        ? this.factoredSegment
        : this.desired(ctx);
    this.segment = segment;
    if (!ctx.rhsOnly) {
      this.factoredSegment = segment;
      this.frozen = true;
    }
    const volts = this.law.vAxis;
    const { r, voc } = segmentThevenin(volts, this.law.iAxis, segment);
    if (this.law.iSense === 1) {
      // Axis current is the branch current. `v = voc − r·i` becomes
      // `v + r·i = voc` in the stamp, so the resistance sign flips.
      vBranch(ctx, this.ip, this.im, this.ibr, -r, voc);
      return;
    }
    vBranch(ctx, this.ip, this.im, this.ibr, r, voc);
  }

  commit(): void {}

  accepted(ctx: StampCtx): boolean {
    const branchI = (ctx.x[this.ibr] as number) ?? 0;
    this.seenAxis = this.axisAmps(branchI);
    this.seenVolts = volt(ctx, this.ip) - volt(ctx, this.im);
    return this.desired(ctx) === this.segment;
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
