/**
 * Servo motor law and supply rail (ADR 0009, D-017 revised 2026-09-25).
 * Pure functions. This module does not step physics and does not read files.
 *
 * `solveRail` and `servoElectrical` are the SG90's class-1 law and the
 * reference the circuit is checked against (ADR 0010). The run does not
 * call them. Display, brownout, and the other helpers are what the run
 * still uses.
 *
 * The rail law is solved from this step's error and joint velocity. A
 * servo's motor current is affine in the rail for a fixed error and
 * speed, and the board is a constant draw, so the reference has a closed
 * form.
 */

import type { WorldPartMotion } from "@sfab-bench/contract";

export type { WorldPartMotion };

/** Display: stall when the drive is saturated and slower than this. */
export const DISPLAY_STALL_DEG_PER_SEC = 5;

/** Display: moving when a linear drive is off the target by more than this. */
export const DISPLAY_MOVE_DEG = 0.5;

/** Display: the stall condition must hold this long before the state is stall. */
export const DISPLAY_STALL_HOLD_MS = 20;

/**
 * ATmega328P BODLEVEL 2.7 V typical, with 50 mV hysteresis.
 * Reset asserts below `BOD_ASSERT_V` and the delay starts above
 * `BOD_RELEASE_V`. `RESET_HOLD_MS` is tTOUT 65 ms plus 16K CK.
 */
export const BOD_ASSERT_V = 2.675;
export const BOD_RELEASE_V = 2.725;
export const RESET_HOLD_MS = 66;

export type BrownoutPhase = "run" | "held" | "delay";

export type BrownoutState = {
  phase: BrownoutPhase;
  /**
   * Sim millisecond of the step whose rail rose above `BOD_RELEASE_V`.
   * Null while the rail has not released.
   */
  releaseAtMs: number | null;
};

export function runningBrownout(): BrownoutState {
  return { phase: "run", releaseAtMs: null };
}

