/** Boards: boot, load, reload, flush, fault, serial, the ADC attachment, brownout, and one CPU step. */

import { arduinoPinBit, type WorldSender } from "@sfab-bench/contract";
import type { PinMode } from "@sfab-bench/engine-circuit";
import {
  type AdcConversion,
  AvrBoard,
  chipSpec,
  FIRMWARE_RELOADED,
  parseIntelHex,
} from "@sfab-bench/engine-mcu";
import { analogRead } from "../analog-pin";
import type { RunPlan } from "../plan";
import { runningBrownout } from "../power";
import { applyGpioDrives, gpioInputNets, powerFeedsOf } from "../wiring";
import { rearmRangers, rearmServos } from "./actuators";
import { post, simMs, thrownMessage } from "./common";
import {
  boardVolts,
  latchedBoardNode,
  noteDegraded,
  stampNodes,
} from "./rails";
import { sample } from "./recorder";
import { solveSupplies } from "./solve";
import type { BoardSpec, SessionState } from "./state";

export function boardInSoa(s: SessionState, board: AvrBoard): boolean {
  if (!board.running || board.brownout || board.fault) return false;
  const spec = s.specs.find((item) => item.id === board.id);
  if (spec?.minOperatingVoltage == null) return false;
  const power = s.boardPower.get(board.id);
  if (!power?.supplyId) return false;
  const voltage = boardVolts(s, board.id);
  return voltage > power.brownoutVoltage && voltage < spec.minOperatingVoltage;
}

function flushBoards(s: SessionState) {
  const chunks: { board: string; text: string }[] = [];
  for (const board of s.boards) {
    const text = board.takeTx();
    if (text) chunks.push({ board: board.id, text });
    const stamp = `${board.rxQueued}:${board.rxAccepted}`;
    if (s.rxSent.get(board.id) === stamp) continue;
    s.rxSent.set(board.id, stamp);
    post(s, {
      type: "rx",
      generation: s.generation,
      board: board.id,
      queued: board.rxQueued,
      accepted: board.rxAccepted,
    });
  }
  if (chunks.length > 0) {
    if (s.host.keepSerial) s.serialChunks.push(...chunks);
    post(s, { type: "serial", generation: s.generation, chunks });
  }
}

export function postState(s: SessionState, request?: number) {
  flushBoards(s);
  const state = sample(s);
  if (!state) return;
  post(s, {
    type: "state",
    generation: s.generation,
    state,
    ...(request !== undefined ? { request } : {}),
    ...(s.reportPending && s.runReport ? { report: s.runReport } : {}),
  });
  s.reportPending = false;
}

function noteFault(s: SessionState, board: AvrBoard) {
  if (!board.fault || s.faulted.has(board.id)) return;
  s.faulted.add(board.id);
  post(s, {
    type: "boardFault",
    generation: s.generation,
    board: board.id,
    message: board.fault,
  });
  s.recorder?.noteEvent({
    timeMs: simMs(s),
    kind: "fault",
    board: board.id,
    message: board.fault,
  });
}

function boardSpecsOf(plan: RunPlan): BoardSpec[] {
  return plan.boards.map((board) => ({
    id: board.id,
    chip: board.chip,
    firmware: board.firmware,
    minOperatingVoltage: board.minOperatingVoltage,
  }));
}

function bootBoard(s: SessionState, spec: BoardSpec): AvrBoard {
  const chip = chipSpec(spec.chip);
  const board = new AvrBoard(spec.id, chip);
  attachAnalog(s, board);
  // No supply: the CPU never starts. A later step does not boot it either.
  if (!s.boardPower.get(spec.id)?.supplyId) return board;
  if (!chip) {
    board.stop(`unsupported chip "${spec.chip}"`);
    return board;
  }
  const bytes = s.files?.read(spec.firmware);
  if (!bytes) {
    noteDegraded(
      s,
      spec.id,
      "missing-file",
      `firmware "${spec.firmware}" does not exist`
    );
    board.stop(`firmware "${spec.firmware}" does not exist`);
    return board;
  }
  s.firmwareSha.set(spec.id, s.host.sha256(bytes));
  const parsed = parseIntelHex(new TextDecoder().decode(bytes));
  if (!parsed.ok) {
    board.stop(parsed.error);
    return board;
  }
  board.load(parsed.bytes);
  return board;
}

export function loadBoards(s: SessionState, plan: RunPlan) {
  s.firmwareSha.clear();
  s.specs = boardSpecsOf(plan);
  s.boards = s.specs.map((spec) => bootBoard(s, spec));
  s.faulted.clear();
  s.rxSent.clear();
  for (const board of s.boards) noteFault(s, board);
}

