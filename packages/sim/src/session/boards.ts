/** Boards: boot, load, reload, flush, fault, serial, the ADC attachment, brownout, and one CPU step. */

import {
  onboardLedPath,
  type ResetCause,
  type WorldSender,
} from "@sfab-bench/contract";
import type { PinMode } from "@sfab-bench/engine-circuit";
import {
  type AdcConversion,
  AvrBoard,
  chipSpec,
  FIRMWARE_RELOADED,
  parseIntelHex,
} from "@sfab-bench/engine-mcu";
import { logicLevel, logicThresholds } from "@sfab-bench/parts";
import { analogRead } from "../analog-pin";
import type { RunPlan } from "../plan";
import { runningReset } from "../power";
import type { ConversionEvent } from "../sim";
import { applyGpioDrives, gpioInputNets, powerFeedsOf } from "../wiring";
import { rearmRangers, rearmServos } from "./actuators";
import { post, simMs, stepCount, stepEndMs, thrownMessage } from "./common";
import {
  boardMinVolts,
  boardVolts,
  latchedBoardNode,
  noteDegraded,
  stampNodes,
} from "./rails";
import { sample } from "./recorder";
import { solveSupplies } from "./solve";
import type { BoardSpec, SessionState } from "./state";

export function boardInSoa(s: SessionState, board: AvrBoard): boolean {
  if (!board.running || board.inReset || board.fault) return false;
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
    // The recording noted this text at the end of each step.
    const text = board.takeTx();
    s.txSeen.set(board.id, 0);
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
    clock: board.clock,
    wire: board.wire,
    pinCount: board.pinOrder.length,
  }));
}

function bootBoard(s: SessionState, spec: BoardSpec): AvrBoard {
  const chip = chipSpec(spec.chip);
  const board = new AvrBoard(spec.id, chip, spec.wire);
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
  // Named once, after a successful load. A missing image or a dead supply
  // returns above and does not announce a gap the run never reached.
  if (board.running) {
    for (const gap of chip.gaps ?? []) {
      noteDegraded(s, spec.id, gap.code, gap.message);
    }
  }
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
      releaseVoltage: board.brownoutReleaseVoltage,
      holdMs: board.resetHoldMs,
      resets: 0,
      reset: runningReset(),
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
  // A pin with a circuit on its net reads the solved node (`samplePins`).
  s.inputNets = gpioInputNets(plan).filter(
    (net) => !stampedBitsOf(s, net.boardId).includes(net.bit)
  );
  const refresh = () => applyInputNets(s);
  for (const board of s.boards) {
    board.onPinsChanged = s.inputNets.length > 0 ? refresh : null;
  }
  applyInputNets(s);
}

function circuitOf(s: SessionState, boardId: string) {
  const supplyId = s.boardPower.get(boardId)?.supplyId;
  return supplyId ? s.rails.get(supplyId)?.circuit : undefined;
}

function stampedBitsOf(s: SessionState, boardId: string): readonly number[] {
  return circuitOf(s, boardId)?.driveBitsOf(boardId) ?? [];
}

/**
 * Each stamped GPIO input reads its solved node against the port's
 * thresholds, resolved at the latched board node. Called before the CPUs,
 * so the read is the previous solve: the ADC's one-step lag. Between VIL
 * and VIH the last level holds. A pin with no circuit keeps the wire walk.
 */
export function samplePins(s: SessionState) {
  if (!s.runPlan) return;
  for (const board of s.boards) {
    const spec = s.runPlan.boards.find((item) => item.id === board.id);
    const circuit = circuitOf(s, board.id);
    if (!spec || !circuit) continue;
    const vcc = s.latchedNode.get(board.id) ?? 0;
    let latch = s.pinLatch.get(board.id);
    if (!latch) {
      latch = new Map<number, boolean>();
      s.pinLatch.set(board.id, latch);
    }
    for (const row of circuit.pinVolts(board.id)) {
      const logic = spec.pins[row.port]?.logic;
      if (!logic) continue;
      const level = logicLevel(
        row.volts,
        logicThresholds(logic, vcc),
        latch.get(row.bit) ?? false
      );
      latch.set(row.bit, level);
      board.setDriven(row.bit, level);
    }
  }
}

/** Onboard LED current. Present when this rail stamped `onboardLedPath(board)`. */
export function ledCurrentOf(
  s: SessionState,
  boardId: string
): number | undefined {
  const supplyId = s.boardPower.get(boardId)?.supplyId;
  if (!supplyId) return undefined;
  const group = s.rails.get(supplyId);
  if (!group) return undefined;
  const key = onboardLedPath(boardId);
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
      : { ledCurrent: card.leds[onboardLedPath(boardId)] ?? 0 }),
  };
}