function clamp(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

/**
 * One step of the brown-out state machine. `stepEndMs` is the sim time
 * this step is recorded at. `assertReset` is the falling edge.
 * `reboot` is the first instruction, `RESET_HOLD_MS` after release.
 */
export function stepBrownout(
  state: BrownoutState,
  voltage: number,
  stepEndMs: number
): BrownoutState & { assertReset: boolean; reboot: boolean } {
  if (state.phase === "run") {
    if (voltage < BOD_ASSERT_V) {
      return {
        phase: "held",
        releaseAtMs: null,
        assertReset: true,
        reboot: false,
      };
    }
    return { ...state, assertReset: false, reboot: false };
  }
  if (!(voltage > BOD_RELEASE_V)) {
    return {
      phase: "held",
      releaseAtMs: null,
      assertReset: false,
      reboot: false,
    };
  }
  const releaseAtMs = state.releaseAtMs ?? stepEndMs;
  if (stepEndMs - releaseAtMs >= RESET_HOLD_MS) {
    return {
      phase: "run",
      releaseAtMs: null,
      assertReset: false,
      reboot: true,
    };
  }
  return {
    phase: "delay",
    releaseAtMs,
    assertReset: false,
    reboot: false,
  };
}

export type MotorLaw = {
  /** V·s/rad, output side, gearbox included. */
  k: number;
  /** Ohms. */
  resistance: number;
  /** Gearbox efficiency. Torque is `efficiency · k · I`. */
  efficiency: number;
  /** Radians of error that saturates the drive. */
  eSat: number;
  /** Amperes of electronics, added to the bridge draw. */
  quiescent: number;
};

/**
 * `V_drive = V_rail · clamp(error / E_sat, −1, 1)`. Limp is an open
 * winding: no motor current and no torque. The catalog torque is a
 * clamp on the torque, not on the current.
 */
export function servoElectrical(input: {
  law: MotorLaw;
  /** Volts. The rail this step. */
  vRail: number;
  /** Radians. Command minus measured angle. Ignored when limp. */
  errorRad: number;
  /** rad/s. */
  omega: number;
  limp: boolean;
  /** Newton-metres. `|τ|` is clamped to this. */
  torqueLimit: number;
}): {
  fraction: number;
  vDrive: number;
  iMotor: number;
  torque: number;
  saturated: boolean;
  /**
   * Amperes from the supply: quiescent plus `max(0, s·I_motor)`,
   * `s = V_drive / V_rail`. Braking current does not come from the supply.
   */
  supplyCurrent: number;
} {
  const { law } = input;
  if (input.limp) {
    return {
      fraction: 0,
      vDrive: 0,
      iMotor: 0,
      torque: 0,
      saturated: false,
      supplyCurrent: law.quiescent,
    };
  }
  const fraction = law.eSat > 0 ? clamp(input.errorRad / law.eSat, -1, 1) : 0;
  const vDrive = input.vRail * fraction;
  const iMotor = (vDrive - law.k * input.omega) / law.resistance;
  let torque = law.efficiency * law.k * iMotor;
  const limit = input.torqueLimit;
  if (limit > 0) {
    if (torque > limit) torque = limit;
    else if (torque < -limit) torque = -limit;
  }
  return {
    fraction,
    vDrive,
    iMotor,
    torque,
    saturated: Math.abs(fraction) >= 1 - 1e-12,
    supplyCurrent: law.quiescent + Math.max(0, fraction * iMotor),
  };
}

/** Ideal no-load speed, rad/s: `V / K`, before friction. */
export function noLoadSpeedRad(voltage: number, k: number): number {
  if (!(k > 0)) return 0;
  return voltage / k;
}

/** Stall current at ω = 0 with a saturated drive, amperes. */
export function stallCurrent(voltage: number, resistance: number): number {
  if (!(resistance > 0)) return 0;
  return voltage / resistance;
}

/** Stall torque at ω = 0 with a saturated drive, newton-metres. */
export function stallTorque(
  voltage: number,
  law: Pick<MotorLaw, "k" | "resistance" | "efficiency">
): number {
  return law.efficiency * law.k * stallCurrent(voltage, law.resistance);
}

/**
 * Idle, moving, or stall for the inspector. Not an electrical input.
 * Stall is a saturated drive slower than 5 °/s, held for
 * `DISPLAY_STALL_HOLD_MS`. Until then that condition shows as moving.
 */
export function displayMotion(input: {
  limp: boolean;
  saturated: boolean;
  errorRad: number;
  omega: number;
  /** Milliseconds the stall condition has held, including this step. */
  stallForMs: number;
}): WorldPartMotion {
  if (input.limp) return "idle";
  const stallOmega = (DISPLAY_STALL_DEG_PER_SEC * Math.PI) / 180;
  const moveError = (DISPLAY_MOVE_DEG * Math.PI) / 180;
  const speed = Math.abs(input.omega);
  const stalled = input.saturated && speed < stallOmega;
  if (stalled && input.stallForMs >= DISPLAY_STALL_HOLD_MS) return "stall";
  if (stalled || speed >= stallOmega || Math.abs(input.errorRad) > moveError) {
    return "moving";
  }
  return "idle";
}

export type RailMotor = {
  fraction: number;
  omega: number;
  k: number;
  resistance: number;
};

/**
 * `V = V_nom − R_s·I` while `I ≤ I_limit`. Above the limit, `V` is the
 * greatest voltage where the draw equals `I_limit`. `fixed` is the board
 * plus every servo's quiescent. Each motor adds `max(0, s·I_motor)` with
 * `s` the drive fraction, so braking current does not come from the
 * supply. That term is affine in `V`. Voltage is never negative.
 */
export function solveRail(input: {
  vNom: number;
  rSeries: number;
  iLimit: number;
  fixed: number;
  motors: readonly RailMotor[];
}): { voltage: number; current: number } {
  const terms = input.motors.map((motor) => {
    const r = motor.resistance;
    const s = motor.fraction;
    if (!(r > 0)) return { a: 0, b: 0 };
    return { a: (s * s) / r, b: -(s * motor.k * motor.omega) / r };
  });
  const segmentAt = (voltage: number) => {
    let slope = 0;
    let intercept = input.fixed;
    for (const term of terms) {
      if (term.a * voltage + term.b > 0) {
        slope += term.a;
        intercept += term.b;
      }
    }
    return { slope, intercept };
  };
  const drawAt = (voltage: number) => {
    const { slope, intercept } = segmentAt(voltage);
    return intercept + slope * voltage;
  };
  const cap = Math.max(input.vNom * 4, 1);
  const bounds = [0, cap];
  for (const term of terms) {
    if (!(term.a > 0)) continue;
    const zero = -term.b / term.a;
    if (zero > 0 && zero < cap) bounds.push(zero);
  }
  bounds.sort((a, b) => a - b);
  const points: number[] = [];
  for (const bound of bounds) {
    const last = points[points.length - 1];
    if (last === undefined || bound - last > 1e-12) points.push(bound);
  }
  let cv: number | null = null;
  for (let i = 0; i < points.length - 1; i++) {
    const lo = points[i] ?? 0;
    const hi = points[i + 1] ?? lo;
    if (!(hi > lo)) continue;
    const { slope, intercept } = segmentAt((lo + hi) / 2);
    const denom = 1 + input.rSeries * slope;
    if (!(Math.abs(denom) > 1e-12)) continue;
    const voltage = (input.vNom - input.rSeries * intercept) / denom;
    if (voltage >= lo - 1e-8 && voltage <= hi + 1e-8) {
      cv = clamp(voltage, 0, cap);
      break;
    }
  }
  if (cv === null) cv = 0;
  const current = drawAt(cv);
  if (current <= input.iLimit + 1e-9) return { voltage: cv, current };
  let limited: number | null = null;
  for (let i = 0; i < points.length - 1; i++) {
    const lo = points[i] ?? 0;
    const hi = points[i + 1] ?? lo;
    if (!(hi > lo) || lo > cv + 1e-8) continue;
    const { slope, intercept } = segmentAt((lo + hi) / 2);
    if (!(Math.abs(slope) > 1e-15)) continue;
    const voltage = (input.iLimit - intercept) / slope;
    if (voltage < lo - 1e-8 || voltage > hi + 1e-8) continue;
    if (voltage > cv + 1e-8) continue;
    if (limited === null || voltage > limited) limited = voltage;
  }
  if (limited === null) return { voltage: 0, current: drawAt(0) };
  return { voltage: clamp(limited, 0, cv), current: input.iLimit };
}