/**
 * One power walk per load. `bootBoard` reads this map, so it is filled
 * before the CPUs start and not again when the servos are bound.
 */
export function fillBoardPower(s: SessionState, plan: RunPlan) {
  const feeds = powerFeedsOf(plan);
  s.partFeeds = feeds.parts;
  s.supplySpecs = plan.supplies.map((supply) => ({
    id: supply.id,
    voltage: supply.voltage,
    currentLimit: supply.currentLimit,
    rSeries: supply.rSeries,
    ...(supply.battery ? { battery: supply.battery } : {}),
    ...(supply.ideal ? { ideal: true as const } : {}),
  }));
  s.boardPower = new Map();
  for (const board of plan.boards) {
    const supplyId = feeds.boards[board.id] ?? null;
    s.boardPower.set(board.id, {
      supplyId,
      draw: supplyId ? board.current : 0,
      brownoutVoltage: board.brownoutVoltage,
      assertVoltage: board.brownoutAssertVoltage,
      resets: 0,
      brownout: runningBrownout(),
    });
  }
}

/**
 * Wire each servo signal. An unwired V+ draws nothing.
 */
export function applyInputNets(s: SessionState) {
  if (s.applyingInputs || s.inputNets.length === 0) return;
  s.applyingInputs = true;
  try {
    applyGpioDrives(s.inputNets, s.boards);
  } finally {
    s.applyingInputs = false;
  }
}

export function bindInputNets(s: SessionState, plan: RunPlan) {
  s.inputNets = gpioInputNets(plan);
  const refresh = () => applyInputNets(s);
  for (const board of s.boards) {
    board.onPinsChanged = s.inputNets.length > 0 ? refresh : null;
  }
  applyInputNets(s);
}

/** Onboard LED current. Present when this rail stamped `${board}.led`. */
export function ledCurrentOf(
  s: SessionState,
  boardId: string
): number | undefined {
  const supplyId = s.boardPower.get(boardId)?.supplyId;
  if (!supplyId) return undefined;
  const group = s.rails.get(supplyId);
  if (!group) return undefined;
  const key = `${boardId}.led`;
  if (!group.circuit.ledPaths.includes(key)) return undefined;
  return group.circuit.leds[key] ?? 0;
}

/** Pass current into this board's 5V node. Zero when no regulator feeds it. */
export function regulatorAmps(s: SessionState, boardId: string): number {
  const supplyId = s.boardPower.get(boardId)?.supplyId;
  if (!supplyId) return 0;
  return s.rails.get(supplyId)?.circuit.regulatorOut(boardId) ?? 0;
}

export function ledReading(
  s: SessionState,
  boardId: string
): {
  ledCurrent?: number;
  leds?: Record<string, number>;
} {
  const supplyId = s.boardPower.get(boardId)?.supplyId;
  if (!supplyId) return {};
  const group = s.rails.get(supplyId);
  if (!group || group.circuit.ledPaths.length === 0) return {};
  const card = group.circuit.ledCardReading();
  const current = ledCurrentOf(s, boardId);
  return {
    leds: card.leds,
    ...(current === undefined
      ? {}
      : { ledCurrent: card.leds[`${boardId}.led`] ?? 0 }),
  };
}

export function snapshotDriveModes(s: SessionState): void {
  s.driveAtStart.clear();
  for (const board of s.boards) {
    board.pinChanges = [];
    const supplyId = s.boardPower.get(board.id)?.supplyId;
    const circuit = supplyId ? s.rails.get(supplyId)?.circuit : undefined;
    if (!circuit || circuit.driveBits.length === 0) continue;
    const modes = new Map<number, PinMode>();
    for (const bit of circuit.driveBits) modes.set(bit, board.driveMode(bit));
    s.driveAtStart.set(board.id, modes);
  }
}

