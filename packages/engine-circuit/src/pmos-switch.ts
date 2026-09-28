// Uno T1, onsemi FDN340P, formerly the resistor-plus-diode in power-path.ts.
/**
 * `pmos-switch@1` channel. The body diode is a sibling `diode@1`.
 * The gate is latched from the previous solve: on when V(G) − V(S) ≤ vth.
 * Until that solve, the channel is on. A change is `apply`, and the
 * caller drops the factored matrix.
 */
import { gStamp, type PowerSplit, type StampCtx, volt } from "./context";
import type { Element } from "./element";

export class PmosChannel implements Element {
  readonly form = "pmos-switch@1";
  readonly nonlinear = false;
  /** Stamped state. Starts on: the first solve has no previous gate. */
  on = true;
  private pending = true;
  private is = -1;
  private idrain = -1;
  private ig = -1;

  constructor(
    readonly id: string,
    readonly sName: string,
    readonly dName: string,
    readonly gName: string,
    readonly rds: number,
    readonly vth: number
  ) {
    if (!(rds > 0)) throw new Error(`${id}: rds must be positive`);
    if (!Number.isFinite(vth)) throw new Error(`${id}: vth must be finite`);
  }

  nodes(): readonly string[] {
    return [this.sName, this.dName, this.gName];
  }
  branches(): readonly string[] {
    return [];
  }
  bind(nodeOf: (name: string) => number): void {
    this.is = nodeOf(this.sName);
    this.idrain = nodeOf(this.dName);
    this.ig = nodeOf(this.gName);
  }
  signature(): string {
    return this.on ? "on" : "off";
  }
  stamp(ctx: StampCtx): void {
    if (!this.on) return;
    gStamp(ctx, this.is, this.idrain, 1 / this.rds);
  }
  commit(): void {}
  /** Remember the gate for the next master step. */
  latch(voltage: (node: string) => number): void {
    const vgs = voltage(this.gName) - voltage(this.sName);
    this.pending = vgs <= this.vth;
  }
  /** Copy the latched gate into the stamp. True when it changed. */
  apply(): boolean {
    if (this.pending === this.on) return false;
    this.on = this.pending;
    return true;
  }
  power(ctx: StampCtx): PowerSplit {
    if (!this.on) {
      return {
        absorbed: 0,
        delivered: 0,
        dissipated: 0,
        storedDot: 0,
        mechanical: 0,
      };
    }
    const v = volt(ctx, this.is) - volt(ctx, this.idrain);
    const i = v / this.rds;
    const p = v * i;
    return {
      absorbed: p,
      delivered: 0,
      dissipated: p,
      storedDot: 0,
      mechanical: 0,
    };
  }
  leaving(ctx: StampCtx): ReadonlyArray<readonly [number, number]> {
    if (!this.on) {
      return [
        [this.is, 0],
        [this.idrain, 0],
        [this.ig, 0],
      ];
    }
    const i = (volt(ctx, this.is) - volt(ctx, this.idrain)) / this.rds;
    return [
      [this.is, i],
      [this.idrain, -i],
      [this.ig, 0],
    ];
  }
}
