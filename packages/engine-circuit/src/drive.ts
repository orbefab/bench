/**
 * A motor driven through its own terminals: the winding, the averaged
 * bridge that drives it, and the potentiometer that reads a shaft. Each
 * holds its mechanical or control input (ω, the bridge ratio, the wiper)
 * for the master step. The caller sets it between solves.
 */
import {
  gStamp,
  type PowerSplit,
  type StampCtx,
  vBranch,
  volt,
} from "./context";
import type { Element } from "./element";

/**
 * An element whose held inputs are written into the factored matrix.
 * `factorStable` is false once an input changed since the factor.
 * `accepted` is false when the solution contradicts a region the stamp
 * chose.
 */
export interface HeldElement extends Element {
  factorStable(): boolean;
  accepted(ctx: StampCtx): boolean;
}

export function isHeld(el: Element): el is HeldElement {
  return typeof (el as Partial<HeldElement>).factorStable === "function";
}

/**
 * `dc-motor@1`: a winding from `A` to `B`. The branch current `I` flows
 * A → B, and `V(A) − V(B) = R·I + L·dI/dt + K·ω`. ω is the shaft speed,
 * held across the electrical sub-steps. `L = 0` is the algebraic law.
 * The torque `efficiency·K·I` is the caller's: this element only
 * reports the current.
 */
export class DcWinding implements Element {
  readonly form = "dc-motor@1";
  readonly nonlinear = false;
  /** Shaft speed, rad/s, held for the master step. */
  omega = 0;
  private ia = -1;
  private ib = -1;
  private ibr = -1;
  private iPrev = 0;
  private vLPrev = 0;
  constructor(
    readonly id: string,
    readonly aName: string,
    readonly bName: string,
    readonly R: number,
    readonly L: number,
    readonly K: number
  ) {
    if (!(R > 0) || !(L >= 0) || !Number.isFinite(K)) {
      throw new Error(`${id}: R > 0, L >= 0 and a finite K`);
    }
  }
  nodes(): readonly string[] {
    return [this.aName, this.bName];
  }
  branches(): readonly string[] {
    return [this.id];
  }
  bind(
    nodeOf: (name: string) => number,
    branchOf: (name: string) => number
  ): void {
    this.ia = nodeOf(this.aName);
    this.ib = nodeOf(this.bName);
    this.ibr = branchOf(this.id);
  }
  signature(): string {
    return "";
  }
  stamp(ctx: StampCtx): void {
    const bemf = this.K * this.omega;
    let g = 0;
    let e = bemf;
    if (!ctx.dc && this.L > 0) {
      if (ctx.method === "trap") {
        g = (2 * this.L) / ctx.h;
        e = bemf - g * this.iPrev - this.vLPrev;
      } else {
        g = this.L / ctx.h;
        e = bemf - g * this.iPrev;
      }
    }
    vBranch(ctx, this.ia, this.ib, this.ibr, this.R + g, e);
  }
  commit(ctx: StampCtx): void {
    const i = ctx.x[this.ibr] as number;
    if (ctx.dc || this.L === 0) {
      this.vLPrev = 0;
      this.iPrev = i;
      return;
    }
    const v = volt(ctx, this.ia) - volt(ctx, this.ib);
    this.vLPrev = v - this.R * i - this.K * this.omega;
    this.iPrev = i;
  }
  power(ctx: StampCtx): PowerSplit {
    const i = ctx.x[this.ibr] as number;
    const elec = (volt(ctx, this.ia) - volt(ctx, this.ib)) * i;
    const copper = this.R * i * i;
    const mechanical = this.K * this.omega * i;
    return {
      absorbed: elec,
      delivered: 0,
      dissipated: copper,
      storedDot: elec - copper - mechanical,
      mechanical,
    };
  }
  leaving(ctx: StampCtx): ReadonlyArray<readonly [number, number]> {
    const i = ctx.x[this.ibr] as number;
    return [
      [this.ia, i],
      [this.ib, -i],
    ];
  }
}

/**
 * An open bridge output. It is a resistance to GND rather than a zero
 * current, so a winding across two open outputs keeps a node voltage.
 */
export const OPEN_OUTPUT_OHMS = 1e6;

/**
 * Averaged sign-magnitude H-bridge. With ratio `s > 0`, `OUT+` sits at
 * `s·V(V+)` and `OUT−` at GND. With `s < 0` the two swap. At `s = 0`
 * both sit at GND, which brakes a winding across them. The supply side
 * draws `|s|·I` from `V+` while the output delivers power (motoring).
 * A braking current is clipped (ADR 0010): it does not return to `V+`.
 * Open (`connected` false): both outputs are `OPEN_OUTPUT_OHMS` to GND.
 *
 * `sense` is high-Z. `latch` stores `(V(sense) − V(GND)) / (V(V+) − V(GND))`
 * after a solve, so a loop that reads it is one master step late.
 */
