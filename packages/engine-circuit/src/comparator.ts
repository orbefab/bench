// Ideal comparator. Not an experiment file.
/**
 * `comparator@1`. The output is an ideal source to `VP` or `VN`, chosen
 * once per master step from the previous solve. High when
 * `V(P) − V(N)` is above the hysteresis. It starts low. A change is
 * `apply`, and the caller drops the factored matrix. That read is one
 * master step late.
 */
import { type PowerSplit, type StampCtx, vBranch, volt } from "./context";
import type { Element } from "./element";

export class Comparator implements Element {
  readonly form = "comparator@1";
  readonly nonlinear = false;
  /** Stamped state. Starts low: the first solve has no previous inputs. */
  high = false;
  private pending = false;
  private iOut = -1;
  private iVp = -1;
  private iVn = -1;
  private ibr = -1;

  constructor(
    readonly id: string,
    readonly pName: string,
    readonly nName: string,
    readonly outName: string,
    readonly vpName: string,
    readonly vnName: string,
    readonly vHyst = 0
  ) {
    if (!Number.isFinite(vHyst) || vHyst < 0) {
      throw new Error(`${id}: vHyst must be >= 0`);
    }
  }

  nodes(): readonly string[] {
    return [this.pName, this.nName, this.outName, this.vpName, this.vnName];
  }
  branches(): readonly string[] {
    return [this.id];
  }
  bind(
    nodeOf: (name: string) => number,
    branchOf: (name: string) => number
  ): void {
    this.iOut = nodeOf(this.outName);
    this.iVp = nodeOf(this.vpName);
    this.iVn = nodeOf(this.vnName);
    this.ibr = branchOf(this.id);
  }
  signature(): string {
    return this.high ? "h" : "l";
  }

  /** Stamp the latched output. True when the connection changed. */
  apply(): boolean {
    if (this.pending === this.high) return false;
    this.high = this.pending;
    return true;
  }

  /** Remember the decision for the next master step. */
  latch(voltage: (node: string) => number): void {
    const mid = voltage(this.pName) - voltage(this.nName);
    const half = this.vHyst / 2;
    this.pending = this.high ? mid > -half : mid > half;
  }

  stamp(ctx: StampCtx): void {
    if (this.high) vBranch(ctx, this.iOut, this.iVp, this.ibr, 0, 0);
    else vBranch(ctx, this.iOut, this.iVn, this.ibr, 0, 0);
  }
  commit(): void {}
  power(ctx: StampCtx): PowerSplit {
    const vOut = volt(ctx, this.iOut);
    const vRail = this.high ? volt(ctx, this.iVp) : volt(ctx, this.iVn);
    const amps = volt(ctx, this.ibr);
    const heat = (vRail - vOut) * amps;
    return {
      absorbed: heat,
      delivered: 0,
      dissipated: heat,
      storedDot: 0,
      mechanical: 0,
    };
  }
  leaving(ctx: StampCtx): ReadonlyArray<readonly [number, number]> {
    const amps = volt(ctx, this.ibr);
    const rail = this.high ? this.iVp : this.iVn;
    return [
      [this.iOut, amps],
      [rail, -amps],
    ];
  }
}
