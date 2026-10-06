// Ported from layered-sim E1 src/mna/elements.ts @ 031dc5e; diode bypass, thevenin-limit, and bridge motor from E2 @ 8731557.
import {
  gStamp,
  type PowerSplit,
  type StampCtx,
  vBranch,
  volt,
} from "./context";
import type { Element } from "./element";
import { type Waveform, waveAt } from "./wave";

const K_B = 1.380649e-23;
const Q_E = 1.602176634e-19;

/** Thermal voltage at an absolute temperature, volts. */
export function thermalVoltage(tempC: number): number {
  return (K_B * (tempC + 273.15)) / Q_E;
}

/** SPICE junction limiting (pnjlim). `vt` is N·kT/q. */
export function pnjlim(
  vnew: number,
  vold: number,
  vt: number,
  vcrit: number
): number {
  if (vnew > vcrit && Math.abs(vnew - vold) > vt + vt) {
    if (vold > 0) {
      const arg = 1 + (vnew - vold) / vt;
      if (arg > 0) return vold + vt * Math.log(arg);
      return vcrit;
    }
    if (vnew > 0) return vt * Math.log(vnew / vt);
  }
  return vnew;
}

function addSplit(into: PowerSplit, part: PowerSplit): void {
  into.absorbed += part.absorbed;
  into.delivered += part.delivered;
  into.dissipated += part.dissipated;
  into.storedDot += part.storedDot;
  into.mechanical += part.mechanical;
}

export { addSplit };

class Base {
  ia = -1;
  ib = -1;
  constructor(
    readonly id: string,
    readonly form: string,
    readonly aName: string,
    readonly bName: string
  ) {}
  nodes(): readonly string[] {
    return [this.aName, this.bName];
  }
  branches(): readonly string[] {
    return [];
  }
  bind(
    nodeOf: (name: string) => number,
    _branchOf?: (name: string) => number
  ): void {
    this.ia = nodeOf(this.aName);
    this.ib = nodeOf(this.bName);
  }
  signature(_t: number): string {
    return "";
  }
  commit(_ctx: StampCtx): void {}
}

export class Resistor extends Base implements Element {
  readonly nonlinear = false;
  constructor(
    id: string,
    a: string,
    b: string,
    readonly R: number
  ) {
    super(id, "resistor@1", a, b);
    if (!(R > 0)) throw new Error(`${id}: resistance must be positive`);
  }
  stamp(ctx: StampCtx): void {
    gStamp(ctx, this.ia, this.ib, 1 / this.R);
  }
  power(ctx: StampCtx): PowerSplit {
    const v = volt(ctx, this.ia) - volt(ctx, this.ib);
    const i = v / this.R;
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
    const i = (volt(ctx, this.ia) - volt(ctx, this.ib)) / this.R;
    return [
      [this.ia, i],
      [this.ib, -i],
    ];
  }
}

export class Capacitor extends Base implements Element {
  readonly nonlinear = false;
  private vPrev = 0;
  private iPrev = 0;
  constructor(
    id: string,
    a: string,
    b: string,
    readonly C: number
  ) {
    super(id, "capacitor@1", a, b);
    if (!(C > 0)) throw new Error(`${id}: capacitance must be positive`);
  }
  private geq(ctx: StampCtx): number {
    return ctx.method === "trap" ? (2 * this.C) / ctx.h : this.C / ctx.h;
  }
  stamp(ctx: StampCtx): void {
    if (ctx.dc) return;
    const g = this.geq(ctx);
    gStamp(ctx, this.ia, this.ib, g);
    const iEq =
      ctx.method === "trap" ? g * this.vPrev + this.iPrev : g * this.vPrev;
    zInto(ctx, this.ia, this.ib, iEq);
  }
  commit(ctx: StampCtx): void {
    const v = volt(ctx, this.ia) - volt(ctx, this.ib);
    if (!ctx.dc) {
      const g = this.geq(ctx);
      const iEq =
        ctx.method === "trap" ? g * this.vPrev + this.iPrev : g * this.vPrev;
      this.iPrev = g * v - iEq;
    } else {
      this.iPrev = 0;
    }
    this.vPrev = v;
  }
  private current(ctx: StampCtx): number {
    if (ctx.dc) return 0;
    const v = volt(ctx, this.ia) - volt(ctx, this.ib);
    const g = this.geq(ctx);
    const iEq =
      ctx.method === "trap" ? g * this.vPrev + this.iPrev : g * this.vPrev;
    return g * v - iEq;
  }
  power(ctx: StampCtx): PowerSplit {
    const v = volt(ctx, this.ia) - volt(ctx, this.ib);
    const p = v * this.current(ctx);
    return {
      absorbed: p,
      delivered: 0,
      dissipated: 0,
      storedDot: p,
      mechanical: 0,
    };
  }
  leaving(ctx: StampCtx): ReadonlyArray<readonly [number, number]> {
    const i = this.current(ctx);
    return [
      [this.ia, i],
      [this.ib, -i],
    ];
  }
}

