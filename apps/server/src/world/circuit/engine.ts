// Ported from layered-sim E1 src/mna/engine.ts @ 031dc5e, E2 diode bypass @ 8731557, E3 stepTo @ fc7e8d3.
import type { StampCtx } from "./context";
import type { Element } from "./element";
import {
  addSplit,
  BridgeMotor,
  Capacitor,
  CurrentLoad,
  Diode,
  Inductor,
  Switch,
  TheveninLimit,
} from "./elements";
import { LawTable } from "./law-table";
import { luFactor, luSolve } from "./lu";

export type Method = "be" | "trap";

export type SolveOpts = {
  method: Method;
  /** Fixed step, seconds. `stepTo` may use a shorter gap. */
  h: number;
  /** Newton absolute tolerance on each unknown, SI. */
  atol?: number;
  /** Newton relative tolerance. */
  rtol?: number;
  maxIter?: number;
  /** Skip the DC operating point and start from zero state. */
  uic?: boolean;
  /**
   * Reuse a diode's factored companion while its conductance stays within
   * this relative tolerance. Default 0.5 (E2). Newton still solves the
   * Shockley current; the factor is rebuilt when the region moves.
   */
  bypassEps?: number;
};

export type PowerReport = {
  absorbed: number;
  delivered: number;
  dissipated: number;
  storedDot: number;
  mechanical: number;
  /** delivered − dissipated − d(stored)/dt − mechanical. */
  residual: number;
  /** max |sum of currents leaving a node|, amperes. */
  kcl: number;
};

export type Sample = {
  t: number;
  v: Record<string, number>;
  i: Record<string, number>;
  power: PowerReport;
};

const ATOL = 1e-8;
const RTOL = 1e-6;
const MAX_ITER = 60;
/** E2: relative conductance tolerance that keeps the frozen Jacobian. */
const BYPASS_EPS = 0.5;

export class Engine {
  readonly nodeNames: readonly string[];
  readonly branchNames: readonly string[];
  readonly n: number;
  readonly method: Method;
  readonly h: number;
  t = 0;
  private readonly A: Float64Array;
  private readonly z: Float64Array;
  private readonly x: Float64Array;
  private readonly xOld: Float64Array;
  private readonly perm: Int32Array;
  private readonly ctx: StampCtx;
  private haveLU = false;
  /** Switch states the factorization was built with, one byte per switch. */
  private sigLU: Uint8Array = new Uint8Array(0);
  private factoredH = 0;
  private factoredDc = false;
  private readonly switches: Switch[];
  private readonly diodes: Diode[];
  private readonly bridges: BridgeMotor[];
  private readonly thevenins: TheveninLimit[];
  /** Board-node loads with a compliance knee. Ideal current sources are absent. */
  private readonly knees: CurrentLoad[];
  private readonly laws: LawTable[];
  private readonly nonlinear: boolean;
  private readonly xSave: Float64Array;
  private readonly diodeLimit: Float64Array;
  private opDone = false;
  private lastPower: PowerReport | null = null;
  private stepIndex = 0;

