/** Actuators: servos, torque, loads, rangers, body envelopes, the motor seams, and the agent's targets. */

import type { WorldVec3 } from "@sfab-bench/contract";
import type { AvrBoard } from "@sfab-bench/engine-mcu";
import type { RunPlan } from "../plan";
import { DISPLAY_STALL_DEG_PER_SEC, displayMotion } from "../power";
import { RangerRuntime } from "../ranger";
import { blankTrack, trackServo } from "../servo";
import { targetPosition } from "../targets";
import { fail, simMs } from "./common";
import { latchedSupplyNode } from "./rails";
import { scalar } from "./recorder";
import { warnEnvelope } from "./solve";
import type { Load, ServoDrive, SessionState } from "./state";

export function rearmServos(s: SessionState, boardId: string, board: AvrBoard) {
  for (const load of s.loads) {
    const drive = load.drive;
    if (!drive?.board || drive.board.id !== boardId) continue;
    drive.board = board;
    board.watchEdge(drive.pinBit);
    drive.track = blankTrack();
    load.state = "idle";
    load.sample = null;
    load.stallMs = 0;
  }
}

function jointNow(
  s: SessionState,
  drive: ServoDrive
): { qpos: number; omega: number } {
  if (!s.sim) return { qpos: 0, omega: 0 };
  const qpos = scalar(s.sim.data.jnt(drive.jointName).qpos as Float64Array);
  const omega = scalar(s.sim.data.jnt(drive.jointName).qvel as Float64Array);
  return { qpos, omega };
}

/** Command latched so far, measured against the joint, before this step's torque. */
export function sampleLoad(s: SessionState, load: Load) {
  const drive = load.drive;
  if (!drive) {
    load.sample = null;
    return;
  }
  const { qpos, omega } = jointNow(s, drive);
  const command = drive.board ? drive.track.commandDeg : drive.manualDeg;
  const limp = command === null;
  const errorRad = limp ? 0 : (command * Math.PI) / 180 - qpos;
  const fraction =
    limp || !(drive.law.eSat > 0) ? 0 : errorRad / drive.law.eSat;
  const clamped = fraction > 1 ? 1 : fraction < -1 ? -1 : fraction;
  load.sample = {
    limp,
    saturated: !limp && Math.abs(clamped) >= 1 - 1e-12,
    errorRad,
    omega,
    fraction: limp ? 0 : clamped,
  };
}

export function bindRangers(s: SessionState, plan: RunPlan) {
  s.rangers = (plan.rangers ?? []).map((spec) => {
    const ranger = new RangerRuntime(spec);
    ranger.supplyId = s.partFeeds[spec.id] ?? null;
    ranger.volts = () =>
      ranger.supplyId ? latchedSupplyNode(s, ranger.supplyId) : 0;
    ranger.physics = () =>
      s.sim ? { mj: s.sim.mj, model: s.sim.model, data: s.sim.data } : null;
    return ranger;
  });
  for (const board of s.boards) rearmRangers(s, board.id, board);
}

export function rearmRangers(
  s: SessionState,
  boardId: string,
  board: AvrBoard
) {
  const listening = s.rangers.filter(
    (ranger) => ranger.spec.trig?.boardId === boardId
  );
  for (const ranger of s.rangers) {
    const trig = ranger.spec.trig?.boardId;
    const echo = ranger.spec.echo?.boardId;
    if (trig !== boardId && echo !== boardId) continue;
    ranger.reset(board);
  }
  board.onEdge =
    listening.length === 0
      ? null
      : (bit, high, cycles) => {
          for (const ranger of listening) ranger.onEdge(bit, high, cycles);
        };
}

/** Fold this step's completed pulses into the latched command. */
export function latchServos(s: SessionState) {
  if (!s.sim) return;
  const simTime = s.sim.data.time;
  s.stepPulses.clear();
  for (const board of s.boards) {
    const taken = board.takePulses();
    if (taken.length > 0) s.stepPulses.set(board.id, taken);
  }
  for (const load of s.loads) {
    const drive = load.drive;
    if (!drive?.board) continue;
    const cpu = drive.board;
    const driven = Boolean(cpu.running && !cpu.inReset);
    const taken = driven ? s.stepPulses.get(cpu.id) : undefined;
    const widths = taken
      ? taken
          .filter((pulse) => pulse.bit === drive.pinBit)
          .map((pulse) => pulse.us)
      : [];
    const stepped = trackServo({
      track: drive.track,
      simTime,
      pulsesUs: widths,
      driven,
    });
    drive.track = stepped.track;
  }
}

/** Motor torque from the rail solved for the latched command. */
export function applyTorque(s: SessionState) {
  if (!s.sim) return;
  for (const load of s.loads) {
    const drive = load.drive;
    const sample = load.sample;
    if (!drive || !sample) continue;
    const cpu = drive.board;
    const powered = load.supplyId !== null;
    const held = cpu !== null && (!cpu.running || cpu.inReset);
    // The sample is the current already charged to the rail, including
    // the step that asserts reset. A board already in reset was latched
    // limp, so its sample carries no torque.
    const limp = !powered || sample.limp;
    let torque = 0;
    if (!limp) {
      torque = drive.law.efficiency * drive.law.k * load.winding;
      const limit = drive.torqueNm;
      if (limit > 0) {
        if (torque > limit) torque = limit;
        else if (torque < -limit) torque = -limit;
      }
    }
    s.sim.data.actuator(load.partId).ctrl = torque;
    if (held) drive.track = blankTrack();
  }
}

