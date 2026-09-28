/**
 * Energy at a circuit/body seam (G2). The ledger only reads a step.
 * It does not change an engine input.
 *
 * A motor seam prices `k·ω·I` on the winding, with the ω and the current
 * the rail used, and delivers `ctrl` to the joint. `declared` is
 * `(k·I − ctrl)·ω·dt`: the gearbox efficiency and the torque clamp, at
 * that same ω. `received` uses the average of the joint speed before
 * the body step and after it. The torque is constant over the step, and
 * the speed moves from one value to the other, so the trapezoid is the
 * work the body took. The residual is then `ctrl·(ω_rail − ω̄)·dt`, the
 * coupling lag of one body step. `dt` is that step (`opt.timestep`),
 * and the growth window is 250 ms of those steps.
 */

import type { Diagnostic, SeamEnergy } from "@sfab-bench/contract";

/** Window the growth flag is judged on, in seconds. */
export const SEAM_WINDOW_S = 0.25;

/** Absolute floor for a flagged window, in joules. */
export const SEAM_FLOOR_J = 0.001;

/**
 * Flag when the window's |residual| exceeds this share of |sent|.
 * A smooth 1 ms lag over 250 ms is about `dt / window` (0.4 %) on a
 * ramp, so 5 % is a lag of many steps, not one.
 */
export const SEAM_SHARE = 0.05;

export const SEAM_WARNING_CODE = "seam-residual-growing";

type Bucket = {
  sent: number;
  received: number;
  declared: number;
  residual: number;
};

type Slot = {
  path: string;
  total: Bucket;
  window: Bucket;
  /** |residual| of the first full window. Null until that window closes. */
  firstAbs: number | null;
  flagged: boolean;
};

export type MotorSeamSample = {
  path: string;
  /** Seconds. The body's timestep. */
  dt: number;
  /** V·s/rad. */
  k: number;
  /** rad/s the rail used. Zero when the winding is open. */
  omega: number;
  /** Amperes the rail returned. */
  current: number;
  /** N·m on the actuator after efficiency and the clamp. */
  ctrl: number;
  /** rad/s of the joint before the body step. */
  omegaBefore: number;
  /** rad/s of the joint after the body step. */
  omegaAfter: number;
};

function emptyBucket(): Bucket {
  return { sent: 0, received: 0, declared: 0, residual: 0 };
}

function add(bucket: Bucket, step: Bucket): void {
  bucket.sent += step.sent;
  bucket.received += step.received;
  bucket.declared += step.declared;
  bucket.residual += step.residual;
}

function milliJoules(joules: number): string {
  const mj = Math.abs(joules) * 1000;
  if (mj >= 10) return `${mj.toFixed(0)} mJ`;
  return `${mj.toFixed(1)} mJ`;
}

/** One line for `bench run`. Fixed digits so the same run prints the same text. */
export function seamLine(row: SeamEnergy): string {
  const flag = row.flagged ? " flagged" : "";
  return (
    `seam ${row.path} ${row.kind}: ` +
    `sent ${row.sent.toFixed(6)} J, ` +
    `received ${row.received.toFixed(6)} J, ` +
    `declared ${row.declared.toFixed(6)} J, ` +
    `residual ${row.residual.toExponential(1)} J${flag}`
  );
}

export class SeamLedger {
  private readonly slots = new Map<string, Slot>();
  private steps = 0;
  /** Body timestep of the first sample, in seconds. */
  private dt = 0;
  /** Body steps in one window. Derived from `dt`. */
  private windowSteps = 0;

  note(sample: MotorSeamSample): void {
    if (this.windowSteps === 0 && sample.dt > 0) {
      this.dt = sample.dt;
      this.windowSteps = Math.max(1, Math.round(SEAM_WINDOW_S / sample.dt));
    }
    const em = sample.k * sample.current;
    const sent = em * sample.omega * sample.dt;
    const omegaBar = 0.5 * (sample.omegaBefore + sample.omegaAfter);
    const received = sample.ctrl * omegaBar * sample.dt;
    const declared = (em - sample.ctrl) * sample.omega * sample.dt;
    const step: Bucket = {
      sent,
      received,
      declared,
      residual: sent - received - declared,
    };
    let slot = this.slots.get(sample.path);
    if (!slot) {
      slot = {
        path: sample.path,
        total: emptyBucket(),
        window: emptyBucket(),
        firstAbs: null,
        flagged: false,
      };
      this.slots.set(sample.path, slot);
    }
    add(slot.total, step);
    add(slot.window, step);
  }

  /**
   * Close one body step. A full window may raise one warning per seam.
   * A seam warns once.
   */
  endStep(): { closed: boolean; warnings: Diagnostic[] } {
    if (this.slots.size === 0 || this.windowSteps === 0) {
      return { closed: false, warnings: [] };
    }
    this.steps += 1;
    if (this.steps % this.windowSteps !== 0) {
      return { closed: false, warnings: [] };
    }
    const warnings: Diagnostic[] = [];
    const ms = Math.round(this.windowSteps * this.dt * 1000);
    for (const slot of this.slots.values()) {
      const abs = Math.abs(slot.window.residual);
      if (slot.firstAbs === null) {
        slot.firstAbs = abs;
      } else if (!slot.flagged) {
        const sentAbs = Math.abs(slot.window.sent);
        let share = 0;
        if (sentAbs > 0) share = abs / sentAbs;
        else if (abs > 0) share = 1;
        if (abs > SEAM_FLOOR_J && share > SEAM_SHARE && abs > slot.firstAbs) {
          slot.flagged = true;
          const pct = Math.round(share * 100);
          warnings.push({
            severity: "warning",
            code: SEAM_WARNING_CODE,
            path: slot.path,
            port: "shaft",
            quantity: "Energy",
            left: String(slot.window.residual),
            right: String(slot.firstAbs),
            message:
              `${slot.path}: the motor seam residual grew to ${milliJoules(abs)} ` +
              `in the last ${ms} ms (${pct} % of ${milliJoules(sentAbs)} sent)`,
          });
        }
      }
      slot.window = emptyBucket();
    }
    return { closed: true, warnings };
  }

  rows(): SeamEnergy[] {
    const rows: SeamEnergy[] = [];
    for (const slot of this.slots.values()) {
      rows.push({
        path: slot.path,
        kind: "motor",
        sent: slot.total.sent,
        received: slot.total.received,
        declared: slot.total.declared,
        residual: slot.total.residual,
        flagged: slot.flagged,
      });
    }
    rows.sort((a, b) => {
      if (a.path < b.path) return -1;
      if (a.path > b.path) return 1;
      return 0;
    });
    return rows;
  }

  reset(): void {
    this.slots.clear();
    this.steps = 0;
    this.dt = 0;
    this.windowSteps = 0;
  }
}
