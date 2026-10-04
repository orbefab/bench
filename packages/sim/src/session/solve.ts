/** Solve: one rail per step from the pulses and the joint speed, the supply states, and the supply and envelope warnings. */

import type { WorldSupplyState } from "@sfab-bench/contract";
import type { PinMode } from "@sfab-bench/engine-circuit";
import { boundOutside } from "@sfab-bench/parts";
import type { MotorTrip, RailCircuit } from "../rail-circuit";
import { sampleLoad } from "./actuators";
import { stepS } from "./common";
import { boardsFed, drivenBoard, loadBoard } from "./rails";
import { driversTripped, prepareShafts, readShafts } from "./shafts";
import type { Load, SessionState } from "./state";

/** One warning per path and ref when an observed bound is outside. */
function noteSnapshotEnvelope(s: SessionState, supplyId: string): void {
  const group = s.rails.get(supplyId);
  if (!group) return;
  const supply = s.runPlan?.supplies.find((item) => item.id === supplyId);
  const parts = [
    ...boardsFed(s, supplyId).flatMap((item) => item.stamp?.parts ?? []),
    ...(supply?.stamp?.parts ?? []),
  ];
  for (const part of parts) {
    if (!part.table) continue;
    const reading = group.circuit.tableReading(part.path);
    if (!reading) continue;
    const port = part.table.law.across[0];
    warnEnvelope(s, part.path, part.table.ref, part.table.envelope, {
      [`${port}.current`]: reading.amps,
      [`${port}.voltage`]: reading.volts,
    });
  }
}

/** One warning when a battery first reads empty. The run keeps going. */
function noteBattery(s: SessionState, supplyId: string): void {
  if (s.batteryWarned.has(supplyId)) return;
  const group = s.rails.get(supplyId);
  const detail = group?.circuit.batteryWarning();
  if (!detail || !group?.circuit.batteryOf(supplyId)) return;
  s.batteryWarned.add(supplyId);
  if (!s.runReport) return;
  s.runReport.warnings.push({
    severity: "warning",
    code: "battery",
    path: supplyId,
    port: "+",
    quantity: "Voltage",
    left: String(group.circuit.sourceVoltage(supplyId)),
    right: "ocv(0)",
    message: `${supplyId} ${detail}`,
  });
  s.reportPending = true;
}

export function warnEnvelope(
  s: SessionState,
  path: string,
  ref: string,
  envelope: {
    bounds: Record<string, [number, number]>;
    current: [number, number];
  },
  observed: Readonly<Record<string, number>>
): void {
  const key = `${path}|${ref}`;
  if (s.envelopeWarned.has(key)) return;
  const hit = boundOutside(envelope, observed);
  if (!hit) return;
  s.envelopeWarned.add(key);
  const named = boundName(hit.key);
  const message =
    `${path} port ${named.port} quantity ${named.quantity}: ` +
    `snapshot ${ref} envelope exceeded; run continues ` +
    `(${hit.value} vs ${hit.range[0]}..${hit.range[1]})`;
  if (!s.runReport) return;
  s.runReport.warnings.push({
    severity: "warning",
    code: "envelope",
    path,
    port: named.port,
    quantity: named.quantity,
    left: `${hit.value}`,
    right: `${hit.range[0]}..${hit.range[1]}`,
    message,
  });
  const row = s.runReport.snapshots.find(
    (item) => item.path === path && item.ref === ref
  );
  if (row) row.envelope = [...(row.envelope ?? []), message];
  s.reportPending = true;
}

function boundName(key: string): { port: string; quantity: string } {
  const dot = key.lastIndexOf(".");
  const port = dot > 0 ? key.slice(0, dot) : key;
  const field = dot > 0 ? key.slice(dot + 1) : key;
  const quantity =
    field === "voltage"
      ? "Voltage"
      : field === "current" || field === "currentLimit"
        ? "Current"
        : field === "resistance"
          ? "Resistance"
          : field === "torque"
            ? "Torque"
            : field === "speed"
              ? "AngularVelocity"
              : field === "angle"
                ? "Angle"
                : field;
  return { port, quantity };
}

/**
 * Intervals between edges of every stamped pin on one rail, inside this
 * master step, merged onto one timeline. A single level change charges the
 * rail for the part of the step after the edge. A pulse has both
 * edges, and those intervals are the duty. A board that does not toggle
 * contributes its held mode to each piece.
 */
