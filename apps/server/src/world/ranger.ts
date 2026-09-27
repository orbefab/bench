/**
 * HC-SR04 at behaviour classes 0 and 1. Trig edges come from the board's
 * port listener. Echo edges are `addClockEvent`s applied with `setDriven`,
 * so `pulseIn` measures them to the cycle. The ray is cast once per
 * accepted trigger, on the physics state of the previous master step:
 * the CPU runs before `mj_step`, the same lag as the ADC latch.
 */

import type { Pose } from "@sfab-bench/contract";

import type { AvrBoard } from "./board";
import { CPU_HZ } from "./board";

/** Include geom group 0 only. Device geoms are moved to group 1. */
export const RANGER_GEOM_GROUP = [1, 0, 0, 0, 0, 0];

/**
 * One centre ray, then five radial steps out to the half-angle and eight
 * azimuths. The outer ring sits on the cone, and two of the azimuths are
 * horizontal, so a sideways pole is within one radial step of the edge.
 */
const RADIAL_STEPS = 5;
const AZIMUTHS = 8;

export type RangerLaw = {
  /** Metres per second. */
  c: number;
  rangeMin: number;
  rangeMax: number;
  /** Radians. Zero is one on-axis ray and no cone. */
  beamHalf: number;
  /** Seconds. Zero accepts any high time. */
  trigMin: number;
  /** Seconds from Trig's fall to Echo's rise. */
  echoDelay: number;
  /** Seconds Echo stays high when nothing returns. Zero means no pulse. */
  echoTimeout: number;
  /** Amperes while a measurement is in progress. */
  working: number;
  /** Amperes while powered and idle. */
  quiescent: number;
  /** Volts. Below this, no echo and no draw. */
  vMin: number;
  /** Metres from the part origin to the transducer plane, along local +Y. */
  face: number;
};

export type RunRanger = {
  id: string;
  model: string;
  pose: Pose;
  law: RangerLaw;
  /** Board pin that drives Trig. Null when Trig is unwired. */
  trig: { boardId: string; bit: number } | null;
  /** Board pin Echo drives. Null when Echo is unwired. */
  echo: { boardId: string; bit: number } | null;
};

export type RangerRay = {
  mj_ray(
    model: unknown,
    data: unknown,
    pnt: number[],
    vec: number[],
    geomgroup: number[],
    flgStatic: boolean,
    bodyexclude: number,
    geomid: Int32Array,
    normal: Float64Array
  ): number;
};

export type RangerPhysics = {
  mj: { mj_ray: RangerRay["mj_ray"] };
  model: unknown;
  data: unknown;
};

type Vec3 = [number, number, number];

function rotate(q: Pose["rotation"], v: Vec3): Vec3 {
  const w = q[0];
  const x = q[1];
  const y = q[2];
  const z = q[3];
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}

/** Directions in the part frame. The first is the sensor axis, local +Y. */
export function rangerDirections(beamHalf: number): Vec3[] {
  const forward: Vec3 = [0, 1, 0];
  if (!(beamHalf > 0)) return [forward];
  const right: Vec3 = [1, 0, 0];
  const up: Vec3 = [0, 0, 1];
  const out: Vec3[] = [forward];
  for (let step = 1; step <= RADIAL_STEPS; step++) {
    const theta = (beamHalf * step) / RADIAL_STEPS;
    const along = Math.cos(theta);
    const across = Math.sin(theta);
    for (let az = 0; az < AZIMUTHS; az++) {
      const phi = (az * 2 * Math.PI) / AZIMUTHS;
      out.push(
        add(
          scale(forward, along),
          add(scale(right, across * Math.cos(phi)), scale(up, across * Math.sin(phi)))
        )
      );
    }
  }
  return out;
}

const geomid = new Int32Array(1);
const normal = new Float64Array(3);

/**
 * Nearest hit in metres, or null. Group 0 only, so the device's own
 * geoms (group 1, including the ground) are skipped. `bodyexclude` is
 * -1: the gauge is many bodies, and the group split covers all of them.
 */
export function castRanger(
  physics: RangerPhysics,
  pose: Pose,
  face: number,
  directions: readonly Vec3[],
  rangeMin: number,
  rangeMax: number
): number | null {
  const origin = add(pose.position, rotate(pose.rotation, [0, face, 0]));
  let best: number | null = null;
  const limited = rangeMax > rangeMin;
  for (const local of directions) {
    const vec = rotate(pose.rotation, local);
    const dist = physics.mj.mj_ray(
      physics.model,
      physics.data,
      origin,
      vec,
      RANGER_GEOM_GROUP,
      true,
      -1,
      geomid,
      normal
    );
    if (!(dist >= 0)) continue;
    if (limited && (dist < rangeMin || dist > rangeMax)) continue;
    if (best === null || dist < best) best = dist;
  }
  return best;
}