  constructor(
    readonly elements: readonly Element[],
    opts: SolveOpts
  ) {
    this.method = opts.method;
    this.h = opts.h;
    if (!(opts.h > 0)) throw new Error("step must be positive");
    const names = new Set<string>();
    const branches: string[] = [];
    for (const el of elements) {
      for (const name of el.nodes()) if (name !== "0") names.add(name);
      for (const b of el.branches()) branches.push(b);
    }
    this.nodeNames = [...names].sort();
    this.branchNames = branches;
    const nodeOf = new Map<string, number>();
    nodeOf.set("0", -1);
    for (let i = 0; i < this.nodeNames.length; i++) {
      nodeOf.set(this.nodeNames[i]!, i);
    }
    const branchOf = new Map<string, number>();
    for (let i = 0; i < branches.length; i++) {
      const name = branches[i]!;
      if (branchOf.has(name)) throw new Error(`duplicate branch ${name}`);
      branchOf.set(name, this.nodeNames.length + i);
    }
    const n = this.nodeNames.length + branches.length;
    this.n = n;
    if (n === 0) throw new Error("empty circuit");
    for (const el of elements) {
      el.bind(
        (name) => {
          const i = nodeOf.get(name);
          if (i === undefined) throw new Error(`unknown node ${name}`);
          return i;
        },
        (name) => {
          const i = branchOf.get(name);
          if (i === undefined) throw new Error(`unknown branch ${name}`);
          return i;
        }
      );
    }
    this.A = new Float64Array(n * n);
    this.z = new Float64Array(n);
    this.x = new Float64Array(n);
    this.xOld = new Float64Array(n);
    this.perm = new Int32Array(n);
    this.ctx = {
      dc: true,
      method: opts.method,
      h: opts.h,
      t: 0,
      rhsOnly: false,
      freezeNonlinear: false,
      n,
      A: this.A,
      z: this.z,
      x: this.x,
    };
    this.switches = elements.filter((el): el is Switch => el instanceof Switch);
    this.sigLU = new Uint8Array(this.switches.length);
    this.diodes = elements.filter((el): el is Diode => el instanceof Diode);
    this.bridges = elements.filter(
      (el): el is BridgeMotor => el instanceof BridgeMotor
    );
    this.thevenins = elements.filter(
      (el): el is TheveninLimit => el instanceof TheveninLimit
    );
    this.knees = elements.filter(
      (el): el is CurrentLoad => el instanceof CurrentLoad && el.knee > 0
    );
    this.laws = elements.filter((el): el is LawTable => el instanceof LawTable);
    this.nonlinear = elements.some((el) => el.nonlinear);
    this.xSave = new Float64Array(n);
    this.diodeLimit = new Float64Array(this.diodes.length);
    this.atol = opts.atol ?? ATOL;
    this.rtol = opts.rtol ?? RTOL;
    this.maxIter = opts.maxIter ?? MAX_ITER;
    this.uic = opts.uic ?? false;
    this.bypassEps = opts.bypassEps ?? BYPASS_EPS;
  }

  private readonly atol: number;
  private readonly rtol: number;
  private readonly maxIter: number;
  private readonly uic: boolean;
  /** Relative diode-companion tolerance. */
  readonly bypassEps: number;
  /** LU factorizations since construction. */
  factorCount = 0;
  /** Transient steps accepted on a frozen factorization. */
  frozenSteps = 0;
  /** Transient steps that rebuilt the factorization. */
  refactorSteps = 0;

  /** True when every switch is in the state the factorization saw. */
  private sameStructure(t: number): boolean {
    const sw = this.switches;
    const sig = this.sigLU;
    for (let i = 0; i < sw.length; i++) {
      if ((sw[i]!.closed(t) ? 1 : 0) !== sig[i]) return false;
    }
    return true;
  }

  private recordStructure(t: number): void {
    const sw = this.switches;
    const sig = this.sigLU;
    for (let i = 0; i < sw.length; i++) sig[i] = sw[i]!.closed(t) ? 1 : 0;
  }

  /**
   * The factored matrix is still the right Jacobian: same step, same switch
   * key, and every diode conductance within `bypassEps` of the companion
   * that was factored.
   */
  private canFreeze(): boolean {
    if (!this.haveLU || this.factoredDc || this.factoredH !== this.ctx.h) {
      return false;
    }
    if (!this.sameStructure(this.ctx.t)) return false;
    if (!this.bridgesStable()) return false;
    if (!this.kneesStable()) return false;
    const diodes = this.diodes;
    for (let i = 0; i < diodes.length; i++) {
      if (!diodes[i]!.companionClose(this.ctx, this.bypassEps)) return false;
    }
    return true;
  }

  /** Newton with the factored Jacobian. Restores `x` if it does not converge. */
  private tryFrozen(): boolean {
    this.xSave.set(this.x);
    const diodes = this.diodes;
    for (let i = 0; i < diodes.length; i++) {
      this.diodeLimit[i] = diodes[i]!.limitCheckpoint();
    }
    this.ctx.freezeNonlinear = true;
    const limit = this.maxIter < 8 ? this.maxIter : 8;
    for (let iter = 0; iter < limit; iter++) {
      this.xOld.set(this.x);
      this.z.fill(0);
      this.ctx.rhsOnly = true;
      this.stampAll();
      luSolve(this.A, this.n, this.perm, this.z, this.x);
      if (this.converged() && this.devicesAccepted()) {
        this.ctx.freezeNonlinear = false;
        return true;
      }
    }
    this.x.set(this.xSave);
    for (let i = 0; i < diodes.length; i++) {
      diodes[i]!.limitRestore(this.diodeLimit[i] as number);
    }
    this.ctx.freezeNonlinear = false;
    return false;
  }