function pinPiecesUnion(
  s: SessionState,
  specs: readonly { id: string }[],
  circuit: RailCircuit
):
  | { dt: number; drive: { bit: number; mode: PinMode; boardId: string }[] }[]
  | null {
  type Edge = { boardId: string; bit: number; when: number; high: boolean };
  const step = stepS(s);
  const edges: Edge[] = [];
  const modes = new Map<string, Map<number, PinMode>>();
  const bitsOf = new Map<string, readonly number[]>();
  for (const spec of specs) {
    const avr = s.boards.find((item) => item.id === spec.id);
    const bits = circuit.driveBitsOf(spec.id);
    const start = s.driveAtStart.get(spec.id);
    if (!avr || !start || bits.length === 0) continue;
    bitsOf.set(spec.id, bits);
    modes.set(spec.id, new Map(start));
    const wanted = new Set(bits);
    const span = avr.cycles() - avr.stepOrigin;
    if (!(span > 0)) continue;
    for (const edge of avr.pinChanges) {
      if (!wanted.has(edge.bit) || edge.cycle < avr.stepOrigin) continue;
      edges.push({
        boardId: spec.id,
        bit: edge.bit,
        when: ((edge.cycle - avr.stepOrigin) / span) * step,
        high: edge.high,
      });
    }
  }
  if (edges.length === 0) return null;
  edges.sort((a, b) =>
    a.when < b.when
      ? -1
      : a.when > b.when
        ? 1
        : a.boardId < b.boardId
          ? -1
          : a.boardId > b.boardId
            ? 1
            : a.bit - b.bit
  );
  const pieces: {
    dt: number;
    drive: { bit: number; mode: PinMode; boardId: string }[];
  }[] = [];
  let t = 0;
  let changed = false;
  const driveOf = () => {
    const drive: { bit: number; mode: PinMode; boardId: string }[] = [];
    for (const spec of specs) {
      const bits = bitsOf.get(spec.id);
      const mode = modes.get(spec.id);
      if (!bits || !mode) continue;
      for (const bit of bits) {
        drive.push({
          boardId: spec.id,
          bit,
          mode: mode.get(bit) ?? "input",
        });
      }
    }
    return drive;
  };
  for (const edge of edges) {
    const dt = edge.when - t;
    if (dt > 1e-12) pieces.push({ dt, drive: driveOf() });
    const mode = modes.get(edge.boardId);
    const prev = mode?.get(edge.bit);
    if (mode && (prev === "high" || prev === "low")) {
      const next: PinMode = edge.high ? "high" : "low";
      if (next !== prev) {
        mode.set(edge.bit, next);
        changed = true;
      }
    }
    if (edge.when > t) t = edge.when;
  }
  if (!changed) return null;
  const rest = step - t;
  if (rest > 1e-12) pieces.push({ dt: rest, drive: driveOf() });
  return pieces.length > 0 ? pieces : null;
}

/**
 * Boards on this circuit that can brown out this step, each with the
 * running motors it drives. A board that is already held, or whose node is
 * on another circuit, arms nothing: the step-end `stepReset` decides it.
 */
function tripsOf(
  s: SessionState,
  circuit: RailCircuit,
  members: readonly Load[]
): MotorTrip[] {
  const trips: MotorTrip[] = [];
  for (const board of s.boards) {
    const power = s.boardPower.get(board.id);
    if (!power?.supplyId || board.fault || power.reset.phase !== "run") {
      continue;
    }
    if (s.rails.get(power.supplyId)?.circuit !== circuit) continue;
    const motors: number[] = [];
    for (let i = 0; i < members.length; i++) {
      const load = members[i];
      if (load?.drive?.board?.id !== board.id) continue;
      if (load.sample && !load.sample.limp) motors.push(i);
    }
    const drivers = driversTripped(s, circuit, board.id);
    if (motors.length > 0 || drivers.length > 0) {
      trips.push({
        boardId: board.id,
        assertV: power.assertVoltage,
        motors,
        ...(drivers.length > 0 ? { drivers } : {}),
      });
    }
  }
  return trips;
}