export function reloadBoard(s: SessionState, id: string) {
  const spec = s.specs.find((item) => item.id === id);
  if (!spec) {
    post(s, {
      type: "boardFault",
      generation: s.generation,
      board: id,
      message: `no board "${id}"`,
    });
    return;
  }
  const next = bootBoard(s, spec);
  const index = s.boards.findIndex((item) => item.id === id);
  if (index >= 0) s.boards[index] = next;
  else s.boards.push(next);
  rearmServos(s, id, next);
  rearmRangers(s, id, next);
  // The new image has not run, and this board's servos are idle. Publish
  // the rail those currents actually draw. A sag still under the assert
  // threshold holds the new CPU in reset. A firmware reload is not a
  // brown-out delay: once the rail is up, the image runs.
  solveSupplies(s);
  const power = s.boardPower.get(id);
  if (power?.supplyId && !next.fault) {
    const voltage = brownoutOf(s, id);
    if (voltage < power.assertVoltage) {
      next.holdInReset();
      power.brownout = { phase: "held", releaseAtMs: null };
      applyInputNets(s);
    } else {
      power.brownout = runningBrownout();
    }
  }
  s.rxSent.delete(id);
  s.faulted.delete(id);
  if (s.runPlan) bindInputNets(s, s.runPlan);
  const recorded = s.recorder?.manifest.boards.find((item) => item.id === id);
  if (recorded) recorded.sha256 = s.firmwareSha.get(id) ?? recorded.sha256;
  if (next.running) {
    const ms = simMs(s);
    s.recorder?.noteEvent({ timeMs: ms, kind: "reload", board: id });
    s.recorder?.noteSerial(id, FIRMWARE_RELOADED, ms);
    s.txSeen.set(id, 0);
    post(s, {
      type: "boardReset",
      generation: s.generation,
      board: id,
      marker: FIRMWARE_RELOADED,
    });
  } else {
    noteFault(s, next);
  }
  // The reload solved the rail without advancing time. The next CPU step
  // reads this node as the previous step.
  stampNodes(s, simMs(s));
  postState(s);
}

export function serialIn(
  s: SessionState,
  id: string,
  text: string,
  by?: WorldSender
) {
  const board = s.boards.find((item) => item.id === id);
  if (!board?.running) return;
  if (!board.pushRx(text)) {
    s.rxSent.set(id, `${board.rxQueued}:${board.rxAccepted}`);
    post(s, {
      type: "rx",
      generation: s.generation,
      board: id,
      queued: board.rxQueued,
      accepted: board.rxAccepted,
    });
    return;
  }
  if (by) {
    s.recorder?.noteEvent({
      timeMs: simMs(s),
      kind: "serial-send",
      board: id,
      text,
      by,
    });
  }
  s.rxSent.set(id, `${board.rxQueued}:${board.rxAccepted}`);
  post(s, {
    type: "rx",
    generation: s.generation,
    board: id,
    queued: board.rxQueued,
    accepted: board.rxAccepted,
  });
}

function noteAdc(s: SessionState, boardId: string, sample: AdcConversion) {
  s.adcSamples.push({
    board: boardId,
    ms: simMs(s) + 1,
    mux: sample.mux,
    ref: sample.ref,
    vRef: sample.vRef,
    voltage: sample.voltage,
    count: sample.count,
    rSource: sample.rSource,
  });
}

/**
 * AVCC is the latched board node. AREF is 0: the shipped boards have no
 * AREF port, and the pin circuit is omitted. Channels 0–7 read their net.
 */
function attachAnalog(s: SessionState, board: AvrBoard) {
  const spec = s.runPlan?.boards.find((item) => item.id === board.id);
  if (!spec) return;
  board.setAnalog({
    supply: () => latchedBoardNode(s, board.id),
    aref: () => 0,
    channel: (channel) => {
      const plan = s.runPlan;
      if (!plan) return { voltage: 0, rSource: spec.pin.rLeak };
      const bit = channel < 6 ? arduinoPinBit(`A${channel}`) : undefined;
      const mode = bit === undefined ? "analog" : board.driveMode(bit);
      return analogRead({
        plan,
        boardId: board.id,
        channel,
        mode,
        pin: spec.pin,
        boardVolts: (boardId: string) => latchedBoardNode(s, boardId),
        supplyVolts: (supplyId) => s.supplyLive[supplyId]?.voltage ?? 0,
        stamped: (ch) => {
          const supplyId = s.boardPower.get(board.id)?.supplyId;
          const circuit = supplyId ? s.rails.get(supplyId)?.circuit : undefined;
          return circuit?.probePort(`A${ch}`, board.id) ?? null;
        },
      });
    },
    ...(s.adcTrace
      ? { converted: (sample: AdcConversion) => noteAdc(s, board.id, sample) }
      : {}),
  });
}

/**
 * What `stepBrownout` sees: the board node at its lowest sub-step.
 * With no Uno cable the board node is the supply terminal.
 */
export function brownoutOf(s: SessionState, boardId: string): number {
  const supplyId = s.boardPower.get(boardId)?.supplyId;
  if (!supplyId) return 0;
  return s.rails.get(supplyId)?.circuit.boardReading(boardId).min ?? 0;
}

export function stepBoard(s: SessionState, board: AvrBoard) {
  if (!board.running || board.fault) return;
  try {
    board.stepMillis();
  } catch (err: unknown) {
    board.stop(thrownMessage(err));
  }
  noteFault(s, board);
}
