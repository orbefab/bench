/**
 * Shafts and controls: circuit parts that turn or read a joint, and the
 * pulse loop of a `servo-control@1`. The joint is read before the solve,
 * the same moment a `position-servo@1` samples it. The winding's speed
 * and the wiper are held for the master step. The control's bridge ratio
 * comes from the pulse and the sense ratio latched after the previous
 * solve, so its loop is one master step behind the joint.
 */

import { pinIndex, type WorldPartMotion } from "@sfab-bench/contract";
import {
  BridgeDriver,
  DcWinding,
  type Element,
  Potentiometer,
} from "@sfab-bench/engine-circuit";
import type { AvrBoard } from "@sfab-bench/engine-mcu";
import type { RunControl, RunPlan, RunShaft } from "../plan";
import { DISPLAY_STALL_DEG_PER_SEC, displayMotion } from "../power";
import type { RailCircuit } from "../rail-circuit";
import { blankTrack, type ServoTrack, trackServo } from "../servo";
import { scalar } from "./recorder";
import type { SessionState } from "./state";

export type ControlRuntime = {
  spec: RunControl;
  /** The live CPU on its logic input, or null when it has no pulse wire. */
  board: AvrBoard | null;
  pinBit: number;
  track: ServoTrack;
  /** Degrees from `setTarget`. Only when there is no pulse wire. */
  manualDeg: number | null;
  driver: BridgeDriver | null;
  circuit: RailCircuit | null;
  /** Angle error the bridge ratio came from, radians. 0 when open. */
  errorRad: number;
};

/**
 * The instance a shaft is named after, read at its own ports: the current
 * its stamped elements draw from its power input's node, and that node
 * against its ground. Like a `position-servo@1` part's row.
 */
export type ShaftPart = {
  circuit: RailCircuit;
  elements: Element[];
  power: string;
  ground: string;
  /** The one `servo-control@1` under the instance, if any. */
  control: ControlRuntime | null;
  current: number;
  voltage: number;
  state: WorldPartMotion;
  stallMs: number;
};

export type ShaftRuntime = {
  spec: RunShaft;
  jointName: string;
  motors: {
    spec: RunShaft["motors"][number];
    winding: DcWinding;
    circuit: RailCircuit;
    /** Mean winding current of the last solve, amperes. */
    current: number;
  }[];
  sensors: { spec: RunShaft["sensors"][number]; pot: Potentiometer }[];
  /** Joint speed read before this step's solve, rad/s. */
  omegaBefore: number;
  /** Null when the instance has no power input a stamped part sits on. */
  part: ShaftPart | null;
};

function circuits(s: SessionState): RailCircuit[] {
  return [...new Set([...s.rails.values()].map((group) => group.circuit))];
}

function findElement<T>(
  s: SessionState,
  id: string,
  kind: new (...args: never[]) => T
): { element: T; circuit: RailCircuit } | null {
  for (const circuit of circuits(s)) {
    const element = circuit.element(id);
    if (element instanceof kind) return { element, circuit };
  }
  return null;
}

/** After the rails exist. A part the rail pruned is not bound. */
export function bindShafts(s: SessionState, plan: RunPlan): void {
  s.controls = [];
  s.shafts = [];
  for (const spec of plan.controls ?? []) {
    const found = findElement(s, spec.path, BridgeDriver);
    const signal = spec.signal;
    const names = signal
      ? plan.boards.find((item) => item.id === signal.boardId)?.pinOrder
      : undefined;
    const bit = signal && names ? pinIndex(names, signal.pin) : undefined;
    const board = signal
      ? s.boards.find((item) => item.id === signal.boardId)
      : undefined;
    const wired = board !== undefined && bit !== undefined;
    if (wired && board && bit !== undefined) board.watchEdge(bit);
    s.controls.push({
      spec,
      board: wired && board ? board : null,
      pinBit: wired && bit !== undefined ? bit : -1,
      track: blankTrack(),
      manualDeg: null,
      driver: found?.element ?? null,
      circuit: found?.circuit ?? null,
      errorRad: 0,
    });
  }
  for (const spec of plan.shafts ?? []) {
    const motors: ShaftRuntime["motors"] = [];
    for (const motor of spec.motors) {
      const found = findElement(s, motor.path, DcWinding);
      if (!found) continue;
      motors.push({
        spec: motor,
        winding: found.element,
        circuit: found.circuit,
        current: 0,
      });
    }
    const sensors: ShaftRuntime["sensors"] = [];
    for (const sensor of spec.sensors) {
      const found = findElement(s, sensor.path, Potentiometer);
      if (found) sensors.push({ spec: sensor, pot: found.element });
    }
    s.shafts.push({
      spec,
      jointName: `${spec.drives.robot}/${spec.drives.joint}`,
      motors,
      sensors,
      omegaBefore: 0,
      part: shaftPart(s, spec),
    });
  }
}