function solveOneRail(
  s: SessionState,
  supplyId: string,
  fixed: number,
  rangerOnBoard: ReadonlyMap<string, number>
): { voltage: number; current: number; board: number; boardMin: number } {
  const group = s.rails.get(supplyId);
  if (!group) return { voltage: 0, current: 0, board: 0, boardMin: 0 };
  const { circuit, loads: members } = group;
  let pieces: ReturnType<typeof pinPiecesUnion> = null;
  if (circuit.boardIds.length > 1) {
    // Every board on the circuit, not only the ones `supplyId` feeds.
    // Two supplies on one island name different boards.
    const specs = circuit.boardIds.flatMap((id) => {
      const board = s.runPlan?.boards.find((item) => item.id === id);
      return board ? [board] : [];
    });
    // Each draw sits on its own board's node. A part with no board of
    // its own is the rest of `fixed`, and lands on the first board.
    const quiescent = new Map<string, number>(rangerOnBoard);
    for (const load of members) {
      const id = loadBoard(load) ?? specs[0]?.id;
      if (!id) continue;
      quiescent.set(id, (quiescent.get(id) ?? 0) + load.quiescent);
    }
    let accounted = 0;
    for (const spec of specs) {
      const amps =
        (s.boardPower.get(spec.id)?.draw ?? 0) + (quiescent.get(spec.id) ?? 0);
      circuit.setBoardLoad(spec.id, amps);
      accounted += amps;
    }
    const rest = fixed - accounted;
    const first = specs[0];
    if (first && rest !== 0) {
      const base =
        (s.boardPower.get(first.id)?.draw ?? 0) +
        (quiescent.get(first.id) ?? 0);
      circuit.setBoardLoad(first.id, base + rest);
    }
    pieces = pinPiecesUnion(s, specs, circuit);
    if (!pieces) {
      for (const spec of specs) {
        const avr = s.boards.find((item) => item.id === spec.id);
        if (!avr) continue;
        for (const bit of circuit.driveBitsOf(spec.id)) {
          circuit.setBoardDrive(spec.id, bit, avr.driveMode(bit));
        }
      }
    }
  } else {
    circuit.setFixed(fixed);
    const avr = drivenBoard(s, supplyId);
    pieces = avr ? pinPiecesUnion(s, [avr], circuit) : null;
    if (avr && !pieces) {
      // DDR set and PORT set is high, DDR set and PORT clear is low,
      // PORT set alone is the pull-up, and neither is an input.
      // High is the board node. peekPins mixes PIN into the level, so
      // the mode is read from DDR and PORT.
      for (const bit of circuit.driveBits) {
        circuit.setDrive(bit, avr.driveMode(bit));
      }
    }
  }
  for (let i = 0; i < members.length; i++) {
    const load = members[i];
    const sample = load?.sample ?? null;
    const on = sample !== null && !sample.limp;
    circuit.setMotor(
      i,
      on && sample ? sample.fraction : 0,
      on && sample ? sample.omega : 0,
      on
    );
  }
  circuit.armTrips(tripsOf(s, circuit, members));
  circuit.solve(pieces ?? undefined);
  noteSnapshotEnvelope(s, supplyId);
  for (const [id, other] of s.rails) {
    if (other.circuit === circuit) noteBattery(s, id);
  }
  const winding = circuit.winding;
  for (let i = 0; i < members.length; i++) {
    const load = members[i];
    if (load) load.winding = winding[i] ?? 0;
  }
  group.boardMin = circuit.boardMinVoltage;
  return {
    voltage: circuit.voltage,
    current: circuit.current,
    board: circuit.boardVoltage,
    boardMin: circuit.boardMinVoltage,
  };
}

/**
 * Rail for this step, from the latched command and the joint velocity.
 * A powered servo always contributes its quiescent current. A driven
 * one also contributes `max(0, s·I_motor)`.
 */
export function solveSupplies(s: SessionState) {
  for (const load of s.loads) sampleLoad(s, load);
  prepareShafts(s);
  const rangerFixed = new Map<string, number>();
  const rangerOnBoard = new Map<string, number>();
  for (const ranger of s.rangers) {
    const draw = ranger.takeDraw();
    if (!ranger.supplyId) continue;
    rangerFixed.set(
      ranger.supplyId,
      (rangerFixed.get(ranger.supplyId) ?? 0) + draw
    );
    if (ranger.powerBoard) {
      rangerOnBoard.set(
        ranger.powerBoard,
        (rangerOnBoard.get(ranger.powerBoard) ?? 0) + draw
      );
    }
  }
  const next: Record<string, WorldSupplyState> = {};
  const solved = new Set<RailCircuit>();
  for (const supply of s.supplySpecs) {
    const group = s.rails.get(supply.id);
    const circuit = group?.circuit;
    if (circuit && solved.has(circuit)) continue;
    if (circuit) solved.add(circuit);
    const onThis = (id: string | null) => {
      if (!id) return false;
      if (!circuit) return id === supply.id;
      return s.rails.get(id)?.circuit === circuit;
    };
    let fixed = 0;
    for (const power of s.boardPower.values()) {
      if (!onThis(power.supplyId)) continue;
      fixed += power.draw;
    }
    for (const load of s.loads) {
      if (!onThis(load.supplyId)) continue;
      fixed += load.quiescent;
    }
    for (const [id, draw] of rangerFixed) {
      if (onThis(id)) fixed += draw;
    }
    solveOneRail(s, supply.id, fixed, rangerOnBoard);
  }
  readShafts(s);
  for (const supply of s.supplySpecs) {
    const circuit = s.rails.get(supply.id)?.circuit;
    // The supply record is the terminal. The board node is reported on
    // the board, and a servo's V+ is that same node. A battery also
    // records the state of charge after this step.
    const soc = circuit?.batteryOf(supply.id) ? circuit.soc : undefined;
    const voltage = circuit?.sourceVoltage(supply.id) ?? 0;
    const current = circuit?.sourceCurrent(supply.id) ?? 0;
    next[supply.id] =
      soc === undefined ? { voltage, current } : { voltage, current, soc };
  }
  for (const load of s.loads) {
    const drive = load.drive;
    const sample = load.sample;
    if (!load.supplyId || !drive || !sample) {
      load.current = 0;
      continue;
    }
    if (sample.limp) {
      load.current = load.quiescent;
      continue;
    }
    load.current =
      drive.law.quiescent + Math.max(0, sample.fraction * load.winding);
  }
  s.supplyLive = next;
}