/** Display state from the sample that solved the rail and the joint after the step. */
export function classifyLoads(s: SessionState) {
  if (!s.sim) return;
  for (const load of s.loads) {
    const drive = load.drive;
    const sample = load.sample;
    if (!drive || !sample) {
      load.state = "idle";
      load.stallMs = 0;
      continue;
    }
    const omega = scalar(s.sim.data.jnt(drive.jointName).qvel as Float64Array);
    const stallOmega = (DISPLAY_STALL_DEG_PER_SEC * Math.PI) / 180;
    const stalling =
      !sample.limp && sample.saturated && Math.abs(omega) < stallOmega;
    load.stallMs = stalling ? load.stallMs + 1 : 0;
    load.state = displayMotion({
      limp: sample.limp,
      saturated: sample.saturated,
      errorRad: sample.errorRad,
      omega,
      stallForMs: load.stallMs,
    });
    noteBodyEnvelope(s, load.partId, omega);
  }
}

/** Joint speed and applied torque against a body snapshot's shaft bounds. */
function noteBodyEnvelope(
  s: SessionState,
  partId: string,
  speed: number
): void {
  if (!s.sim) return;
  const snap = s.runPlan?.parts.find(
    (part) => part.id === partId
  )?.bodySnapshot;
  if (!snap) return;
  const torque = s.sim.data.actuator(partId).ctrl as number;
  const observed: Record<string, number> = {};
  for (const key of Object.keys(snap.bounds)) {
    if (key.endsWith(".speed")) observed[key] = speed;
    else if (key.endsWith(".torque")) observed[key] = torque;
  }
  warnEnvelope(
    s,
    partId,
    snap.ref,
    { bounds: snap.bounds, current: [0, 0] },
    observed
  );
}

/**
 * Joules across the motor seam. Reads the rail's ω and current and the
 * joint speed around the body step. Prices every term with the model's
 * timestep. Does not write an engine input. The report's `seams` array
 * is replaced only when a window closes.
 */
export function noteMotorSeams(s: SessionState): void {
  if (!s.sim) return;
  const dt = s.sim.model.opt.timestep;
  let noted = false;
  for (const load of s.loads) {
    const drive = load.drive;
    const sample = load.sample;
    if (!drive || !sample) continue;
    const connected = !sample.limp;
    const omegaAfter = scalar(
      s.sim.data.jnt(drive.jointName).qvel as Float64Array
    );
    const ctrl = s.sim.data.actuator(load.partId).ctrl as number;
    s.seams.note({
      path: load.partId,
      dt,
      k: drive.law.k,
      omega: connected ? sample.omega : 0,
      current: load.winding,
      ctrl,
      omegaBefore: sample.omega,
      omegaAfter,
    });
    noted = true;
  }
  if (!noted) return;
  const closed = s.seams.endStep();
  if (!closed.closed || !s.runReport) return;
  s.runReport.seams = s.seams.rows();
  for (const warning of closed.warnings) s.runReport.warnings.push(warning);
  s.reportPending = true;
}

/**
 * Command a servo that has no signal wire. The angle is the motor-law
 * command, the same input a pulse would be. A signal wire owns the
 * servo, so this leaves that joint alone.
 */
export function setTarget(s: SessionState, partId: string, radians: number) {
  if (!s.sim) return;
  if (!Number.isFinite(radians)) {
    fail(s, [], `target for "${partId}" is not a finite angle.`);
    return;
  }
  const id = s.sim.index.parts[partId];
  if (id === undefined) {
    fail(s, [], `no actuator for part "${partId}".`);
    return;
  }
  const drive = s.loads.find((item) => item.partId === partId)?.drive;
  if (!drive || drive.board) return;
  drive.manualDeg = (radians * 180) / Math.PI;
}

/**
 * Write each target's mocap pose for the physics step about to run.
 * `data.time` is still the time of the state the CPU just finished on.
 */
export function placeTargets(s: SessionState) {
  if (!s.sim || !s.runPlan || s.runPlan.environment.targets.length === 0)
    return;
  const pos = s.sim.data.mocap_pos as Float64Array;
  const quat = s.sim.data.mocap_quat as Float64Array;
  const time = s.sim.data.time;
  for (const item of s.sim.index.targets) {
    const spec = s.runPlan.environment.targets.find(
      (target) => target.id === item.id
    );
    if (!spec) continue;
    const p = targetPosition(spec, time, s.targetHolds.get(item.id) ?? null);
    const base = item.mocap * 3;
    pos[base] = p[0];
    pos[base + 1] = p[1];
    pos[base + 2] = p[2];
    const q = spec.pose.rotation;
    const qb = item.mocap * 4;
    quat[qb] = q[0];
    quat[qb + 1] = q[1];
    quat[qb + 2] = q[2];
    quat[qb + 3] = q[3];
  }
}

/**
 * An agent move. It replaces the path from the next master step and is
 * held after that. Recorded at the sim time the command arrived.
 */
export function moveTarget(
  s: SessionState,
  id: string,
  position: [number, number, number]
) {
  if (!s.sim || !s.runPlan) return;
  const known = s.runPlan.environment.targets.some(
    (target) => target.id === id
  );
  if (!known || !position.every((n) => Number.isFinite(n))) return;
  const next: WorldVec3 = [position[0], position[1], position[2]];
  s.targetHolds.set(id, next);
  s.recorder?.noteEvent({
    timeMs: simMs(s),
    kind: "move-target",
    id,
    position: next,
  });
}