  private factor(): void {
    luFactor(this.A, this.n, this.perm);
    this.factorCount += 1;
    this.haveLU = true;
    this.recordStructure(this.ctx.t);
    this.factoredH = this.ctx.h;
    this.factoredDc = this.ctx.dc;
  }

  private solveLinear(): void {
    const reuse =
      this.haveLU &&
      !this.nonlinear &&
      !this.ctx.dc &&
      !this.factoredDc &&
      this.factoredH === this.ctx.h &&
      this.sameStructure(this.ctx.t) &&
      this.bridgesStable();
    this.z.fill(0);
    if (reuse) {
      this.ctx.rhsOnly = true;
      this.stampAll();
    } else {
      this.A.fill(0);
      this.ctx.rhsOnly = false;
      this.stampAll();
      this.factor();
    }
    luSolve(this.A, this.n, this.perm, this.z, this.x);
  }

  private stampAll(): void {
    const els = this.elements;
    for (let i = 0; i < els.length; i++) els[i]!.stamp(this.ctx);
  }

  private commitAll(): void {
    const els = this.elements;
    for (let i = 0; i < els.length; i++) els[i]!.commit(this.ctx);
  }

  /**
   * A knee-region conductance is `amps / knee`. A new set current there
   * needs a new factor. Above the knee the current is only on the right-hand side.
   */
  private kneesStable(): boolean {
    const knees = this.knees;
    for (let i = 0; i < knees.length; i++) {
      const load = knees[i]!;
      if (load.factoredRegion === "knee" && load.amps !== load.factoredAmps) {
        return false;
      }
    }
    return true;
  }

  /** Bridge ratio and open/closed state are inputs. A change rebuilds the factor. */
  private bridgesStable(): boolean {
    const bridges = this.bridges;
    for (let i = 0; i < bridges.length; i++) {
      const motor = bridges[i]!;
      if (
        motor.s !== motor.factoredS ||
        motor.connected !== motor.factoredConnected
      ) {
        return false;
      }
    }
    return true;
  }

  private devicesAccepted(): boolean {
    const ctx = this.ctx;
    for (let i = 0; i < this.diodes.length; i++) {
      if (!this.diodes[i]!.accepted(ctx)) return false;
    }
    for (let i = 0; i < this.thevenins.length; i++) {
      if (!this.thevenins[i]!.accepted(ctx)) return false;
    }
    for (let i = 0; i < this.bridges.length; i++) {
      if (!this.bridges[i]!.accepted(ctx)) return false;
    }
    for (let i = 0; i < this.knees.length; i++) {
      if (!this.knees[i]!.accepted(ctx)) return false;
    }
    for (let i = 0; i < this.laws.length; i++) {
      if (!this.laws[i]!.accepted(ctx)) return false;
    }
    return true;
  }

  private converged(): boolean {
    const { x, xOld, n, atol, rtol } = this;
    for (let i = 0; i < n; i++) {
      const a = x[i] as number;
      const b = xOld[i] as number;
      const d = Math.abs(a - b);
      const scale = Math.max(Math.abs(a), Math.abs(b), 1);
      if (d > atol && d > rtol * scale) return false;
    }
    return true;
  }

  private tryNewton(): boolean {
    let dumped = 0;
    for (let iter = 0; iter < this.maxIter; iter++) {
      this.xOld.set(this.x);
      this.A.fill(0);
      this.z.fill(0);
      this.ctx.rhsOnly = false;
      try {
        this.stampAll();
        this.factor();
        luSolve(this.A, this.n, this.perm, this.z, this.x);
      } catch {
        // A current limit with no conducting motor is two equations for
        // one branch current. The rail belongs on the 0 V floor.
        if (!this.fallSuppliesToFloor()) return false;
        dumped += 1;
        if (dumped > 4) return false;
        continue;
      }
      if (this.converged() && this.devicesAccepted()) return true;
    }
    return false;
  }