/** History current is injected into node a (and out of b): z[a] += iEq. */
function zInto(ctx: StampCtx, a: number, b: number, iEq: number): void {
  if (a >= 0) ctx.z[a] = (ctx.z[a] as number) + iEq;
  if (b >= 0) ctx.z[b] = (ctx.z[b] as number) - iEq;
}

export class Inductor implements Element {
  readonly form = "inductor@1";
  readonly nonlinear = false;
  ia = -1;
  ib = -1;
  ibr = -1;
  private iPrev = 0;
  private vPrev = 0;
  constructor(
    readonly id: string,
    readonly aName: string,
    readonly bName: string,
    readonly L: number
  ) {
    if (!(L > 0)) throw new Error(`${id}: inductance must be positive`);
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
    if (ctx.dc) {
      vBranch(ctx, this.ia, this.ib, this.ibr, 0, 0);
      return;
    }
    const g = ctx.method === "trap" ? (2 * this.L) / ctx.h : this.L / ctx.h;
    const e =
      ctx.method === "trap" ? -g * this.iPrev - this.vPrev : -g * this.iPrev;
    vBranch(ctx, this.ia, this.ib, this.ibr, g, e);
  }
  commit(ctx: StampCtx): void {
    const i = ctx.x[this.ibr] as number;
    const v = volt(ctx, this.ia) - volt(ctx, this.ib);
    this.iPrev = i;
    this.vPrev = ctx.dc ? 0 : v;
  }
  power(ctx: StampCtx): PowerSplit {
    const v = volt(ctx, this.ia) - volt(ctx, this.ib);
    const i = ctx.x[this.ibr] as number;
    const p = v * i;
    return {
      absorbed: p,
      delivered: 0,
      dissipated: 0,
      storedDot: p,
      mechanical: 0,
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

export class VSource implements Element {
  readonly form = "ideal-voltage@1";
  readonly nonlinear = false;
  ip = -1;
  im = -1;
  ibr = -1;
  constructor(
    readonly id: string,
    readonly pName: string,
    readonly mName: string,
    readonly wave: Waveform
  ) {}
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
  stamp(ctx: StampCtx): void {
    vBranch(
      ctx,
      this.ip,
      this.im,
      this.ibr,
      0,
      waveAt(this.wave, ctx.t) * ctx.sourceScale
    );
  }
  commit(): void {}
  power(ctx: StampCtx): PowerSplit {
    const e = waveAt(this.wave, ctx.t);
    const i = ctx.x[this.ibr] as number;
    const absorbed = e * i;
    return {
      absorbed,
      delivered: -absorbed,
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

export class ISource implements Element {
  readonly form = "ideal-current@1";
  readonly nonlinear = false;
  ip = -1;
  im = -1;
  constructor(
    readonly id: string,
    readonly pName: string,
    readonly mName: string,
    readonly wave: Waveform
  ) {}
  nodes(): readonly string[] {
    return [this.pName, this.mName];
  }
  branches(): readonly string[] {
    return [];
  }
  bind(nodeOf: (name: string) => number): void {
    this.ip = nodeOf(this.pName);
    this.im = nodeOf(this.mName);
  }
  signature(): string {
    return "";
  }
  /** Current flows from p through the source to m (SPICE sign). */
  stamp(ctx: StampCtx): void {
    const i = waveAt(this.wave, ctx.t) * ctx.sourceScale;
    if (this.ip >= 0) ctx.z[this.ip] = (ctx.z[this.ip] as number) - i;
    if (this.im >= 0) ctx.z[this.im] = (ctx.z[this.im] as number) + i;
  }
  commit(): void {}
  power(ctx: StampCtx): PowerSplit {
    const i = waveAt(this.wave, ctx.t);
    const v = volt(ctx, this.ip) - volt(ctx, this.im);
    const absorbed = v * i;
    return {
      absorbed,
      delivered: -absorbed,
      dissipated: 0,
      storedDot: 0,
      mechanical: 0,
    };
  }
  leaving(ctx: StampCtx): ReadonlyArray<readonly [number, number]> {
    const i = waveAt(this.wave, ctx.t);
    return [
      [this.ip, i],
      [this.im, -i],
    ];
  }
}

export type DiodeParams = { Is: number; N: number; Rs: number; tempC?: number };

export class Diode implements Element {
  readonly form = "diode@1";
  readonly nonlinear = true;
  ia = -1;
  ik = -1;
  ij = -1;
  private vLimit = 0;
  private readonly vt: number;
  private readonly vcrit: number;
  private readonly nVt: number;
  /** Parallel junction conductance, matching ngspice's gmin. */
  gmin = 1e-12;
  /** Junction conductance (plus gmin) stored in the factored Jacobian. */
  frozenG = 0;
  frozen = false;
  /** Shockley current from the last accepted step, anode toward cathode. */
  amps = 0;
  constructor(
    readonly id: string,
    readonly aName: string,
    readonly kName: string,
    readonly params: DiodeParams
  ) {
    if (!(params.Is > 0) || !(params.N > 0) || params.Rs < 0) {
      throw new Error(`${id}: diode params must have Is > 0, N > 0, Rs >= 0`);
    }
    this.vt = thermalVoltage(params.tempC ?? 25);
    this.nVt = params.N * this.vt;
    this.vcrit = this.nVt * Math.log(this.nVt / (Math.SQRT2 * params.Is));
  }
  nodes(): readonly string[] {
    return this.params.Rs > 0
      ? [this.aName, this.kName, `${this.id}#j`]
      : [this.aName, this.kName];
  }
  branches(): readonly string[] {
    return [];
  }
  bind(nodeOf: (name: string) => number): void {
    this.ia = nodeOf(this.aName);
    this.ik = nodeOf(this.kName);
    this.ij = this.params.Rs > 0 ? nodeOf(`${this.id}#j`) : this.ia;
  }
  signature(): string {
    return "";
  }
  private junctionVoltage(ctx: StampCtx): number {
    return volt(ctx, this.ij) - volt(ctx, this.ik);
  }
  /**
   * Small-signal junction conductance plus gmin at the solved voltage.
   * Compared with `frozenG` to decide whether the factored Jacobian is still usable.
   */
  trueConductance(ctx: StampCtx): number {
    const v = this.junctionVoltage(ctx);
    const arg = v / this.nVt;
    const e = arg > 80 ? Math.exp(80) : arg < -40 ? 0 : Math.exp(arg);
    return (this.params.Is * e) / this.nVt + this.gmin;
  }

  limitCheckpoint(): number {
    return this.vLimit;
  }

  limitRestore(v: number): void {
    this.vLimit = v;
  }

  /** True when the factored companion is within a relative tolerance of the device at `x`. */
  companionClose(ctx: StampCtx, eps: number): boolean {
    if (!this.frozen) return false;
    const g = this.trueConductance(ctx);
    const scale = Math.max(Math.abs(g), Math.abs(this.frozenG), 1e-12);
    return Math.abs(g - this.frozenG) <= eps * scale;
  }

  stamp(ctx: StampCtx): void {
    const guess = this.junctionVoltage(ctx);
    const vuse = pnjlim(guess, this.vLimit, this.nVt, this.vcrit);
    this.vLimit = vuse;
    const { Is } = this.params;
    const arg = vuse / this.nVt;
    const clamped = arg > 80 ? 80 : arg < -40 ? -40 : arg;
    const ex = Math.exp(clamped);
    const id = Is * (ex - 1);
    const gd = (Is * ex) / this.nVt;
    const fresh = gd + this.gmin;
    const gTotal = ctx.freezeNonlinear && this.frozen ? this.frozenG : fresh;
    if (!ctx.rhsOnly) {
      this.frozenG = fresh;
      this.frozen = true;
    }
    if (this.params.Rs > 0) gStamp(ctx, this.ia, this.ij, 1 / this.params.Rs);
    gStamp(ctx, this.ij, this.ik, gTotal);
    // (gd+gmin)·v + ieq = id + gmin·v, with ieq = id - gd·v.
    const ieq = id - (gTotal - this.gmin) * vuse;
    if (this.ij >= 0) ctx.z[this.ij] = (ctx.z[this.ij] as number) - ieq;
    if (this.ik >= 0) ctx.z[this.ik] = (ctx.z[this.ik] as number) + ieq;
  }
  commit(ctx: StampCtx): void {
    this.vLimit = this.junctionVoltage(ctx);
    this.amps = this.shockley(ctx);
  }
  /**
   * False while limiting is still walking the junction up to the solved
   * voltage. 1e-10 V keeps a frozen-Jacobian step inside 1e-9 W.
   */
  accepted(ctx: StampCtx): boolean {
    return Math.abs(this.junctionVoltage(ctx) - this.vLimit) <= 1e-10;
  }
  /** Shockley current from anode to cathode at the solved terminal voltage. */
  shockley(ctx: StampCtx): number {
    const v = this.junctionVoltage(ctx);
    const arg = v / this.nVt;
    const e = arg > 80 ? Math.exp(80) : arg < -40 ? 0 : Math.exp(arg);
    return this.params.Is * (e - 1) + v * this.gmin;
  }
  power(ctx: StampCtx): PowerSplit {
    const i = this.shockley(ctx);
    let vTerm: number;
    if (this.params.Rs > 0) {
      const vj = this.junctionVoltage(ctx);
      vTerm = vj + i * this.params.Rs;
    } else {
      vTerm = volt(ctx, this.ia) - volt(ctx, this.ik);
    }
    const p = vTerm * i;
    return {
      absorbed: p,
      delivered: 0,
      dissipated: p,
      storedDot: 0,
      mechanical: 0,
    };
  }
  leaving(ctx: StampCtx): ReadonlyArray<readonly [number, number]> {
    const iJ = this.shockley(ctx);
    if (!(this.params.Rs > 0)) {
      return [
        [this.ia, iJ],
        [this.ik, -iJ],
      ];
    }
    const iRs = (volt(ctx, this.ia) - volt(ctx, this.ij)) / this.params.Rs;
    return [
      [this.ia, iRs],
      [this.ij, iJ - iRs],
      [this.ik, -iJ],
    ];
  }
}

export class Switch implements Element {
  readonly form = "switch@1";
  readonly nonlinear = false;
  ia = -1;
  ib = -1;
  constructor(
    readonly id: string,
    readonly aName: string,
    readonly bName: string,
    readonly Ron: number,
    readonly Roff: number,
    readonly wave: Waveform
  ) {
    if (!(Ron > 0) || !(Roff > Ron))
      throw new Error(`${id}: need 0 < Ron < Roff`);
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
  closed(t: number): boolean {
    return waveAt(this.wave, t) >= 0.5;
  }
  signature(t: number): string {
    return this.closed(t) ? "1" : "0";
  }
  private R(t: number): number {
    return this.closed(t) ? this.Ron : this.Roff;
  }
  stamp(ctx: StampCtx): void {
    gStamp(ctx, this.ia, this.ib, 1 / this.R(ctx.t));
  }
  commit(): void {}
  power(ctx: StampCtx): PowerSplit {
    const v = volt(ctx, this.ia) - volt(ctx, this.ib);
    const i = v / this.R(ctx.t);
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
    const i = (volt(ctx, this.ia) - volt(ctx, this.ib)) / this.R(ctx.t);
    return [
      [this.ia, i],
      [this.ib, -i],
    ];
  }
}

type LoadRegion = "full" | "knee";

/**
 * Constant draw from `p` to `m`, amperes. Board current and servo quiescent.
 * `amps` is updated in place so a rail step does not allocate a waveform.
 * `knee` of 0 is that ideal source, including below 0 V. A positive knee
 * keeps the set current at or above that voltage and stamps
 * `I = amps · V / knee` below it, so the node is not pulled through 0 V.
 */
export class CurrentLoad implements Element {
  readonly form = "ideal-current@1";
  readonly nonlinear: boolean;
  /** Volts. 0 disables the compliance knee. */
  readonly knee: number;
  ip = -1;
  im = -1;
  /** Amperes leaving `p` toward `m` while `V >= knee`. */
  amps = 0;
  private region: LoadRegion = "full";
  /** Region written into the factored matrix. */
  factoredRegion: LoadRegion | null = null;
  /** `amps` the knee conductance was factored with. */
  factoredAmps = Number.NaN;
  constructor(
    readonly id: string,
    readonly pName: string,
    readonly mName: string,
    knee = 0
  ) {
    if (knee < 0) throw new Error(`${id}: knee must be >= 0`);
    this.knee = knee;
    this.nonlinear = knee > 0;
  }
  nodes(): readonly string[] {
    return [this.pName, this.mName];
  }
  branches(): readonly string[] {
    return [];
  }
  bind(nodeOf: (name: string) => number): void {
    this.ip = nodeOf(this.pName);
    this.im = nodeOf(this.mName);
  }
  signature(): string {
    return "";
  }
  private voltage(ctx: StampCtx): number {
    return volt(ctx, this.ip) - volt(ctx, this.im);
  }
  /** Full current at or above the knee. The two laws meet at the knee. */
  desired(ctx: StampCtx): LoadRegion {
    if (!(this.knee > 0)) return "full";
    return this.voltage(ctx) + 1e-9 >= this.knee ? "full" : "knee";
  }
  private draw(ctx: StampCtx): number {
    if (!(this.knee > 0) || this.region === "full") return this.amps;
    return (this.amps / this.knee) * this.voltage(ctx);
  }
  stamp(ctx: StampCtx): void {
    if (!(this.knee > 0)) {
      const i = this.amps;
      if (this.ip >= 0) ctx.z[this.ip] = (ctx.z[this.ip] as number) - i;
      if (this.im >= 0) ctx.z[this.im] = (ctx.z[this.im] as number) + i;
      return;
    }
    const region =
      ctx.freezeNonlinear && this.factoredRegion !== null
        ? this.factoredRegion
        : this.desired(ctx);
    this.region = region;
    if (!ctx.rhsOnly) {
      this.factoredRegion = region;
      this.factoredAmps = this.amps;
    }
    if (region === "full") {
      const i = this.amps;
      if (this.ip >= 0) ctx.z[this.ip] = (ctx.z[this.ip] as number) - i;
      if (this.im >= 0) ctx.z[this.im] = (ctx.z[this.im] as number) + i;
      return;
    }
    const amps = ctx.freezeNonlinear ? this.factoredAmps : this.amps;
    gStamp(ctx, this.ip, this.im, amps / this.knee);
  }
  commit(): void {}
  accepted(ctx: StampCtx): boolean {
    if (!(this.knee > 0)) return true;
    return this.desired(ctx) === this.region;
  }
  power(ctx: StampCtx): PowerSplit {
    const v = this.voltage(ctx);
    const absorbed = v * this.draw(ctx);
    return {
      absorbed,
      delivered: -absorbed,
      dissipated: 0,
      storedDot: 0,
      mechanical: 0,
    };
  }
  leaving(ctx: StampCtx): ReadonlyArray<readonly [number, number]> {
    const i = this.draw(ctx);
    return [
      [this.ip, i],
      [this.im, -i],
    ];
  }
}

export type SupplyRegion = "cv" | "cc" | "floor";

/**
 * CV/CC supply. Branch current `i` leaves the positive node into the element,
 * so the load current is `-i`.
 * CV: `v(p) − v(m) − Rs·i = V`.
 * CC: `i = −Ilim` while the terminal voltage stays non-negative.
 * Floor: `v = 0` when CV or CC would drive the rail negative. A supply never
 * sinks into a negative rail (E6). The current is then whatever the load draws.
 */
export class TheveninLimit implements Element {
  readonly form = "thevenin-limit@1";
  readonly nonlinear = true;
  ip = -1;
  im = -1;
  ibr = -1;
  private region: SupplyRegion = "cv";
  /** Region written into the factored matrix. */
  factoredRegion: SupplyRegion | null = null;
  /**
   * Set when a current-limit stamp is singular (the load cannot draw
   * exactly Ilim). The next stamp holds the rail at 0 V, which is what
   * `solveRail` returns in that case.
   */
  private holdFloor = false;
  constructor(
    readonly id: string,
    readonly pName: string,
    readonly mName: string,
    readonly V: number,
    readonly Rs: number,
    readonly Ilim: number
  ) {
    if (Rs < 0 || !(Ilim > 0)) throw new Error(`${id}: Rs >= 0 and Ilim > 0`);
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
    if (this.region !== "cc") return false;
    this.holdFloor = true;
    return true;
  }
  desired(ctx: StampCtx): SupplyRegion {
    if (this.holdFloor) {
      this.holdFloor = false;
      return "floor";
    }
    const iLoad = -((ctx.x[this.ibr] as number) ?? 0);
    const vt = volt(ctx, this.ip) - volt(ctx, this.im);
    const tol = 1e-9;
    if (vt < -tol) return "floor";
    if (this.region === "floor") {
      const vCv = this.V - this.Rs * iLoad;
      if (iLoad <= this.Ilim + tol && vCv > tol) return "cv";
      return "floor";
    }
    if (this.region === "cv") {
      return iLoad > this.Ilim + tol ? "cc" : "cv";
    }
    const iUnc =
      this.Rs > 0
        ? (this.V - vt) / this.Rs
        : vt < this.V - tol
          ? Number.POSITIVE_INFINITY
          : 0;
    return iUnc < this.Ilim - tol ? "cv" : "cc";
  }
  stamp(ctx: StampCtx): void {
    const region =
      ctx.freezeNonlinear && this.factoredRegion !== null
        ? this.factoredRegion
        : this.desired(ctx);
    this.region = region;
    if (!ctx.rhsOnly) this.factoredRegion = region;
    if (region === "cv") {
      vBranch(ctx, this.ip, this.im, this.ibr, this.Rs, this.V);
      return;
    }
    if (region === "floor") {
      vBranch(ctx, this.ip, this.im, this.ibr, 0, 0);
      return;
    }
    if (!ctx.rhsOnly) {
      vBranch(ctx, this.ip, this.im, this.ibr, 0, 0);
      currentRow(ctx, this.ibr, -this.Ilim);
    } else {
      ctx.z[this.ibr] = -this.Ilim;
    }
  }
  commit(): void {}
  accepted(ctx: StampCtx): boolean {
    return this.desired(ctx) === this.region;
  }
  power(ctx: StampCtx): PowerSplit {
    const i = ctx.x[this.ibr] as number;
    const vt = volt(ctx, this.ip) - volt(ctx, this.im);
    const iLoad = -i;
    const absorbed = vt * i;
    const delivered = this.V * iLoad;
    const dissipated = (this.V - vt) * iLoad;
    return {
      absorbed,
      delivered,
      dissipated,
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

/** Replaces the branch row with `i = value`. The KCL column is left as stamped. */
function currentRow(ctx: StampCtx, iCol: number, value: number): void {
  const { A, z, n } = ctx;
  const row = iCol * n;
  for (let j = 0; j < n; j++) A[row + j] = 0;
  A[row + iCol] = 1;
  z[iCol] = value;
}

/** `clip` drops braking current. `return` puts `s·I` back on the rail. */
export type Braking = "clip" | "return";

/**
 * Averaged H-bridge and winding fused in one branch: the `position-servo@1`
 * law on the rail.
 * `V_motor = s·V_rail`. The rail draws `s·I` while motoring.
 * With `clip` (the default, ADR 0010) a negative `s·I` does not return.
 * `L = 0` is the algebraic law. ω is an input, held across electrical sub-steps.
 * Quiescent current is a `CurrentLoad` on the rail, not part of this branch.
 */
export class BridgeMotor implements Element {
  readonly form = "position-servo@1";
  readonly nonlinear: boolean;
  rail = -1;
  ibr = -1;
  /** Bridge ratio, held for the master step. */
  s = 0;
  omega = 0;
  /** False opens the winding: no current and no rail draw. */
  connected = true;
  factoredS = Number.NaN;
  factoredMotoring = true;
  factoredConnected = true;
  private stampedMotoring = true;
  private iPrev = 0;
  private vLPrev = 0;
  constructor(
    readonly id: string,
    readonly railName: string,
    readonly R: number,
    readonly L: number,
    readonly K: number,
    readonly braking: Braking = "clip"
  ) {
    if (!(R > 0) || L < 0) throw new Error(`${id}: R > 0 and L >= 0`);
    this.nonlinear = braking === "clip";
  }
  nodes(): readonly string[] {
    return [this.railName];
  }
  branches(): readonly string[] {
    return [this.id];
  }
  bind(
    nodeOf: (name: string) => number,
    branchOf: (name: string) => number
  ): void {
    this.rail = nodeOf(this.railName);
    this.ibr = branchOf(this.id);
  }
  signature(): string {
    return "";
  }
  private desiredMotoring(ctx: StampCtx): boolean {
    if (this.braking === "return") return true;
    const sI = this.s * ((ctx.x[this.ibr] as number) ?? 0);
    if (sI > 1e-12) return true;
    if (sI < -1e-12) return false;
    return this.stampedMotoring;
  }
  stamp(ctx: StampCtx): void {
    const connected = ctx.freezeNonlinear
      ? this.factoredConnected
      : this.connected;
    if (!connected) {
      this.stampedMotoring = false;
      if (!ctx.rhsOnly) {
        this.factoredConnected = false;
        this.factoredS = this.s;
        this.factoredMotoring = false;
        currentRow(ctx, this.ibr, 0);
      } else {
        ctx.z[this.ibr] = 0;
      }
      return;
    }
    const motoring =
      this.braking === "return"
        ? true
        : ctx.freezeNonlinear
          ? this.factoredMotoring
          : this.desiredMotoring(ctx);
    this.stampedMotoring = motoring;
    const s = ctx.freezeNonlinear ? this.factoredS : this.s;
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
    if (!ctx.rhsOnly) {
      const { A, n } = ctx;
      const row = this.ibr;
      if (this.rail >= 0) {
        A[row * n + this.rail] = s;
        A[this.rail * n + row] = motoring ? s : 0;
      }
      A[row * n + row] = -(this.R + g);
      this.factoredS = this.s;
      this.factoredMotoring = motoring;
      this.factoredConnected = true;
    }
    ctx.z[this.ibr] = (ctx.z[this.ibr] as number) + e;
  }
  commit(ctx: StampCtx): void {
    const i = this.connected ? (ctx.x[this.ibr] as number) : 0;
    if (!this.connected || ctx.dc || this.L === 0) {
      this.vLPrev = 0;
      this.iPrev = i;
      return;
    }
    const v = this.s * volt(ctx, this.rail);
    this.vLPrev = v - this.R * i - this.K * this.omega;
    this.iPrev = i;
  }
  accepted(ctx: StampCtx): boolean {
    if (!this.connected || this.braking === "return") return true;
    return this.desiredMotoring(ctx) === this.stampedMotoring;
  }
  power(ctx: StampCtx): PowerSplit {
    const i = ctx.x[this.ibr] as number;
    const vRail = volt(ctx, this.rail);
    const vMot = this.s * vRail;
    const elec = this.connected ? vMot * i : 0;
    const copper = this.connected ? this.R * i * i : 0;
    const mechanical = this.connected ? this.K * this.omega * i : 0;
    return {
      absorbed: elec,
      delivered: 0,
      dissipated: copper,
      storedDot: elec - copper - mechanical,
      mechanical,
    };
  }
  leaving(ctx: StampCtx): ReadonlyArray<readonly [number, number]> {
    if (!this.connected || !this.stampedMotoring) return [[this.rail, 0]];
    const i = ctx.x[this.ibr] as number;
    return [[this.rail, this.s * i]];
  }
}

export function resistor(
  id: string,
  a: string,
  b: string,
  R: number
): Resistor {
  return new Resistor(id, a, b, R);
}
export function capacitor(
  id: string,
  a: string,
  b: string,
  C: number
): Capacitor {
  return new Capacitor(id, a, b, C);
}
export function inductor(
  id: string,
  a: string,
  b: string,
  L: number
): Inductor {
  return new Inductor(id, a, b, L);
}
export function vSource(
  id: string,
  p: string,
  m: string,
  wave: Waveform
): VSource {
  return new VSource(id, p, m, wave);
}
export function iSource(
  id: string,
  p: string,
  m: string,
  wave: Waveform
): ISource {
  return new ISource(id, p, m, wave);
}
export function diode(
  id: string,
  a: string,
  k: string,
  params: DiodeParams
): Diode {
  return new Diode(id, a, k, params);
}
export function sw(
  id: string,
  a: string,
  b: string,
  Ron: number,
  Roff: number,
  wave: Waveform
): Switch {
  return new Switch(id, a, b, Ron, Roff, wave);
}
export function thevenin(
  id: string,
  p: string,
  m: string,
  V: number,
  Rs: number,
  Ilim: number
): TheveninLimit {
  return new TheveninLimit(id, p, m, V, Rs, Ilim);
}