export class BridgeDriver implements HeldElement {
  readonly form = "averaged-bridge";
  readonly nonlinear = true;
  /** Bridge ratio in [−1, 1], held for the master step. */
  s = 0;
  /** False opens both outputs. */
  connected = false;
  /** Sense ratio from the last solve. Null until a powered solve. */
  senseRatio: number | null = null;
  private factoredS = Number.NaN;
  private factoredConnected = false;
  private factoredMotoring = true;
  private stampedMotoring = true;
  private ivp = -1;
  private ignd = -1;
  private iop = -1;
  private iom = -1;
  private brp = -1;
  private brm = -1;
  constructor(
    readonly id: string,
    readonly vpName: string,
    readonly gndName: string,
    readonly outPName: string,
    readonly outMName: string,
    readonly senseName: string | null
  ) {}
  nodes(): readonly string[] {
    const names = [this.vpName, this.gndName, this.outPName, this.outMName];
    return this.senseName ? [...names, this.senseName] : names;
  }
  branches(): readonly string[] {
    return [`${this.id}+`, `${this.id}-`];
  }
  bind(
    nodeOf: (name: string) => number,
    branchOf: (name: string) => number
  ): void {
    this.ivp = nodeOf(this.vpName);
    this.ignd = nodeOf(this.gndName);
    this.iop = nodeOf(this.outPName);
    this.iom = nodeOf(this.outMName);
    this.brp = branchOf(`${this.id}+`);
    this.brm = branchOf(`${this.id}-`);
  }
  signature(): string {
    return "";
  }
  /** The output that carries the ratio, and its branch. */
  private active(s: number): { node: number; branch: number; r: number } {
    return s >= 0
      ? { node: this.iop, branch: this.brp, r: s }
      : { node: this.iom, branch: this.brm, r: -s };
  }
  /** Amperes the active output delivers into the load. */
  private delivered(ctx: StampCtx, s: number): number {
    return -((ctx.x[this.active(s).branch] as number) ?? 0);
  }
  private desiredMotoring(ctx: StampCtx): boolean {
    const out = this.active(this.s);
    const p = out.r * this.delivered(ctx, this.s);
    if (p > 1e-12) return true;
    if (p < -1e-12) return false;
    return this.stampedMotoring;
  }
  factorStable(): boolean {
    return (
      this.s === this.factoredS && this.connected === this.factoredConnected
    );
  }
  accepted(ctx: StampCtx): boolean {
    if (!this.connected) return true;
    return this.desiredMotoring(ctx) === this.stampedMotoring;
  }
  stamp(ctx: StampCtx): void {
    const connected = ctx.freezeNonlinear
      ? this.factoredConnected
      : this.connected;
    if (!connected) {
      this.stampedMotoring = false;
      vBranch(ctx, this.iop, this.ignd, this.brp, OPEN_OUTPUT_OHMS, 0);
      vBranch(ctx, this.iom, this.ignd, this.brm, OPEN_OUTPUT_OHMS, 0);
      if (!ctx.rhsOnly) {
        this.factoredConnected = false;
        this.factoredS = this.s;
        this.factoredMotoring = false;
      }
      return;
    }
    const s = ctx.freezeNonlinear ? this.factoredS : this.s;
    const motoring = ctx.freezeNonlinear
      ? this.factoredMotoring
      : this.desiredMotoring(ctx);
    this.stampedMotoring = motoring;
    vBranch(ctx, this.iop, this.ignd, this.brp, 0, 0);
    vBranch(ctx, this.iom, this.ignd, this.brm, 0, 0);
    if (ctx.rhsOnly) return;
    const { A, n } = ctx;
    const add = (row: number, col: number, value: number) => {
      if (row < 0 || col < 0) return;
      A[row * n + col] = (A[row * n + col] as number) + value;
    };
    const out = this.active(s);
    // V(out) − V(GND) − r·(V(V+) − V(GND)) = 0.
    add(out.branch, this.ivp, -out.r);
    add(out.branch, this.ignd, out.r);
    if (motoring) {
      // The supply side draws r·I_out from V+ into GND. I_out = −i_branch.
      add(this.ivp, out.branch, -out.r);
      add(this.ignd, out.branch, out.r);
    }
    this.factoredS = this.s;
    this.factoredConnected = true;
    this.factoredMotoring = motoring;
  }
  commit(): void {}
  /** Amperes drawn from `V+` at the last solution. */
  supplyCurrent(x: (node: number) => number): number {
    if (!this.connected || !this.stampedMotoring) return 0;
    const out = this.active(this.s);
    return out.r * -x(out.branch);
  }
  latch(voltage: (node: string) => number): void {
    if (!this.senseName) return;
    const ground = voltage(this.gndName);
    const rail = voltage(this.vpName) - ground;
    if (!(rail > 1e-9)) return;
    this.senseRatio = (voltage(this.senseName) - ground) / rail;
  }
  power(ctx: StampCtx): PowerSplit {
    const ground = volt(ctx, this.ignd);
    const draw = this.supplyCurrent((i) => ctx.x[i] as number);
    const ip = ctx.x[this.brp] as number;
    const im = ctx.x[this.brm] as number;
    const absorbed =
      draw * (volt(ctx, this.ivp) - ground) +
      ip * (volt(ctx, this.iop) - ground) +
      im * (volt(ctx, this.iom) - ground);
    return {
      absorbed,
      delivered: 0,
      dissipated: absorbed,
      storedDot: 0,
      mechanical: 0,
    };
  }
  leaving(ctx: StampCtx): ReadonlyArray<readonly [number, number]> {
    const draw = this.supplyCurrent((i) => ctx.x[i] as number);
    const ip = ctx.x[this.brp] as number;
    const im = ctx.x[this.brm] as number;
    return [
      [this.ivp, draw],
      [this.iop, ip],
      [this.iom, im],
      [this.ignd, -draw - ip - im],
    ];
  }
}