/**
 * One sensor during a run. `token` drops a scheduled edge after a reboot
 * replaces the CPU. `drew` stays set until the rail is solved, so a
 * measurement that starts and ends inside one millisecond still draws
 * the working current.
 */
export class RangerRuntime {
  readonly spec: RunRanger;
  readonly directions: Vec3[];
  board: AvrBoard | null = null;
  supplyId: string | null = null;
  distanceM: number | null = null;
  echoS: number | null = null;
  hit = false;
  current = 0;
  private busy = false;
  private measuring = false;
  private drew = false;
  private armed = false;
  private riseAt = 0;
  private token = 0;

  constructor(spec: RunRanger) {
    this.spec = spec;
    this.directions = rangerDirections(spec.law.beamHalf);
  }

  /** Volts on the node that feeds VCC, from the latch. */
  volts: () => number = () => 0;
  physics: () => RangerPhysics | null = () => null;

  powered(): boolean {
    if (!this.supplyId) return false;
    return this.volts() >= this.spec.law.vMin;
  }

  /**
   * Amperes for the rail solve, then clear the one-step latch.
   * Unpowered is 0. A measurement in this millisecond draws `working`.
   */
  takeDraw(): number {
    const draw = !this.powered()
      ? 0
      : this.measuring || this.drew
        ? this.spec.law.working
        : this.spec.law.quiescent;
    this.drew = false;
    this.current = draw;
    return draw;
  }

  /** New CPU, or the sensor just bound. Echo is driven low when powered. */
  reset(board: AvrBoard | null) {
    this.token += 1;
    this.busy = false;
    this.measuring = false;
    this.drew = false;
    this.armed = false;
    this.board = board;
    this.releaseEcho();
  }

  onEdge(bit: number, high: boolean, cycles: number) {
    const trig = this.spec.trig;
    if (!trig || bit !== trig.bit || !this.board) return;
    if (high) {
      // A rise during a measurement is not a new trigger, even if the
      // fall lands after Echo has already gone low.
      if (this.busy) {
        this.armed = false;
        return;
      }
      this.armed = true;
      this.riseAt = cycles;
      return;
    }
    if (!this.armed) return;
    this.armed = false;
    const highCycles = cycles - this.riseAt;
    const minCycles = Math.round(this.spec.law.trigMin * CPU_HZ);
    if (highCycles < minCycles) return;
    if (!this.powered()) {
      this.distanceM = null;
      this.echoS = null;
      this.hit = false;
      this.releaseEcho();
      return;
    }
    this.begin();
  }

  private begin() {
    const physics = this.physics();
    const hit = physics
      ? castRanger(
          physics,
          this.spec.pose,
          this.spec.law.face,
          this.directions,
          this.spec.law.rangeMin,
          this.spec.law.rangeMax
        )
      : null;
    const law = this.spec.law;
    const widthCycles =
      hit === null || !(law.c > 0)
        ? 0
        : Math.max(1, Math.round(((2 * hit) / law.c) * CPU_HZ));
    const timeoutCycles = Math.round(law.echoTimeout * CPU_HZ);
    const echoCycles = hit === null ? timeoutCycles : widthCycles;
    this.distanceM = hit;
    this.hit = hit !== null;
    this.echoS = echoCycles > 0 ? echoCycles / CPU_HZ : null;
    if (echoCycles <= 0) return;
    const board = this.board;
    const echo = this.spec.echo;
    if (!board || !echo) return;
    this.busy = true;
    this.measuring = true;
    this.drew = true;
    const token = this.token;
    const delay = Math.round(law.echoDelay * CPU_HZ);
    board.schedule(delay, () => {
      if (token !== this.token || !this.busy) return;
      board.setDriven(echo.bit, true);
      board.schedule(echoCycles, () => {
        if (token !== this.token) return;
        board.setDriven(echo.bit, false);
        this.busy = false;
        this.measuring = false;
      });
    });
  }

  private releaseEcho() {
    const echo = this.spec.echo;
    const board = this.board;
    if (!echo || !board) return;
    board.setDriven(echo.bit, this.powered() ? false : null);
  }
}