  private fallSuppliesToFloor(): boolean {
    let held = false;
    for (let i = 0; i < this.thevenins.length; i++) {
      if (this.thevenins[i]!.fallToFloor()) held = true;
    }
    for (let i = 0; i < this.laws.length; i++) {
      if (this.laws[i]!.fallToFloor()) held = true;
    }
    return held;
  }

  private newton(): void {
    this.ctx.freezeNonlinear = false;
    if (this.tryNewton()) return;
    const diodes = this.diodes;
    if (diodes.length === 0) {
      throw new Error(`Newton did not converge at t=${this.ctx.t}`);
    }
    const saved = diodes.map((d) => d.gmin);
    const up = [1e-8, 1e-6, 1e-4, 1e-3];
    let reached = saved[0] ?? 1e-12;
    let ok = false;
    for (const g of up) {
      for (const d of diodes) d.gmin = g;
      reached = g;
      if (this.tryNewton()) {
        ok = true;
        break;
      }
    }
    if (!ok) {
      for (let i = 0; i < diodes.length; i++) diodes[i]!.gmin = saved[i]!;
      throw new Error(`Newton did not converge at t=${this.ctx.t}`);
    }
    const down = [1e-4, 1e-6, 1e-8, 1e-10, 1e-12];
    for (const g of down) {
      if (g >= reached) continue;
      for (let i = 0; i < diodes.length; i++) {
        diodes[i]!.gmin = Math.max(g, saved[i]!);
      }
      if (!this.tryNewton()) break;
    }
    for (let i = 0; i < diodes.length; i++) diodes[i]!.gmin = saved[i]!;
    if (!this.tryNewton()) {
      throw new Error(`Newton failed returning from gmin at t=${this.ctx.t}`);
    }
  }

  private acceptTransient(): void {
    this.ctx.freezeNonlinear = false;
    if (!this.nonlinear) this.solveLinear();
    else if (this.canFreeze() && this.tryFrozen()) this.frozenSteps += 1;
    else {
      this.newton();
      this.refactorSteps += 1;
    }
    this.lastPower = this.power();
    this.commitAll();
  }

  /** DC operating point at t = 0. Capacitors open, inductors shorted. */
  operatingPoint(): void {
    this.t = 0;
    this.ctx.dc = true;
    this.ctx.t = 0;
    this.ctx.h = this.h;
    this.haveLU = false;
    if (this.uic) {
      this.lastPower = {
        absorbed: 0,
        delivered: 0,
        dissipated: 0,
        storedDot: 0,
        mechanical: 0,
        residual: 0,
        kcl: 0,
      };
      this.opDone = true;
      this.stepIndex = 0;
      return;
    }
    if (this.nonlinear) this.newton();
    else this.solveLinear();
    this.lastPower = this.power();
    this.commitAll();
    this.opDone = true;
    this.stepIndex = 0;
  }

  /**
   * One accepted transient step of width `h`. A linear circuit is factored
   * on the first step and reused while switches hold their state.
   */
  stepFast(): void {
    if (!this.opDone) this.operatingPoint();
    this.stepIndex += 1;
    this.t = this.stepIndex * this.h;
    this.ctx.dc = false;
    this.ctx.t = this.t;
    this.ctx.h = this.h;
    this.acceptTransient();
  }

  /**
   * Advance to absolute time `tAbs` in one step. The gap may be shorter
   * than `h`, so an edge can land on a cycle. A linear circuit refactors
   * when the gap changes and reuses the factor while the gap holds.
   */
  stepTo(tAbs: number): void {
    if (!this.opDone) this.operatingPoint();
    let dt = tAbs - this.t;
    if (dt <= 1e-15) return;
    // A grid gap computed by subtraction is off by a few ulps; treat it as
    // exactly `h` so the factor is reused.
    if (Math.abs(dt - this.h) <= 1e-9 * this.h) dt = this.h;
    this.t = tAbs;
    this.ctx.dc = false;
    this.ctx.t = tAbs;
    this.ctx.h = dt;
    this.acceptTransient();
  }