export function snapshotDriveModes(s: SessionState): void {
  s.driveAtStart.clear();
  for (const board of s.boards) {
    board.modeChanges = [];
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
  // threshold, or a low RESET, holds the new CPU in reset. A firmware
  // reload is not a brown-out delay: once both are up, the image runs.
  // A held reload is still a reload, and is recorded as one.
  solveSupplies(s);
  const held = holdBeforeRun(s, next);
  if (held) applyInputNets(s);
  s.rxSent.delete(id);
  s.faulted.delete(id);
  if (s.runPlan) bindInputNets(s, s.runPlan);
  const recorded = s.recorder?.manifest.boards.find((item) => item.id === id);
  if (recorded) recorded.sha256 = s.firmwareSha.get(id) ?? recorded.sha256;
  if (next.running || held) {
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
  stampNodes(s, stepCount(s) / s.perMs);
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
    ms: stepEndMs(s),
    mux: sample.mux,
    ref: sample.ref,
    vRef: sample.vRef,
    voltage: sample.voltage,
    count: sample.count,
    rSource: sample.rSource,
  });
}

/**
 * A conversion for `Sim.observe`, at the instant it started. The AVCC
 * reference is the latched board node (`attachAnalog`), which is the
 * board's power port; no other reference is on a port of the board.
 */
function noteConversion(
  s: SessionState,
  board: AvrBoard,
  sample: AdcConversion
) {
  const startStep = s.startStep.get(board.id) ?? 0;
  const spec = s.runPlan?.boards.find((item) => item.id === board.id);
  const event: ConversionEvent = {
    board: board.id,
    mux: sample.mux,
    ref: sample.ref,
    vRef: sample.vRef,
    referencePort: sample.ref === "avcc" && spec ? spec.voltagePin : null,
    voltage: sample.voltage,
    count: sample.count,
    startStep,
    cycle: sample.cycle,
    ms: startStep / s.perMs + (sample.cycle * 1000) / board.hz,
  };
  for (const observer of s.observers) observer.conversion?.(event);
}

/**
 * AVCC is the latched board node. AREF is 0: the shipped boards have no
 * AREF port, and the pin circuit is omitted. A planned board names each
 * channel from its expose. A hand-built plan keeps `A` plus the index.
 * Either way the channel's chip pin is the chip's ADC table entry.
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
      const labels = spec.adcLabels;
      const port = labels?.[channel];
      // No label: the channel is not on this board. A missing map is the
      // old A-index path, not an unexposed channel.
      if (labels && port === undefined) {
        return { voltage: 0, rSource: 0, mux: `adc${channel}` };
      }
      const chipPin = board.chip?.adcPins[channel];
      const bit = chipPin ? spec.wire.indexOf(chipPin) : -1;
      const mode = bit < 0 ? "analog" : board.driveMode(bit);
      const read = analogRead({
        plan,
        boardId: board.id,
        channel,
        ...(port ? { port } : {}),
        mode,
        pin: spec.pin,
        boardVolts: (boardId: string) => latchedBoardNode(s, boardId),
        supplyVolts: (supplyId) => s.supplyLive[supplyId]?.voltage ?? 0,
        stamped: (ch) => {
          const supplyId = s.boardPower.get(board.id)?.supplyId;
          const circuit = supplyId ? s.rails.get(supplyId)?.circuit : undefined;
          return circuit?.probePort(port ?? `A${ch}`, board.id) ?? null;
        },
      });
      return port ? { ...read, mux: port } : read;
    },
    converted: (sample: AdcConversion) => {
      if (s.adcTrace) noteAdc(s, board.id, sample);
      if (s.observers.size > 0) noteConversion(s, board, sample);
    },
  });
}

/**
 * What `stepReset` sees: the board node at its lowest sub-step.
 * With no Uno cable the board node is the supply terminal.
 */
export function brownoutOf(s: SessionState, boardId: string): number {
  return boardMinVolts(s, boardId);
}

/**
 * Before a fresh image runs: a chip whose rail is under the brownout
 * assert, or whose RESET is low, never fetches its first instruction. Reads
 * the last solve. Returns what holds it, or null when it may run.
 */
export function holdBeforeRun(
  s: SessionState,
  board: AvrBoard
): ResetCause | null {
  const power = s.boardPower.get(board.id);
  if (!power?.supplyId || board.fault || !board.running) return null;
  const cause: ResetCause | null =
    brownoutOf(s, board.id) < power.assertVoltage
      ? "brownout"
      : resetPinLowOf(s, board.id)
        ? "pin"
        : null;
  if (!cause) {
    power.reset = runningReset();
    return null;
  }
  board.holdInReset();
  power.reset = { phase: "held", releaseAtMs: null, cause };
  return cause;
}

/** RESET went below the chip's V_RST at some point of the last solve. */
export function resetPinLowOf(s: SessionState, boardId: string): boolean {
  const supplyId = s.boardPower.get(boardId)?.supplyId;
  if (!supplyId) return false;
  const margin = s.rails
    .get(supplyId)
    ?.circuit.boardReading(boardId).resetMargin;
  return margin != null && margin < 0;
}

export function stepBoard(s: SessionState, board: AvrBoard) {
  if (!board.running || board.fault) return;
  // A CPU at cycle 0 has not run: this step is where its cycles count from.
  if (board.cycles() === 0) s.startStep.set(board.id, stepCount(s));
  try {
    board.stepPart(s.perMs);
  } catch (err: unknown) {
    board.stop(thrownMessage(err));
  }
  noteFault(s, board);
}