/** Floor of each track segment, as a share of `R`, so an end stop is not 0 Ω. */
export const MIN_SEGMENT = 1e-6;

/**
 * `potentiometer@1`: a track `R` from `A` to `B`, the wiper `W` at
 * `fraction` of the way from `B` (0) to `A` (1). The fraction is held
 * for the master step.
 */
export class Potentiometer implements HeldElement {
  readonly form = "potentiometer@1";
  readonly nonlinear = false;
  /** Wiper position in [0, 1], held for the master step. */
  fraction = 0;
  private factoredFraction = Number.NaN;
  private ia = -1;
  private iw = -1;
  private ib = -1;
  constructor(
    readonly id: string,
    readonly aName: string,
    readonly wName: string,
    readonly bName: string,
    readonly R: number
  ) {
    if (!(R > 0)) throw new Error(`${id}: resistance must be positive`);
  }
  nodes(): readonly string[] {
    return [this.aName, this.wName, this.bName];
  }
  branches(): readonly string[] {
    return [];
  }
  bind(nodeOf: (name: string) => number): void {
    this.ia = nodeOf(this.aName);
    this.iw = nodeOf(this.wName);
    this.ib = nodeOf(this.bName);
  }
  signature(): string {
    return "";
  }
  private segments(): { aw: number; wb: number } {
    const f = this.fraction < 0 ? 0 : this.fraction > 1 ? 1 : this.fraction;
    return {
      aw: this.R * Math.max(1 - f, MIN_SEGMENT),
      wb: this.R * Math.max(f, MIN_SEGMENT),
    };
  }
  factorStable(): boolean {
    return this.fraction === this.factoredFraction;
  }
  accepted(): boolean {
    return true;
  }
  stamp(ctx: StampCtx): void {
    if (ctx.rhsOnly) return;
    const { aw, wb } = this.segments();
    gStamp(ctx, this.ia, this.iw, 1 / aw);
    gStamp(ctx, this.iw, this.ib, 1 / wb);
    this.factoredFraction = this.fraction;
  }
  commit(): void {}
  power(ctx: StampCtx): PowerSplit {
    const { aw, wb } = this.segments();
    const va = volt(ctx, this.ia);
    const vw = volt(ctx, this.iw);
    const vb = volt(ctx, this.ib);
    const heat = (va - vw) ** 2 / aw + (vw - vb) ** 2 / wb;
    return {
      absorbed: heat,
      delivered: 0,
      dissipated: heat,
      storedDot: 0,
      mechanical: 0,
    };
  }
  leaving(ctx: StampCtx): ReadonlyArray<readonly [number, number]> {
    const { aw, wb } = this.segments();
    const iaw = (volt(ctx, this.ia) - volt(ctx, this.iw)) / aw;
    const iwb = (volt(ctx, this.iw) - volt(ctx, this.ib)) / wb;
    return [
      [this.ia, iaw],
      [this.iw, iwb - iaw],
      [this.ib, -iwb],
    ];
  }
}