function shaftPart(s: SessionState, spec: RunShaft): ShaftPart | null {
  const { power, ground } = spec.ports;
  if (!power) return null;
  for (const circuit of circuits(s)) {
    const node = circuit.stampedNode(power);
    if (!node) continue;
    const under = s.controls.filter((control) =>
      control.spec.path.startsWith(`${spec.id}.`)
    );
    return {
      circuit,
      elements: circuit.elementsUnder(spec.id),
      power: node,
      ground: (ground ? circuit.stampedNode(ground) : null) ?? "0",
      control: under.length === 1 ? (under[0] ?? null) : null,
      current: 0,
      voltage: 0,
      state: "idle",
      stallMs: 0,
    };
  }
  return null;
}

/** A board that reloaded: its controls watch the new CPU and start limp. */
export function rearmControls(
  s: SessionState,
  boardId: string,
  board: AvrBoard
): void {
  for (const control of s.controls) {
    if (!control.board || control.board.id !== boardId) continue;
    control.board = board;
    board.watchEdge(control.pinBit);
    control.track = blankTrack();
  }
}

/** Fold this step's pulses (`stepPulses`, already taken) into each command. */
export function latchControls(s: SessionState, simTime: number): void {
  for (const control of s.controls) {
    const cpu = control.board;
    if (!cpu) continue;
    const driven = Boolean(cpu.running && !cpu.inReset);
    const taken = driven ? s.stepPulses.get(cpu.id) : undefined;
    const widths = taken
      ? taken
          .filter((pulse) => pulse.bit === control.pinBit)
          .map((pulse) => pulse.us)
      : [];
    control.track = trackServo({
      track: control.track,
      simTime,
      pulsesUs: widths,
      driven,
    }).track;
  }
}

/**
 * Before a solve: each winding's speed and each wiper from the joint,
 * and each bridge ratio from the command and the latched sense ratio.
 */
export function prepareShafts(s: SessionState): void {
  const sim = s.sim;
  if (!sim) return;
  for (const shaft of s.shafts) {
    const joint = sim.data.jnt(shaft.jointName);
    const qpos = scalar(joint.qpos as Float64Array);
    const omega = scalar(joint.qvel as Float64Array);
    shaft.omegaBefore = omega;
    for (const motor of shaft.motors) {
      motor.winding.omega = motor.spec.ratio * omega;
    }
    for (const sensor of shaft.sensors) {
      const travel = sensor.spec.travel;
      const at = travel > 0 ? (sensor.spec.ratio * qpos) / travel : 0;
      sensor.pot.fraction = at < 0 ? 0 : at > 1 ? 1 : at;
    }
  }
  for (const control of s.controls) {
    const driver = control.driver;
    if (!driver) continue;
    const command = control.board
      ? control.track.commandDeg
      : control.manualDeg;
    const sense = driver.senseRatio;
    if (command === null || sense === null) {
      driver.connected = false;
      driver.s = 0;
      control.errorRad = 0;
      continue;
    }
    const { eSat, travel } = control.spec;
    const errorRad = (command * Math.PI) / 180 - sense * travel;
    control.errorRad = errorRad;
    const ratio = eSat > 0 ? errorRad / eSat : 0;
    driver.s = ratio > 1 ? 1 : ratio < -1 ? -1 : ratio;
    driver.connected = true;
  }
}

/** Bridges on `circuit` whose pulse comes from `boardId` and that are driving. */
export function driversTripped(
  s: SessionState,
  circuit: RailCircuit,
  boardId: string
): string[] {
  return s.controls
    .filter(
      (control) =>
        control.circuit === circuit &&
        control.board?.id === boardId &&
        control.driver?.connected === true
    )
    .map((control) => control.spec.path);
}

