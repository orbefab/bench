// The Uno F1 thermal law, formerly in power-path.ts. Not an experiment file.
/**
 * `ptc-fuse@1`. A cold or hot resistance, chosen outside the solve.
 * One step of `u` per master step, from the current that step solved.
 * A resistance change is `pull`, and the caller drops the factored matrix.
 */
import { gStamp, type PowerSplit, type StampCtx, volt } from "./context";
import type { Element } from "./element";

export type PtcFuseParams = {
  rCold: number;
  rHot: number;
  iHold: number;
  iTrip: number;
  tripPower: number;
  tau: number;
  uReset: number;
};

/** Bourns MF-MSMF050, the numbers on `sfab/mf-msmf050@1.0.0`. */
export const MF_MSMF050: PtcFuseParams = {
  rCold: 0.15,
  rHot: 80,
  iHold: 0.5,
  iTrip: 1,
  tripPower: 0.12,
  /**
   * Seconds. 8 A at rCold dissipates 9.6 W. This pole reaches u = 1
   * in 0.1 s, under the 0.15 s datasheet maximum.
   */
  tau: 0.1 / -Math.log(1 - 0.12 / (8 * 8 * 0.15)),
  uReset: 0.85,
};

export function ptcFuseError(params: PtcFuseParams): string | null {
  if (!(params.rHot > params.rCold)) {
    return "ptc-fuse@1 needs rHot greater than rCold";
  }
  if (!(params.rCold > 0) || !(params.tripPower > 0) || !(params.tau > 0)) {
    return "ptc-fuse@1 needs a positive cold resistance, trip power, and tau";
  }
  return null;
}

export class PtcFuseElement implements Element {
  readonly form = "ptc-fuse@1";
  readonly nonlinear = false;
  u = 0;
  tripped = false;
  /** Ohms the stamp uses. `pull` copies the thermal state in. */
  ohms: number;
  private ia = -1;
  private ib = -1;

  constructor(
    readonly id: string,
    readonly aName: string,
    readonly bName: string,
    readonly params: PtcFuseParams
  ) {
    const error = ptcFuseError(params);
    if (error) throw new Error(`${id}: ${error}`);
    this.ohms = params.rCold;
  }

  nodes(): readonly string[] {
    return [this.aName, this.bName];
  }
  branches(): readonly string[] {
    return [];
  }
  bind(nodeOf: (name: string) => number): void {
    this.ia = nodeOf(this.aName);
    this.ib = nodeOf(this.bName);
  }
  signature(): string {
    return String(this.ohms);
  }
  stamp(ctx: StampCtx): void {
    gStamp(ctx, this.ia, this.ib, 1 / this.ohms);
  }
  commit(): void {}
  /** Amperes A → B from the solved node voltages. */
  current(voltage: (node: string) => number): number {
    return (voltage(this.aName) - voltage(this.bName)) / this.ohms;
  }
  /**
   * One thermal step. Power uses the resistance the solve just stamped.
   * Returns nothing; the next `pull` sees a trip.
   */
  advance(amps: number, dt: number): void {
    const power = amps * amps * this.ohms;
    const steady = power / this.params.tripPower;
    this.u += (dt / this.params.tau) * (steady - this.u);
    if (this.u < 0) this.u = 0;
    if (!this.tripped) {
      if (this.u >= 1) this.tripped = true;
    } else if (this.u <= this.params.uReset) {
      this.tripped = false;
    }
  }
  /** Open before the next solve. The next `pull` stamps rHot. */
  trip(): void {
    this.tripped = true;
    this.u = 1;
  }
  /** Copy the thermal resistance into the stamp. True when it changed. */
  pull(): boolean {
    const next = this.tripped ? this.params.rHot : this.params.rCold;
    if (next === this.ohms) return false;
    this.ohms = next;
    return true;
  }
  power(ctx: StampCtx): PowerSplit {
    const v = volt(ctx, this.ia) - volt(ctx, this.ib);
    const i = v / this.ohms;
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
    const i = (volt(ctx, this.ia) - volt(ctx, this.ib)) / this.ohms;
    return [
      [this.ia, i],
      [this.ib, -i],
    ];
  }
}
