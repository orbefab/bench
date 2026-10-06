/**
 * One world run. The host owns the thread, the files, and the clock.
 * Play batches steps with the host's timer so sim time tracks wall time
 * at 1×. `step(n)` is exactly n steps of 1 ms.
 *
 * The live engines are package instances: `AvrBoard`, the compiled MuJoCo
 * world, and `RailCircuit`. The `Engine` face cannot express this world's
 * pin modes, ADC trace, brownout registers, or stamped rail. Those calls
 * stay direct so the millisecond loop does not grow a wrapper.
 */
import {
  boardPinState,
  type Diagnostic,
  type JointLimitKind,
  pastLimitAmount,
  RECORD_FRAME_MS,
  type RecordedFrame,
  type RecordingInfo,
  type RecordingManifest,
  type RecordingPartCatalog,
  type RecordingRead,
  type RunReport,
  type SeamEnergy,
  stepsPerMs,
  type TimelineMarker,
  type TimelineTrack,
  type WorldError,
  type WorldGhostSpec,
  type WorldGhostState,
  type WorldPartMotion,
  type WorldPartState,
  type WorldPinState,
  type WorldSender,
  type WorldState,
  type WorldSupplyState,
  type WorldVec3,
} from "@sfab-bench/contract";
import {
  type CompiledWorld,
  compileWorld,
  type WorldModelCounts,
} from "@sfab-bench/engine-body";
import type { PinMode } from "@sfab-bench/engine-circuit";
import {
  type AdcConversion,
  AvrBoard,
  BROWNOUT_RESET,
  type CpuResetRegs,
  EXTERNAL_RESET,
  FIRMWARE_RELOADED,
  parseIntelHex,
} from "@sfab-bench/engine-mcu";
import {
  type BatteryParams,
  boundOutside,
  splitPortRef,
} from "@sfab-bench/parts";

import { analogRead } from "./analog-pin";
import type { PlanEnv } from "./env";
import { planWorld, type RunBoard, type RunPlan } from "./plan";
import {
  DISPLAY_STALL_DEG_PER_SEC,
  displayMotion,
  type MotorLaw,
  type ResetState,
  runningReset,
  stepReset,
} from "./power";
import { railAttachment } from "./power-path";
import { probeTracks } from "./probe";
import { createRailCircuit, type RailCircuit } from "./rail-circuit";
import { RangerRuntime } from "./ranger";
import { motionRank, RunRecorder, timelineFromRead } from "./record";
import { SeamLedger } from "./seams";
import { blankTrack, type ServoTrack, trackServo } from "./servo";
import {
  applyTorque,
  bindRangers,
  classifyLoads,
  latchServos,
  moveTarget,
  noteMotorSeams,
  placeTargets,
  rearmRangers,
  rearmServos,
  setTarget,
} from "./session/actuators";
import {
  applyInputNets,
  bindInputNets,
  brownoutOf,
  fillBoardPower,
  holdBeforeRun,
  loadBoards,
  postState,
  reloadBoard,
  resetPinLowOf,
  samplePins,
  serialIn,
  snapshotDriveModes,
  stepBoard,
} from "./session/boards";
import {
  fail,
  noteCommand,
  post,
  simMs,
  stepCount,
  stepEndMs,
  thrownMessage,
} from "./session/common";
import {
  type GhostReading,
  ghostPairs,
  ghostPlanEnv,
  ghostRunsSnapshot,
  ghostState,
  ghostWorldText,
  measurePairs,
} from "./session/ghost";
import { type PortReading, portReading } from "./session/ports";
import { bindPower, latchSupplyNodes, stampNodes } from "./session/rails";
import {
  answerRecord,
  foldStep,
  openRecorder,
  record,
  recordStep,
  sample,
  samplePoses,
} from "./session/recorder";
import { solveSupplies } from "./session/solve";
import { createState, type HeldFailure } from "./session/state";
import { bodySceneOf } from "./shafts";
import { targetPosition } from "./targets";
import {
  applyGpioDrives,
  gpioInputNets,
  type PowerFeeds,
  powerFeedsOf,
  powerIslands,
  servoSignalDrives,
  suppliesOnPort,
  supplyPositiveNode,
  wireGraph,
} from "./wiring";