/**
 * After the solves: each winding's mean current, and each shaft part's
 * port current and voltage at the end of the step.
 */
export function readShafts(s: SessionState): void {
  for (const shaft of s.shafts) {
    for (const motor of shaft.motors) {
      motor.current = motor.circuit.windingCurrent(motor.spec.path) ?? 0;
    }
    const part = shaft.part;
    if (!part) continue;
    part.current = part.circuit.currentLeaving(part.elements, part.power);
    part.voltage =
      part.circuit.nodeVoltage(part.power) -
      part.circuit.nodeVoltage(part.ground);
  }
}

/** After the step: each shaft part's display state, as `classifyLoads`. */
export function classifyShafts(s: SessionState): void {
  const sim = s.sim;
  if (!sim) return;
  const stallOmega = (DISPLAY_STALL_DEG_PER_SEC * Math.PI) / 180;
  for (const shaft of s.shafts) {
    const part = shaft.part;
    if (!part) continue;
    const driver = part.control?.driver ?? null;
    const limp = !driver?.connected;
    const saturated = !limp && Math.abs(driver?.s ?? 0) >= 1;
    const omega = scalar(sim.data.jnt(shaft.jointName).qvel as Float64Array);
    const stalling = saturated && Math.abs(omega) < stallOmega;
    // Counted in steps so a sum of fractional steps lands on whole ms.
    part.stallMs = stalling
      ? Math.round(part.stallMs * s.perMs + 1) / s.perMs
      : 0;
    part.state = displayMotion({
      limp,
      saturated,
      errorRad: part.control?.errorRad ?? 0,
      omega,
      stallForMs: part.stallMs,
    });
  }
}

/**
 * Joint torque `Σ ratio·efficiency·K·I`, clamped to the shaft's rating.
 * A control whose board is held starts limp on the next pulse.
 */
export function applyShaftTorque(s: SessionState): void {
  const sim = s.sim;
  if (!sim) return;
  for (const shaft of s.shafts) {
    let torque = 0;
    for (const motor of shaft.motors) {
      const { ratio, efficiency, k } = motor.spec;
      torque += ratio * efficiency * k * motor.current;
    }
    const limit = shaft.spec.torqueNm;
    if (limit > 0) {
      if (torque > limit) torque = limit;
      else if (torque < -limit) torque = -limit;
    }
    sim.data.actuator(shaft.spec.id).ctrl = torque;
  }
  for (const control of s.controls) {
    const cpu = control.board;
    if (cpu && (!cpu.running || cpu.inReset)) control.track = blankTrack();
  }
}

/**
 * The motor seam of each shaft, priced at the joint: `K` output-referred
 * (`ratio·K`) against the joint speed. True when any shaft noted.
 */
export function noteShaftSeams(s: SessionState, dt: number): boolean {
  const sim = s.sim;
  if (!sim) return false;
  let noted = false;
  for (const shaft of s.shafts) {
    const motor = shaft.motors[0];
    if (!motor) continue;
    const omegaAfter = scalar(
      sim.data.jnt(shaft.jointName).qvel as Float64Array
    );
    // An open bridge sends nothing, so its seam is priced at rest, as the
    // lumped seam prices a limp servo. The joint still moves.
    const driver = shaft.part?.control?.driver;
    const open = driver ? driver.connected !== true : false;
    s.seams.note({
      path: shaft.spec.id,
      dt,
      k: motor.spec.ratio * motor.spec.k,
      omega: open ? 0 : shaft.omegaBefore,
      current: motor.current,
      ctrl: sim.data.actuator(shaft.spec.id).ctrl as number,
      omegaBefore: shaft.omegaBefore,
      omegaAfter,
    });
    noted = true;
  }
  return noted;
}

/**
 * `setTarget` on an instance with no `position-servo@1` part: the one
 * control at or under that path, when it has no pulse wire.
 */
export function setControlTarget(
  s: SessionState,
  partId: string,
  degrees: number
): boolean {
  const mine = s.controls.filter(
    (control) =>
      control.spec.path === partId || control.spec.path.startsWith(`${partId}.`)
  );
  const only = mine.length === 1 ? mine[0] : undefined;
  if (!only) return false;
  if (!only.board) only.manualDeg = degrees;
  return true;
}