  /**
   * Sub-step to `tAbs` on the fixed grid of `h`, then one partial step
   * that lands on `tAbs`.
   */
  advanceTo(tAbs: number): void {
    if (!(tAbs >= this.t)) throw new Error("advanceTo goes forward");
    const h = this.h;
    let k = Math.floor((this.t + 1e-15) / h) + 1;
    let target = k * h;
    while (target < tAbs - 1e-15) {
      this.stepTo(target);
      k += 1;
      target = k * h;
    }
    this.stepTo(tAbs);
  }

  /**
   * Re-solve at the current time after a switch. No time advance.
   * Resistive nets only: a capacitor commit would consume a spurious step.
   */
  relinearize(): void {
    for (const el of this.elements) {
      if (el instanceof Capacitor || el instanceof Inductor) {
        throw new Error("relinearize is for resistive nets");
      }
    }
    if (!this.opDone) this.operatingPoint();
    this.ctx.t = this.t;
    this.ctx.dc = false;
    this.haveLU = false;
    this.acceptTransient();
  }

  /** Drop the cached factor after a conductance change that is not a switch. */
  dropFactor(): void {
    this.haveLU = false;
  }

  voltage(name: string): number {
    if (name === "0") return 0;
    const i = this.nodeNames.indexOf(name);
    if (i < 0) throw new Error(`no node ${name}`);
    return this.x[i] as number;
  }

  branchCurrent(name: string): number {
    const i = this.branchNames.indexOf(name);
    if (i < 0) throw new Error(`no branch ${name}`);
    return this.x[this.nodeNames.length + i] as number;
  }

  power(): PowerReport {
    const tot = {
      absorbed: 0,
      delivered: 0,
      dissipated: 0,
      storedDot: 0,
      mechanical: 0,
    };
    const els = this.elements;
    const kcl = new Float64Array(this.nodeNames.length);
    for (let i = 0; i < els.length; i++) {
      addSplit(tot, els[i]!.power(this.ctx));
      const terms = els[i]!.leaving(this.ctx);
      for (let k = 0; k < terms.length; k++) {
        const term = terms[k]!;
        const node = term[0];
        if (node >= 0) kcl[node] = (kcl[node] as number) + term[1];
      }
    }
    let kclMax = 0;
    for (let i = 0; i < kcl.length; i++) {
      const a = Math.abs(kcl[i] as number);
      if (a > kclMax) kclMax = a;
    }
    const residual =
      tot.delivered - tot.dissipated - tot.storedDot - tot.mechanical;
    return { ...tot, residual, kcl: kclMax };
  }

  /** Operating point plus `steps` transient steps. Includes t = 0. */
  run(steps: number, probes: readonly string[]): Sample[] {
    this.operatingPoint();
    const out: Sample[] = [this.sample(probes)];
    for (let s = 0; s < steps; s++) {
      this.stepFast();
      out.push(this.sample(probes));
    }
    return out;
  }

  sample(probes: readonly string[]): Sample {
    const v: Record<string, number> = {};
    for (let i = 0; i < probes.length; i++) {
      const name = probes[i]!;
      v[name] = this.voltage(name);
    }
    const i: Record<string, number> = {};
    for (let b = 0; b < this.branchNames.length; b++) {
      const name = this.branchNames[b]!;
      i[name] = this.x[this.nodeNames.length + b] as number;
    }
    const power = this.lastPower ?? this.power();
    return { t: this.t, v, i, power };
  }

  /**
   * Median microseconds per transient step. The operating point sits in
   * the warmup. Wall-clock only; not part of any electrical result.
   */
  bench(warmup: number, samples: number): number {
    this.operatingPoint();
    for (let i = 0; i < warmup; i++) this.stepFast();
    const times = new Float64Array(samples);
    for (let i = 0; i < samples; i++) {
      const t0 = process.hrtime.bigint();
      this.stepFast();
      const t1 = process.hrtime.bigint();
      times[i] = Number(t1 - t0) / 1000;
    }
    const sorted = Array.from(times).sort((a, b) => a - b);
    return sorted[sorted.length >> 1] ?? 0;
  }
}