export type SimHost = {
  post(message: FromWorker): void;
  now(): number;
  schedule(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  sha256(bytes: Uint8Array): string;
  versions: { mujoco: string; avr8js: string };
  projectReal(project: string): string | null;
  readInside(root: string, rel: string): Uint8Array | null;
  readerFor(
    root: string,
    worldRel: string
  ): { read(relativeToWorld: string): Uint8Array | null };
  /** File host for `planWorld`. One sim, one store. */
  plan: PlanEnv;
  /**
   * Keep serial text for `drainSerial`. The worker leaves this off, so a
   * live run does not buffer what it already posts.
   */
  keepSerial?: boolean;
};

/**
 * One world, off the API thread. The host starts one of these per open
 * document. Sim time advances only in here: `step(n)` is exactly n
 * milliseconds (n·perMs master steps), and `play` batches milliseconds so
 * sim time tracks wall time at 1×.
 */

const TICK_MS = 16;
const STATE_EVERY_MS = 1000 / 30;
const MAX_STEPS_PER_TICK = 100;
// Lockstep AVR runs about 4x real time, so one step call stays in seconds.
// A longer headless run steps in calls of at most this many.
export const MAX_STEP_N = 60_000;

export type RecordQuery =
  | { op: "info" }
  | {
      op: "read";
      from: number;
      to: number;
      tracks?: string[];
      maxFrames?: number;
    }
  | { op: "frame"; t: number }
  | {
      op: "timeline";
      from: number;
      to: number;
      maxPoints: number;
      tracks?: string[];
    }
  | { op: "config"; boundMs?: number; enabled?: boolean }
  | { op: "adc" };

export type RecordBody =
  | { op: "info"; info: RecordingInfo }
  | { op: "read"; read: RecordingRead }
  | { op: "frame"; id: string; frame: RecordedFrame | null }
  | {
      op: "timeline";
      id: string;
      from: number;
      to: number;
      tracks: TimelineTrack[];
      markers: TimelineMarker[];
      unrecorded?: string[];
    }
  | { op: "ack" }
  | { op: "adc"; trace: AdcTrace }
  | { op: "error"; message: string };

/**
 * Board-node voltages and ADC samples for tests. Not part of a recording.
 * A sample taken while the CPU runs at sim time T is stamped T+1 and used
 * the node latched at T, the end of the previous master step. A board that
 * boots in the same quantum, after the solve, sees that solve instead.
 */
export type AdcNodeStamp = {
  ms: number;
  boards: Record<string, number>;
};

export type AdcSampleStamp = {
  board: string;
  ms: number;
  mux: string;
  ref: string;
  vRef: number;
  voltage: number;
  count: number;
  rSource: number;
};

export type AdcTrace = {
  nodes: AdcNodeStamp[];
  samples: AdcSampleStamp[];
};

/**
 * A conversion seen through `Sim.observe`, at the instant it started: the
 * reader's held sample and its latched reference. `startStep` (the master
 * step in which the board's current CPU ran its first cycle) and `cycle`
 * (that CPU's own count) name the instant exactly; `ms` is the same
 * instant in simulated milliseconds, for display and ordering.
 */
export type ConversionEvent = {
  board: string;
  mux: string;
  ref: string;
  vRef: number;
  /** The board port `vRef` was read on. Null for an internal reference. */
  referencePort: string | null;
  voltage: number;
  count: number;
  startStep: number;
  cycle: number;
  ms: number;
};

/**
 * Listens to a run as it advances. `step` is called at the end of every
 * master step, after that step's rail solve and body step, with the count
 * of master steps since load. `conversion` is called when a board's ADC
 * starts a conversion. A listener reads; it must not change the run.
 */
export type SimObserver = {
  step?(n: number, perMs: number): void;
  conversion?(event: ConversionEvent): void;
};

export type ToWorker =
  | {
      type: "load";
      project: string;
      world: string;
      generation: number;
      /**
       * Test only. Absent is a cold fuse. Not a field of the world file.
       * `"tripped"` opens the Uno fuse before the first solve.
       */
      fuseStart?: "cold" | "tripped";
      /**
       * Test only. Absent, the worker records no ADC trace.
       */
      adcTrace?: boolean;
      /** The snapshot ghost to run beside the world. Absent is none. */
      ghost?: WorldGhostSpec | null;
    }
  /** `ghost` absent keeps the ghost the run has; null turns it off. */
  | { type: "reload"; generation: number; ghost?: WorldGhostSpec | null }
  | { type: "play"; generation: number; by?: WorldSender }
  | { type: "pause"; generation: number; by?: WorldSender }
  | {
      type: "step";
      n: number;
      generation: number;
      pauseBy?: WorldSender;
      /** Echoed on the state this step produces, so the host can match it. */
      request?: number;
    }
  | { type: "setTarget"; partId: string; radians: number; generation: number }
  | {
      type: "moveTarget";
      id: string;
      position: [number, number, number];
      generation: number;
    }
  | { type: "reloadBoard"; board: string; generation: number }
  | {
      type: "serialIn";
      board: string;
      text: string;
      generation: number;
      by?: WorldSender;
    }
  | { type: "fault"; generation: number }
  | {
      type: "record";
      generation: number;
      request: number;
      query: RecordQuery;
    }
  | { type: "stop" };

export type FromWorker =
  | { type: "ready"; generation: number; counts: WorldModelCounts }
  | {
      type: "state";
      generation: number;
      state: WorldState;
      /** Set on the snapshot produced by a `step` that carried `request`. */
      request?: number;
      /**
       * Present on the first state, when an envelope warning lands, and
       * at most once per seam window.
       */
      report?: RunReport;
    }
  | {
      type: "error";
      generation: number;
      errors: WorldError[];
      message?: string;
    }
  | {
      type: "serial";
      generation: number;
      chunks: { board: string; text: string }[];
    }
  | { type: "boardReset"; generation: number; board: string; marker: string }
  | {
      type: "brownoutBoot";
      generation: number;
      board: string;
      regs: CpuResetRegs;
      pins: WorldPinState;
    }
  | { type: "boardFault"; generation: number; board: string; message: string }
  | {
      type: "rx";
      generation: number;
      board: string;
      queued: number;
      accepted: number;
    }
  | {
      type: "record";
      generation: number;
      request: number;
      body: RecordBody;
    };

export type LoadInput = {
  project: string;
  world: string;
  generation?: number;
  fuseStart?: "cold" | "tripped";
  adcTrace?: boolean;
  ghost?: WorldGhostSpec | null;
};

export type LoadResult =
  | { ok: true }
  | { ok: false; errors: WorldError[]; message?: string };

export type SerialChunk = { board: string; text: string };

function failureText(held: HeldFailure): string {
  if (held.message) return held.message;
  const text = held.errors
    .map((error) => error.message)
    .filter((line) => line.length > 0)
    .join("; ");
  return text || "world failed";
}

type Ghost = {
  reading: GhostReading;
  run: ReturnType<typeof createSession> | null;
};

function createSession(host: SimHost) {
  let ghostSpec: WorldGhostSpec | null = null;
  let ghost: Ghost | null = null;
  // Each state this run posts carries the ghost's poses and the joint gap.
  const s = createState({
    ...host,
    post(message) {
      if (message.type !== "state" || !ghost) {
        host.post(message);
        return;
      }
      host.post({
        ...message,
        state: { ...message.state, ghost: ghostState(ghost.reading) },
      });
    },
  });

  function countsOf(compiled: CompiledWorld): WorldModelCounts {
    return {
      nbody: compiled.index.nbody,
      njnt: compiled.index.njnt,
      nu: compiled.index.nu,
      nmesh: compiled.index.nmesh,
      bodyNames: compiled.index.bodyNames,
      jointNames: compiled.index.jointNames,
      actuatorNames: compiled.index.actuatorNames,
      meshNames: compiled.index.meshNames,
      geomNames: compiled.index.geomNames,
    };
  }

  /**
   * One master step. Boards that are already running execute first, so this
   * step's pulses are the command. The rail is solved from that command and
   * the joint velocity. A rail below the chip's assert voltage asserts
   * reset on this step. The motors that chip drives open at the sub-step
   * the rail crosses, so the torque and the current charged are the share
   * of the step before it; the pins are Hi-Z for the recording. After the rail rises
   * above the chip's release voltage the CPU stays in reset for the chip's
   * hold, then the first instruction runs.
   */
  function advanceOne() {
    if (!s.sim) return;
    if (s.throwOnStep) {
      s.throwOnStep = false;
      throw new Error("injected step fault");
    }
    latchSupplyNodes(s);
    snapshotDriveModes(s);
    samplePins(s);
    const already = new Set<string>();
    for (const board of s.boards) {
      const power = s.boardPower.get(board.id);
      if (!power?.supplyId || power.reset.phase !== "run") continue;
      stepBoard(s, board);
      already.add(board.id);
    }
    latchServos(s);
    solveSupplies(s);
    const endMs = stepEndMs(s);
    for (const board of s.boards) {
      const power = s.boardPower.get(board.id);
      if (!power?.supplyId || board.fault) continue;
      const voltage = brownoutOf(s, board.id);
      const stepped = stepReset(
        power.reset,
        voltage,
        endMs,
        {
          assertV: power.assertVoltage,
          releaseV: power.releaseVoltage,
          holdMs: power.holdMs,
        },
        resetPinLowOf(s, board.id)
      );
      const ended = power.reset.cause;
      power.reset = {
        phase: stepped.phase,
        releaseAtMs: stepped.releaseAtMs,
        cause: stepped.cause,
      };
      if (stepped.assertReset) {
        board.holdInReset();
        applyInputNets(s);
        s.pendingNotes.push(
          stepped.cause === "pin"
            ? { kind: "reset", board: board.id, cause: "pin" }
            : { kind: "reset", board: board.id }
        );
        continue;
      }
      if (!stepped.reboot) continue;
      if (!board.reboot(ended === "pin" ? EXTERNAL_RESET : BROWNOUT_RESET))
        continue;
      applyInputNets(s);
      const regs = board.peekRegs();
      const pins = boardPinState(
        board.peekPins(),
        s.specs.find((item) => item.id === board.id)?.pinCount ?? 0
      );
      power.resets += 1;
      s.pendingNotes.push({ kind: "reboot", board: board.id });
      if (regs) {
        post(s, {
          type: "brownoutBoot",
          generation: s.generation,
          board: board.id,
          regs,
          pins,
        });
      }
      rearmServos(s, board.id, board);
      rearmRangers(s, board.id, board);
    }
    latchSupplyNodes(s);
    // A board that rebooted cleared its input levels. Read them again
    // from the solve that just ended, at the node latched from it.
    samplePins(s);
    for (const board of s.boards) {
      if (already.has(board.id)) continue;
      const power = s.boardPower.get(board.id);
      if (!power || power.reset.phase !== "run") continue;
      stepBoard(s, board);
    }
    // A reboot this step may have produced the first pulses. Latch them
    // before the torque, without solving the rail again: the hold ended
    // on a recovered rail.
    latchServos(s);
    applyTorque(s);
    // Targets move after the CPU. A ray cast during this step still sees
    // the pose from the previous master step, the same lag as the ADC latch.
    placeTargets(s);
    s.sim.mj.mj_step(s.sim.model, s.sim.data);
    noteMotorSeams(s);
    classifyLoads(s);
    // The recorder keys on whole milliseconds: a finer step records once,
    // at the step that ends the millisecond, and folds the extremes of the
    // steps before it into the frame's window.
    if (stepCount(s) % s.perMs === 0) recordStep(s);
    else foldStep(s);
    stampNodes(s, stepCount(s) / s.perMs);
    if (s.observers.size > 0) {
      const n = stepCount(s);
      for (const observer of s.observers) observer.step?.(n, s.perMs);
    }
  }

  /** One simulated millisecond: `perMs` master steps. */
  function advanceMs() {
    for (let k = 0; k < s.perMs; k++) advanceOne();
    stepGhost();
  }

  /** The ghost's same millisecond, then the gap at its end. */
  function stepGhost() {
    const run = ghost?.run;
    if (!ghost || !run || !s.sim) return;
    const inner = run.inner.s;
    try {
      run.inner.advanceMs();
    } catch (err: unknown) {
      dropGhost(`the ghost run stopped: ${thrownMessage(err)}`);
      return;
    }
    if (!inner.sim) return;
    measurePairs(
      ghost.reading.pairs,
      s.sim.data.qpos as Float64Array,
      inner.sim.data.qpos as Float64Array
    );
  }

  function dropGhost(error: string) {
    if (!ghost) return;
    ghost.reading.error = error;
    ghost.run?.dispose();
    ghost.run = null;
  }

  function closeGhost() {
    ghost?.run?.dispose();
    ghost = null;
  }

  /**
   * Build the ghost beside a run that just built. It reads the world file
   * with the spec's level written in, and runs only if that path's
   * behaviour then comes from a snapshot. A ghost that fails leaves the
   * run alone and says why.
   */
  async function buildGhost(root: string) {
    closeGhost();
    const spec = ghostSpec;
    if (!spec || !s.layout) return;
    const reading: GhostReading = { spec, poses: () => null, pairs: [] };
    const held: Ghost = { reading, run: null };
    ghost = held;
    const env = s.host.plan;
    const rel = s.worldRel.trim().replace(/\\/g, "/").replace(/^\/+/, "");
    const worldAbs = env.resolve(root, rel);
    let text: string;
    try {
      text = env.readText(worldAbs);
    } catch {
      reading.error = "the ghost cannot read the world file";
      return;
    }
    const edited = ghostWorldText(text, spec);
    if ("error" in edited) {
      reading.error = `the ghost's level: ${edited.error}`;
      return;
    }
    const run = createSession({
      ...host,
      keepSerial: false,
      plan: ghostPlanEnv(env, worldAbs, edited.text),
      // The ghost's events are not the run's. Its failure is the result.
      post: () => {},
    });
    const loaded = await run.load({
      project: s.project,
      world: s.worldRel,
      generation: 0,
      fuseStart: s.fuseStart,
    });
    // A newer build replaced this ghost while it loaded.
    if (ghost !== held) {
      run.dispose();
      return;
    }
    if (!loaded.ok) {
      run.dispose();
      reading.error = `the ghost did not build: ${failureText(loaded)}`;
      return;
    }
    const runs = ghostRunsSnapshot(run.report(), spec.path);
    const layout = run.inner.s.layout;
    if ("error" in runs || !layout) {
      run.dispose();
      reading.error = "error" in runs ? runs.error : "the ghost has no joints";
      return;
    }
    reading.ref = runs.ref;
    reading.impl = runs.impl;
    reading.pairs = ghostPairs(s.layout.joints, layout.joints);
    reading.poses = () => samplePoses(run.inner.s);
    held.run = run;
  }

  /** Inputs the run takes from outside reach the ghost too. */
  function toGhost(fn: (inner: typeof s) => void) {
    const run = ghost?.run;
    if (!run) return;
    try {
      fn(run.inner.s);
    } catch (err: unknown) {
      dropGhost(`the ghost run stopped: ${thrownMessage(err)}`);
    }
  }

  function dispose() {
    closeGhost();
    s.serialChunks.length = 0;
    s.seams.reset();
    s.playing = false;
    s.throwOnStep = false;
    s.recorder = null;
    s.layout = null;
    s.txSeen.clear();
    s.pendingNotes.length = 0;
    s.boards = [];
    s.loads = [];
    s.controls = [];
    s.shafts = [];
    s.rangers = [];
    s.inputNets = [];
    s.runPlan = null;
    s.boardPower = new Map();
    s.supplySpecs = [];
    s.partFeeds = {};
    s.supplyLive = {};
    s.latchedNode = new Map();
    s.latchedRail = new Map();
    s.adcNodes = [];
    s.adcSamples = [];
    s.startStep = new Map();
    s.rails = new Map();
    s.driveAtStart.clear();
    s.stepPulses.clear();
    s.targetHolds.clear();
    s.specs = [];
    s.files = null;
    s.faulted.clear();
    s.rxSent.clear();
    if (s.timer) {
      s.host.clear(s.timer);
      s.timer = null;
    }
    if (!s.sim) return;
    const going = s.sim;
    s.sim = null;
    try {
      going.data.delete();
    } catch {
      /* already gone */
    }
    try {
      going.model.delete();
    } catch {
      /* already gone */
    }
    try {
      going.vfs.delete();
    } catch {
      /* already gone */
    }
  }

  async function build(): Promise<boolean> {
    s.failure = null;
    dispose();
    const root = s.host.projectReal(s.project);
    if (!root) {
      fail(s, [
        {
          code: "missing-file",
          path: "",
          message: "The project folder is gone. Hint: open the folder again.",
        },
      ]);
      return false;
    }
    const bytes = s.host.readInside(root, s.worldRel);
    if (!bytes) {
      fail(s, [
        {
          code: "missing-file",
          path: "",
          message: `World "${s.worldRel}" does not exist. Hint: the path is relative to the project.`,
        },
      ]);
      return false;
    }
    s.worldSha256 = s.host.sha256(bytes);
    const planned = planWorld(root, s.worldRel, s.host.plan);
    if (!planned.ok) {
      fail(s, planned.errors);
      return false;
    }
    const bytesReader = s.host.readerFor(root, s.worldRel);
    const compiled = await compileWorld(bodySceneOf(planned.plan), bytesReader);
    if (!compiled.ok) {
      fail(s, compiled.errors);
      return false;
    }
    const data = new compiled.mj.MjData(compiled.model);
    compiled.mj.mj_forward(compiled.model, data);
    s.sim = { ...compiled, data };
    s.perMs = stepsPerMs(compiled.model.opt.timestep) ?? 1;
    s.files = bytesReader;
    s.playing = false;
    // Feeds are known before boot: an unwired board does not run.
    s.runPlan = planned.plan;
    s.runReport = planned.plan.report
      ? structuredClone(planned.plan.report)
      : null;
    s.degradedLive = [...(planned.plan.degraded ?? [])];
    s.reportPending = s.runReport !== null;
    s.envelopeWarned.clear();
    s.batteryWarned.clear();
    s.pinLatch.clear();
    fillBoardPower(s, s.runPlan);
    loadBoards(s, s.runPlan);
    bindPower(s, s.runPlan);
    bindInputNets(s, s.runPlan);
    bindRangers(s, s.runPlan);
    // The ranger's idle current is on the node the first CPU step reads.
    solveSupplies(s);
    // A chip that powers up into a sagging rail or a low RESET never runs
    // its first instruction, so the t=0 frame already shows it in reset.
    // The reset event lands on the first recorded step.
    const holds: typeof s.pendingNotes = [];
    for (const board of s.boards) {
      const cause = holdBeforeRun(s, board);
      if (!cause) continue;
      holds.push(
        cause === "pin"
          ? { kind: "reset", board: board.id, cause }
          : { kind: "reset", board: board.id }
      );
    }
    if (holds.length > 0) applyInputNets(s);
    openRecorder(s);
    s.pendingNotes.push(...holds);
    latchSupplyNodes(s);
    samplePins(s);
    await buildGhost(root);
    post(s, {
      type: "ready",
      generation: s.generation,
      counts: countsOf(compiled),
    });
    postState(s);
    return true;
  }

  function stopClock() {
    s.playing = false;
    if (s.timer) {
      s.host.clear(s.timer);
      s.timer = null;
    }
    s.stepDebt = 0;
  }

  function onTick() {
    s.timer = null;
    if (!s.playing || !s.sim) return;
    try {
      const now = s.host.now();
      const elapsed = now - s.lastWall;
      s.lastWall = now;
      s.stepDebt += elapsed;
      let steps = Math.floor(s.stepDebt);
      s.stepDebt -= steps;
      if (steps > MAX_STEPS_PER_TICK) {
        steps = MAX_STEPS_PER_TICK;
        s.stepDebt = 0;
      }
      for (let i = 0; i < steps; i++) advanceMs();
      s.sinceState += elapsed;
      if (s.sinceState >= STATE_EVERY_MS) {
        s.sinceState = 0;
        postState(s);
      }
      if (s.playing) arm();
    } catch (err: unknown) {
      // A MuJoCo throw must not escape the timer: that kills the API process.
      stopClock();
      fail(s, [], thrownMessage(err));
      try {
        postState(s);
      } catch {
        /* the error event is the one the host needs */
      }
    }
  }

  function arm() {
    if (s.timer) return;
    s.timer = s.host.schedule(onTick, TICK_MS);
  }

  function play(by?: WorldSender) {
    if (!s.sim) return;
    noteCommand(s, "play", by);
    s.playing = true;
    s.lastWall = s.host.now();
    s.stepDebt = 0;
    s.sinceState = 0;
    arm();
    postState(s);
  }

  function pause(by?: WorldSender) {
    if (!s.sim) return;
    noteCommand(s, "pause", by);
    stopClock();
    postState(s);
  }

  function step(n: number, pauseBy?: WorldSender, request?: number) {
    s.failure = null;
    if (!s.sim) return;
    try {
      if (!Number.isInteger(n) || n < 0 || n > MAX_STEP_N) {
        fail(
          s,
          [],
          `step(${String(n)}) is not a whole number of milliseconds from 0 to ${MAX_STEP_N}.`
        );
        if (request !== undefined) postState(s, request);
        return;
      }
      // One turn: stop the clock, then advance exactly n milliseconds.
      if (pauseBy) noteCommand(s, "pause", pauseBy);
      stopClock();
      for (let i = 0; i < n; i++) advanceMs();
      postState(s, request);
    } catch (err: unknown) {
      stopClock();
      fail(s, [], thrownMessage(err));
      try {
        postState(s, request);
      } catch {
        /* the error event is already posted */
      }
    }
  }

  function heldResult(): LoadResult {
    const held = s.failure;
    if (!held) return { ok: false, errors: [] };
    return {
      ok: false,
      errors: held.errors,
      ...(held.message !== undefined ? { message: held.message } : {}),
    };
  }

  async function load(input: LoadInput): Promise<LoadResult> {
    s.generation = input.generation ?? s.generation + 1;
    s.project = input.project;
    s.worldRel = input.world;
    s.fuseStart = input.fuseStart === "tripped" ? "tripped" : "cold";
    s.adcTrace = input.adcTrace === true;
    ghostSpec = input.ghost ?? null;
    if (await build()) return { ok: true };
    return heldResult();
  }

  async function reload(): Promise<LoadResult> {
    stopClock();
    if (await build()) return { ok: true };
    return heldResult();
  }

  function close() {
    stopClock();
    dispose();
  }

  function runSteps(n: number): void {
    step(n);
    if (s.failure) throw new Error(failureText(s.failure));
  }

  function drainSerial(): SerialChunk[] {
    const out = s.serialChunks.slice();
    s.serialChunks.length = 0;
    return out;
  }

  function seamRows(): SeamEnergy[] {
    return s.seams.rows();
  }

  async function handle(message: ToWorker) {
    if (message.type === "stop") {
      close();
      return;
    }
    if (message.type === "record") {
      answerRecord(s, message);
      return;
    }
    if (message.generation !== s.generation && message.type !== "load") {
      if (message.generation < s.generation) return;
    }
    if (message.type === "load") {
      await load({
        project: message.project,
        world: message.world,
        generation: message.generation,
        fuseStart: message.fuseStart,
        adcTrace: message.adcTrace,
        ghost: message.ghost,
      });
      return;
    }
    s.generation = message.generation;
    if (message.type === "reload") {
      if (message.ghost !== undefined) ghostSpec = message.ghost;
      await reload();
      return;
    }
    if (message.type === "play") play(message.by);
    else if (message.type === "pause") pause(message.by);
    else if (message.type === "step")
      step(message.n, message.pauseBy, message.request);
    else if (message.type === "setTarget") {
      setTarget(s, message.partId, message.radians);
      toGhost((inner) => setTarget(inner, message.partId, message.radians));
    } else if (message.type === "moveTarget") {
      moveTarget(s, message.id, message.position);
      toGhost((inner) => moveTarget(inner, message.id, message.position));
    } else if (message.type === "reloadBoard") {
      reloadBoard(s, message.board);
      toGhost((inner) => reloadBoard(inner, message.board));
    } else if (message.type === "serialIn") {
      serialIn(s, message.board, message.text, message.by);
      toGhost((inner) => serialIn(inner, message.board, message.text));
    } else if (message.type === "fault") s.throwOnStep = true;
  }

  async function pump() {
    if (s.pumping) return;
    s.pumping = true;
    try {
      while (s.queue.length > 0) {
        const message = s.queue.shift();
        if (!message) break;
        await handle(message);
      }
    } catch (err: unknown) {
      stopClock();
      fail(s, [], thrownMessage(err));
      try {
        postState(s);
      } catch {
        /* already reported */
      }
    } finally {
      s.pumping = false;
    }
    // The message that threw was already shifted off. Keep going so a later
    // step or pause queued behind it is not dropped. A second throw is caught
    // on the next pump.
    if (s.queue.length > 0) void pump();
  }

  function enqueue(message: ToWorker): Promise<void> {
    s.queue.push(message);
    return pump();
  }

  function branchReading(path: string): {
    current: number;
    voltages: number[];
  } | null {
    const seen = new Set<RailCircuit>();
    for (const group of s.rails.values()) {
      if (seen.has(group.circuit)) continue;
      seen.add(group.circuit);
      const amps = group.circuit.elementCurrent(path);
      if (amps === null) continue;
      const nodes = group.circuit.elementNodes(path) ?? [];
      return {
        current: Math.abs(amps),
        voltages: nodes.map((name) => group.circuit.nodeVoltage(name)),
      };
    }
    return null;
  }

  return {
    enqueue,
    load,
    reload,
    step: runSteps,
    state: () => sample(s),
    serialIn: (id: string, text: string, by?: WorldSender) => {
      serialIn(s, id, text, by);
      toGhost((inner) => serialIn(inner, id, text));
    },
    drainSerial,
    seams: seamRows,
    report: () => s.runReport,
    record: (query: RecordQuery) => record(s, query),
    setTarget: (partId: string, radians: number) => {
      setTarget(s, partId, radians);
      toGhost((inner) => setTarget(inner, partId, radians));
    },
    play,
    pause,
    dispose: close,
    branchReading,
    portReading: (path: string, port: string) => portReading(s, path, port),
    observe(observer: SimObserver): () => void {
      s.observers.add(observer);
      return () => {
        s.observers.delete(observer);
      };
    },
    /** The ghost's last frame, or null when there is no ghost. */
    ghost: () => (ghost ? ghostState(ghost.reading) : null),
    /** For a ghost run inside this module only. */
    inner: { s, advanceMs },
  };
}

export class Sim {
  private readonly session: ReturnType<typeof createSession>;
  constructor(host: SimHost) {
    this.session = createSession(host);
  }
  /** Queue one host message and wait until it has been handled. */
  accept(message: ToWorker): Promise<void> {
    return this.session.enqueue(message);
  }
  load(input: LoadInput): Promise<LoadResult> {
    return this.session.load(input);
  }
  /** Stop the clock and build the world already loaded. */
  reload(): Promise<LoadResult> {
    return this.session.reload();
  }
  /** Advance exactly `n` simulated milliseconds (`n·perMs` master steps), then resolve. */
  async step(n: number): Promise<void> {
    this.session.step(n);
  }
  state(): WorldState | null {
    return this.session.state();
  }
  serialIn(board: string, text: string, by?: WorldSender): void {
    this.session.serialIn(board, text, by);
  }
  drainSerial(): SerialChunk[] {
    return this.session.drainSerial();
  }
  /** Ledger rows through the last step, including an open window. */
  seams(): SeamEnergy[] {
    return this.session.seams();
  }
  /** The report from the last load, including stale-capture warnings. */
  report(): RunReport | null {
    return this.session.report();
  }
  record(query: RecordQuery): RecordBody {
    return this.session.record(query);
  }
  setTarget(partId: string, radians: number): void {
    this.session.setTarget(partId, radians);
  }
  play(by?: WorldSender): void {
    this.session.play(by);
  }
  pause(by?: WorldSender): void {
    this.session.pause(by);
  }
  dispose(): void {
    this.session.dispose();
  }
  /**
   * The instance at `path` read at its own port after the last solve:
   * volts and amperes on a rail, the driven joint's angle on a port on a
   * rotational net. Null when neither reads.
   */
  portReading(path: string, port: string): PortReading | null {
    return this.session.portReading(path, port);
  }
  /**
   * Call `observer` at every master step and conversion until the
   * returned function is called. Listeners outlive a reload.
   */
  observe(observer: SimObserver): () => void {
    return this.session.observe(observer);
  }
  /** The snapshot ghost's frame. Null when the run has none. */
  ghost(): WorldGhostState | null {
    return this.session.ghost();
  }
  /**
   * Branch current and node voltages for a part stamped on a rail.
   * Null when the part was not kept. The live frame does not carry this.
   */
  branchReading(path: string): {
    current: number;
    voltages: number[];
  } | null {
    return this.session.branchReading(path);
  }
}
