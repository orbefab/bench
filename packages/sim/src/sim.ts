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
  ATMEGA328P_16MHZ_MIN_V,
  arduinoPinBit,
  atmega328pSoaWarning,
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
  type TimelineMarker,
  type TimelineTrack,
  type WorldError,
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
  type CpuResetRegs,
  FIRMWARE_RELOADED,
  parseIntelHex,
} from "@sfab-bench/engine-mcu";
import { type BatteryParams, boundOutside } from "@sfab-bench/parts";

import { analogRead } from "./analog-pin";
import type { PlanEnv } from "./env";
import { planWorld, type RunBoard, type RunPlan } from "./plan";
import {
  type BrownoutState,
  DISPLAY_STALL_DEG_PER_SEC,
  displayMotion,
  type MotorLaw,
  runningBrownout,
  stepBrownout,
} from "./power";
import { type BoardPathName, chipFacts, railAttachment } from "./power-path";
import { createRailCircuit, type RailCircuit } from "./rail-circuit";
import { RangerRuntime } from "./ranger";
import { motionRank, RunRecorder, timelineFromRead } from "./record";
import { SEAM_STEP_S, SeamLedger } from "./seams";
import { blankTrack, type ServoTrack, trackServo } from "./servo";
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
} from "./wiring";

export type SimHost = {
  post(message: FromWorker): void;
  now(): number;
  schedule(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  ledTrace: boolean;
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

const INTEGRATORS = [
  "euler",
  "rk4",
  "implicit",
  "implicitfast",
  "discrete",
] as const;

/**
 * One world, off the API thread. The host starts one of these per open
 * document. Sim time advances only in here: `step(n)` is exactly n steps
 * of 1 ms, and `play` batches steps so sim time tracks wall time at 1×.
 */

const TICK_MS = 16;
const STATE_EVERY_MS = 1000 / 30;
const MAX_STEPS_PER_TICK = 100;
// Lockstep AVR runs about 4x real time, so one step call stays in seconds.
const MAX_STEP_N = 60_000;

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
  | { op: "timeline"; from: number; to: number; maxPoints: number }
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
 * Test-only window. The self-check runs 3 s, so 4 s covers every node it
 * reads. Older rows drop with one slice, not a shift of the whole array.
 */
const ADC_TRACE_MS = 4_000;

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
    }
  | { type: "reload"; generation: number }
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

type LiveWorld = CompiledWorld & {
  data: InstanceType<CompiledWorld["mj"]["MjData"]>;
};

type WorldBytes = { read(relativeToWorld: string): Uint8Array | null };

export type LoadInput = {
  project: string;
  world: string;
  generation?: number;
  fuseStart?: "cold" | "tripped";
  adcTrace?: boolean;
};

export type LoadResult =
  | { ok: true }
  | { ok: false; errors: WorldError[]; message?: string };

export type SerialChunk = { board: string; text: string };

type HeldFailure = { errors: WorldError[]; message?: string };

function failureText(held: HeldFailure): string {
  if (held.message) return held.message;
  const text = held.errors
    .map((error) => error.message)
    .filter((line) => line.length > 0)
    .join("; ");
  return text || "world failed";
}

function createSession(host: SimHost) {
  type BoardSpec = { id: string; chip: string; firmware: string };

  let generation = 0;
  let project = "";
  let worldRel = "";
  let failure: HeldFailure | null = null;
  const serialChunks: SerialChunk[] = [];
  let sim: LiveWorld | null = null;
  /** Agent moves. A held target ignores its path from the next master step. */
  const targetHolds = new Map<string, WorldVec3>();
  let files: WorldBytes | null = null;
  let specs: BoardSpec[] = [];
  let boards: AvrBoard[] = [];

  type ServoDrive = {
    /**
     * The live CPU, or null when the servo has no signal wire.
     * Replaced when that board's firmware reloads.
     */
    board: AvrBoard | null;
    pinBit: number;
    actuatorId: number;
    /** Joint whose `jnt_actfrcrange` is this servo's torque clamp. */
    jointId: number;
    jointName: string;
    torqueNm: number;
    law: MotorLaw;
    track: ServoTrack;
    /**
     * Degrees from `setTarget`. The command only when there is no signal
     * wire. A pulse owns a wired servo.
     */
    manualDeg: number | null;
  };

  /** Electrical sample the rail and the display state share this step. */
  type ServoSample = {
    limp: boolean;
    saturated: boolean;
    errorRad: number;
    omega: number;
    fraction: number;
  };

  type Load = {
    partId: string;
    supplyId: string | null;
    /** Electronics draw. Zero when V+ is unwired. */
    quiescent: number;
    state: WorldPartMotion;
    /** Amperes this part draws from its supply this step. */
    current: number;
    drive: ServoDrive | null;
    sample: ServoSample | null;
    /** Consecutive milliseconds the stall condition has held. */
    stallMs: number;
    /** Winding current from the circuit, amperes. */
    winding: number;
    /** Slot in the supply's rail circuit. −1 when this part is not on a rail. */
    railSlot: number;
    /** Board whose voltage pin the power wires reach. The signal board is separate. */
    powerBoard: string | null;
  };

  type BoardPower = {
    supplyId: string | null;
    /** Catalog amperes while a supply is connected, including during reset. */
    draw: number;
    /** Nominal BOD level, for the out-of-SOA warning. */
    brownoutVoltage: number;
    assertVoltage: number;
    resets: number;
    brownout: BrownoutState;
  };

  type SupplySpec = {
    id: string;
    voltage: number;
    currentLimit: number;
    rSeries: number;
    /** Set for `battery@1`. The rail stamps this instead of the three numbers. */
    battery?: BatteryParams;
    /** `ideal-voltage@1`. The rail stamps a voltage source. */
    ideal?: boolean;
  };

  let loads: Load[] = [];
  let rangers: RangerRuntime[] = [];
  let boardPower = new Map<string, BoardPower>();
  let supplySpecs: SupplySpec[] = [];
  let partFeeds: PowerFeeds["parts"] = {};
  /**
   * Voltage and current used for the step in progress. Filled from the
   * previous step's part states before the CPUs and the joint move.
   */
  let supplyLive: Record<string, WorldSupplyState> = {};
  /**
   * Board node each CPU sees during its step. Latched before the CPUs run,
   * so the ADC is at most one master step behind the rail. Latched again
   * after the solve, before a board that just left reset executes.
   */
  let latchedNode = new Map<string, number>();
  /** Terminal of a supply that feeds no board. Latched with the board nodes. */
  let latchedTerminal = new Map<string, number>();
  let adcNodes: AdcNodeStamp[] = [];
  let adcSamples: AdcSampleStamp[] = [];
  /** Test only. Absent on load, stamps and samples are not allocated. */
  let adcTrace = false;
  /** Test only. A tripped fuse starts hot, before the first solve. */
  let fuseStart: "cold" | "tripped" = "cold";
  type RailGroup = {
    circuit: RailCircuit;
    loads: Load[];
    path: BoardPathName | null;
    /** Sub-step minimum of the board node. Unused when `path` is false. */
    boardMin: number;
  };
  let rails = new Map<string, RailGroup>();
  /** Reused each step. Cleared at the start of the voltage and pulse passes. */
  const stepPulses = new Map<string, { bit: number; us: number }[]>();
  const faulted = new Set<string>();
  const rxSent = new Map<string, string>();
  let playing = false;
  let timer: unknown = null;
  let lastWall = 0;
  let stepDebt = 0;
  let sinceState = 0;
  const queue: ToWorker[] = [];
  let pumping = false;
  /** Test-only. The next `step` throws once, inside the sim loop. */
  let throwOnStep = false;

  let recorder: RunRecorder | null = null;
  let recordingSeq = 0;
  let worldSha256 = "";
  let runPlan: RunPlan | null = null;
  let runReport: RunReport | null = null;
  const seams = new SeamLedger();
  /** Degraded parts for this load. Copied onto the live state. */
  let degradedLive: Diagnostic[] = [];
  let reportPending = false;
  const envelopeWarned = new Set<string>();
  /** One empty-battery warning per supply, for this load of the world. */
  const batteryWarned = new Set<string>();
  const firmwareSha = new Map<string, string>();
  let inputNets: ReturnType<typeof gpioInputNets> = [];
  let applyingInputs = false;
  const txSeen = new Map<string, number>();
  const pendingNotes: { kind: "reset" | "reboot"; board: string }[] = [];

  type RecLayout = {
    joints: {
      robot: string;
      joint: string;
      mj: string;
      lower: number;
      upper: number;
      kind: JointLimitKind;
      qposadr: number;
    }[];
    bodies: { robot: string; link: string; mj: string }[];
    parts: Load[];
    rangers: RangerRuntime[];
    supplies: SupplySpec[];
    boards: string[];
  };

  let layout: RecLayout | null = null;

  function thrownMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  function post(message: FromWorker) {
    host.post(message);
  }

  function fail(errors: WorldError[], message?: string) {
    failure = message !== undefined ? { errors, message } : { errors };
    post({
      type: "error",
      generation,
      errors,
      ...(message ? { message } : {}),
    });
  }

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

  function tuple3(value: Float64Array): [number, number, number] {
    return [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0];
  }

  function tuple4(value: Float64Array): [number, number, number, number] {
    return [value[0] ?? 1, value[1] ?? 0, value[2] ?? 0, value[3] ?? 0];
  }

  function scalar(value: Float64Array): number {
    return value[0] ?? 0;
  }

  function sample(): WorldState | null {
    if (!sim) return null;
    const { mj, model, data, index } = sim;
    mj.mj_forward(model, data);
    const poses: WorldState["poses"] = {};
    for (const [robotId, links] of Object.entries(index.linkNames)) {
      const robot: WorldState["poses"][string] = {};
      for (const [link, mjName] of Object.entries(links)) {
        const body = data.body(mjName);
        robot[link] = {
          p: tuple3(body.xpos as Float64Array),
          q: tuple4(body.xquat as Float64Array),
        };
      }
      poses[robotId] = robot;
    }
    const joints: WorldState["joints"] = {};
    for (const [robotId, names] of Object.entries(index.jointNamesByRobot)) {
      const robot: WorldState["joints"][string] = {};
      for (const [joint, mjName] of Object.entries(names)) {
        robot[joint] = scalar(data.jnt(mjName).qpos as Float64Array);
      }
      joints[robotId] = robot;
    }
    const boardState: WorldState["boards"] = {};
    for (const board of boards) {
      const pins = board.takePins();
      const power = boardPower.get(board.id);
      const unpowered = !power?.supplyId;
      const node = power?.supplyId ? boardVolts(board.id) : 0;
      const chip = specs.find((item) => item.id === board.id)?.chip;
      const soa =
        chip === "atmega328p" &&
        board.running &&
        !board.brownout &&
        !board.fault &&
        !unpowered
          ? atmega328pSoaWarning(node, power?.brownoutVoltage ?? 2.7)
          : null;
      boardState[board.id] = {
        ...(board.fault
          ? { running: false as const, fault: board.fault, pins }
          : { running: board.running, pins }),
        ...(unpowered ? { unpowered: true as const } : {}),
        resets: power?.resets ?? 0,
        brownout: board.brownout,
        ...(power?.supplyId ? { voltage: node } : {}),
        ...ledReading(board.id),
        ...(() => {
          const extra = degradedLive.filter(
            (row) =>
              row.path === board.id || row.path.startsWith(`${board.id}.`)
          );
          const warnings = [
            ...(soa ? [soa] : []),
            ...extra.map((row) => ({
              code: "degraded" as const,
              message: row.message,
            })),
          ];
          return warnings.length > 0 ? { warnings } : {};
        })(),
      };
    }
    const parts: Record<string, WorldPartState> = {};
    for (const load of loads) {
      // Only a servo with a signal wire is on the wire. A setTarget
      // command has no pulse. An unwired V+ still draws through `loads`.
      if (!load.drive?.board) continue;
      parts[load.partId] = {
        pulseUs: load.drive?.track.pulseUs ?? null,
        commandDeg: load.drive?.track.commandDeg ?? null,
        state: load.state,
        current: load.current,
        voltage: load.drive?.board
          ? boardVolts(load.drive.board.id)
          : load.supplyId
            ? boardNodeOf(load.supplyId)
            : 0,
      };
    }
    for (const ranger of rangers) {
      const echoUs = ranger.echoS === null ? null : ranger.echoS * 1e6;
      parts[ranger.spec.id] = {
        pulseUs: echoUs,
        commandDeg: null,
        state: "idle",
        current: ranger.current,
        voltage: ranger.supplyId ? boardNodeOf(ranger.supplyId) : 0,
        distanceM: ranger.distanceM,
        echoS: ranger.echoS,
        hit: ranger.hit,
      };
    }
    return {
      simTime: data.time,
      playing,
      poses,
      joints,
      boards: boardState,
      parts,
      supplies: supplyLive,
      ...(degradedLive.length > 0
        ? {
            diagnostics: degradedLive.map((row) => ({
              severity: "degraded" as const,
              code: row.code ?? "idle",
              path: row.path,
              message: row.message,
            })),
          }
        : {}),
      ...(recorder ? { recording: recorder.summary(data.time) } : {}),
    };
  }

  function simMs(): number {
    if (!sim) return 0;
    return Math.round(sim.data.time * 1000);
  }

  function noteCommand(kind: "play" | "pause", by?: WorldSender) {
    if (!by || !recorder) return;
    recorder.noteEvent({ timeMs: simMs(), kind, by });
  }

  function fillRecorder(full: boolean) {
    const rec = recorder;
    const lay = layout;
    if (!rec || !lay || !sim) return;
    for (let i = 0; i < lay.joints.length; i++) {
      const spec = lay.joints[i];
      if (!spec) continue;
      const qpos = (sim.data.qpos as Float64Array)[spec.qposadr] ?? 0;
      rec.pastLimit[i] = pastLimitAmount(
        qpos,
        spec.lower,
        spec.upper,
        spec.kind
      );
      if (full) rec.joint[i] = qpos;
    }
    if (full) {
      let pose = 0;
      for (const spec of lay.bodies) {
        const body = sim.data.body(spec.mj);
        const p = body.xpos as Float64Array;
        const q = body.xquat as Float64Array;
        rec.pose[pose] = p[0] ?? 0;
        rec.pose[pose + 1] = p[1] ?? 0;
        rec.pose[pose + 2] = p[2] ?? 0;
        rec.pose[pose + 3] = q[0] ?? 1;
        rec.pose[pose + 4] = q[1] ?? 0;
        rec.pose[pose + 5] = q[2] ?? 0;
        rec.pose[pose + 6] = q[3] ?? 0;
        pose += 7;
      }
      for (let i = 0; i < lay.parts.length; i++) {
        const drive = lay.parts[i]?.drive;
        rec.pulse[i] = drive?.track.pulseUs ?? Number.NaN;
        rec.command[i] =
          (drive?.board ? drive.track.commandDeg : drive?.manualDeg) ??
          Number.NaN;
      }
      for (let i = 0; i < lay.rangers.length; i++) {
        const ranger = lay.rangers[i];
        const index = lay.parts.length + i;
        if (!ranger || !rec.rangerDistance || !rec.rangerHit) continue;
        rec.pulse[index] =
          ranger.echoS === null ? Number.NaN : ranger.echoS * 1e6;
        rec.command[index] = Number.NaN;
        rec.rangerDistance[index] = ranger.distanceM ?? Number.NaN;
        rec.rangerHit[index] = ranger.hit ? 1 : 0;
      }
      for (let i = 0; i < lay.boards.length; i++) {
        const id = lay.boards[i];
        const board = boards.find((item) => item.id === id);
        const pins = board?.peekPins() ?? { ddr: 0, level: 0, toggled: 0 };
        rec.ddr[i] = pins.ddr;
        rec.level[i] = pins.level;
        rec.toggled[i] = pins.toggled;
        rec.running[i] = board?.running ? 1 : 0;
      }
    }
    for (let i = 0; i < lay.parts.length; i++) {
      const load = lay.parts[i];
      if (!load) continue;
      rec.state[i] = motionRank(load.state);
      rec.partCurrent[i] = load.current;
      rec.partVoltage[i] = load.drive?.board
        ? boardVolts(load.drive.board.id)
        : load.supplyId
          ? boardNodeOf(load.supplyId)
          : 0;
    }
    for (let i = 0; i < lay.rangers.length; i++) {
      const ranger = lay.rangers[i];
      if (!ranger) continue;
      const index = lay.parts.length + i;
      rec.state[index] = 0;
      rec.partCurrent[index] = ranger.current;
      rec.partVoltage[index] = ranger.supplyId
        ? boardNodeOf(ranger.supplyId)
        : 0;
    }
    for (let i = 0; i < lay.supplies.length; i++) {
      const spec = lay.supplies[i];
      const live = spec ? supplyLive[spec.id] : undefined;
      rec.voltage[i] = live?.voltage ?? 0;
      rec.supplyCurrent[i] = live?.current ?? 0;
      rec.supplySoc[i] = live?.soc ?? Number.NaN;
    }
    const ledFrames = new Map<
      string,
      ReturnType<RailCircuit["takeLedFrame"]>
    >();
    const ledFrameOf = (supplyId: string) => {
      const cached = ledFrames.get(supplyId);
      if (cached) return cached;
      const circuit = rails.get(supplyId)?.circuit;
      if (!circuit) return undefined;
      const frame = full ? circuit.takeLedFrame() : undefined;
      if (frame) ledFrames.set(supplyId, frame);
      return frame;
    };
    for (let i = 0; i < lay.boards.length; i++) {
      const id = lay.boards[i];
      const board = boards.find((item) => item.id === id);
      rec.boardVoltage[i] = id ? boardVolts(id) : 0;
      rec.regulatorA[i] = id ? regulatorAmps(id) : 0;
      if (rec.ledOn[i]) {
        const supplyId = id ? boardPower.get(id)?.supplyId : undefined;
        const frame = supplyId ? ledFrameOf(supplyId) : undefined;
        const key = `${id}.led`;
        rec.ledCurrent[i] = !id
          ? 0
          : frame && key in frame.leds
            ? (frame.leds[key] ?? 0)
            : (ledCurrentOf(id) ?? 0);
      }
      rec.brownout[i] = board?.brownout ? 1 : 0;
      rec.belowSoa[i] = board && boardInSoa(board) ? 1 : 0;
    }
    for (let k = 0; k < rec.ledPaths.length; k++) {
      const row = rec.ledPaths[k];
      if (!row) continue;
      const supplyId = boardPower.get(row.board)?.supplyId;
      const frame = supplyId ? ledFrameOf(supplyId) : undefined;
      const group = supplyId ? rails.get(supplyId) : undefined;
      rec.ledAmps[k] = frame
        ? (frame.leds[row.path] ?? 0)
        : (group?.circuit.leds[row.path] ?? 0);
    }
    if (full && host.ledTrace && worldRel.endsWith("nano-led.world.json")) {
      const supplyId = boardPower.get("nano")?.supplyId;
      const frame = supplyId ? ledFrames.get(supplyId) : undefined;
      const ms = simMs();
      if (frame && ms <= 90) {
        const end = frame.end.led ?? 0;
        const mean = frame.leds.led ?? 0;
        console.log(
          `nano-led D9 t=${(ms / 1000).toFixed(3)} end ${(end * 1e3).toFixed(4)} mA mean ${(mean * 1e3).toFixed(4)} mA`
        );
      }
    }
  }

  function boardInSoa(board: AvrBoard): boolean {
    if (!board.running || board.brownout || board.fault) return false;
    const spec = specs.find((item) => item.id === board.id);
    if (spec?.chip !== "atmega328p") return false;
    const power = boardPower.get(board.id);
    if (!power?.supplyId) return false;
    const voltage = boardVolts(board.id);
    return voltage > power.brownoutVoltage && voltage < ATMEGA328P_16MHZ_MIN_V;
  }

  function openRecorder() {
    recorder = null;
    layout = null;
    txSeen.clear();
    pendingNotes.length = 0;
    if (!sim) return;
    const joints: RecLayout["joints"] = [];
    const jointType = sim.mj.mjtObj.mjOBJ_JOINT.value;
    const limits = sim.model.jnt_range as Float64Array;
    const qposadr = sim.model.jnt_qposadr as Int32Array;
    const jntType = sim.model.jnt_type as Int32Array;
    const slide = sim.mj.mjtJoint.mjJNT_SLIDE.value;
    for (const [robot, names] of Object.entries(sim.index.jointNamesByRobot)) {
      for (const [joint, mjName] of Object.entries(names)) {
        const id = sim.mj.mj_name2id(sim.model, jointType, mjName);
        const type = jntType[id] ?? 0;
        // A ball joint's qpos is a quaternion. URDF has none; treat anything
        // that is not a slide as a hinge angle.
        const kind: JointLimitKind = type === slide ? "slide" : "hinge";
        joints.push({
          robot,
          joint,
          mj: mjName,
          lower: limits[id * 2] ?? 0,
          upper: limits[id * 2 + 1] ?? 0,
          kind,
          qposadr: qposadr[id] ?? 0,
        });
      }
    }
    const bodies: RecLayout["bodies"] = [];
    for (const [robot, names] of Object.entries(sim.index.linkNames)) {
      for (const [link, mj] of Object.entries(names)) {
        bodies.push({ robot, link, mj });
      }
    }
    const parts = loads.filter((load) => load.drive);
    const boardIds = boards.map((board) => board.id);
    layout = {
      joints,
      bodies,
      parts,
      rangers,
      supplies: supplySpecs,
      boards: boardIds,
    };
    recordingSeq += 1;
    recorder = new RunRecorder({
      id: `r${recordingSeq}`,
      manifest: manifestOf(),
      joints: joints.map(({ robot, joint }) => ({ robot, joint })),
      bodies: bodies.map(({ robot, link }) => ({ robot, link })),
      parts: [
        ...parts.map((load) => load.partId),
        ...rangers.map((ranger) => ranger.spec.id),
      ],
      partRanger: [...parts.map(() => false), ...rangers.map(() => true)],
      supplies: supplySpecs.map((supply) => supply.id),
      boards: boardIds,
      boardLed: boardIds.map((id) => {
        const supplyId = boardPower.get(id)?.supplyId;
        const group = supplyId ? rails.get(supplyId) : undefined;
        return group?.circuit.ledPaths.includes(`${id}.led`) ?? false;
      }),
      leds: boardIds.flatMap((id) => {
        const supplyId = boardPower.get(id)?.supplyId;
        const group = supplyId ? rails.get(supplyId) : undefined;
        return (group?.circuit.ledPaths ?? []).map((path) => ({
          board: id,
          path,
        }));
      }),
    });
    fillRecorder(true);
    recorder.commit(simMs());
    for (const board of boards) {
      if (!board.fault) continue;
      recorder.noteEvent({
        timeMs: simMs(),
        kind: "fault",
        board: board.id,
        message: board.fault,
      });
    }
  }

  function catalogOf(part: RunPlan["parts"][number]): RecordingPartCatalog {
    return {
      ...(part.torqueNm !== undefined ? { torqueNm: part.torqueNm } : {}),
      ...(part.supply ? { supply: part.supply } : {}),
      ...(part.motor ? { motor: part.motor } : {}),
    };
  }

  function manifestOf(): RecordingManifest {
    const timestep = sim?.model.opt.timestep ?? 0.001;
    const which = sim?.model.opt.integrator ?? 3;
    const parts: RecordingManifest["parts"] = {};
    for (const part of runPlan?.parts ?? []) {
      if (parts[part.model]) continue;
      parts[part.model] = catalogOf(part);
    }
    return {
      mujoco: host.versions.mujoco,
      avr8js: host.versions.avr8js,
      timestep,
      integrator: INTEGRATORS[which] ?? String(which),
      frameMs: RECORD_FRAME_MS,
      worldSha256,
      boards: specs.map((spec) => ({
        id: spec.id,
        firmware: spec.firmware,
        sha256: firmwareSha.get(spec.id) ?? "",
      })),
      parts,
    };
  }

  function recordStep() {
    const rec = recorder;
    if (!rec?.enabled || !sim) {
      pendingNotes.length = 0;
      return;
    }
    const ms = simMs();
    fillRecorder(ms % RECORD_FRAME_MS === 0);
    for (const board of boards) {
      const text = board.peekTx();
      let seen = txSeen.get(board.id) ?? 0;
      if (text.length < seen) seen = 0;
      if (text.length > seen) {
        rec.noteSerial(board.id, text.slice(seen), ms);
        seen = text.length;
      }
      txSeen.set(board.id, seen);
    }
    for (const note of pendingNotes) {
      rec.noteEvent({ timeMs: ms, kind: note.kind, board: note.board });
    }
    pendingNotes.length = 0;
    rec.commit(ms);
  }

  function flushBoards() {
    const chunks: { board: string; text: string }[] = [];
    for (const board of boards) {
      const text = board.takeTx();
      if (text) chunks.push({ board: board.id, text });
      const stamp = `${board.rxQueued}:${board.rxAccepted}`;
      if (rxSent.get(board.id) === stamp) continue;
      rxSent.set(board.id, stamp);
      post({
        type: "rx",
        generation,
        board: board.id,
        queued: board.rxQueued,
        accepted: board.rxAccepted,
      });
    }
    if (chunks.length > 0) {
      if (host.keepSerial) serialChunks.push(...chunks);
      post({ type: "serial", generation, chunks });
    }
  }

  function postState(request?: number) {
    flushBoards();
    const state = sample();
    if (!state) return;
    post({
      type: "state",
      generation,
      state,
      ...(request !== undefined ? { request } : {}),
      ...(reportPending && runReport ? { report: runReport } : {}),
    });
    reportPending = false;
  }

  function noteFault(board: AvrBoard) {
    if (!board.fault || faulted.has(board.id)) return;
    faulted.add(board.id);
    post({
      type: "boardFault",
      generation,
      board: board.id,
      message: board.fault,
    });
    recorder?.noteEvent({
      timeMs: simMs(),
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
    }));
  }

  /** Board and supply netlist children are dropped on purpose. A scene part is not. */
  function scenePrune(path: string): boolean {
    if (!runPlan) return true;
    const under = (id: string) => path === id || path.startsWith(`${id}.`);
    if (runPlan.boards.some((board) => under(board.id))) return false;
    if (runPlan.supplies.some((supply) => under(supply.id))) return false;
    return true;
  }

  function noteOpen(circuit: RailCircuit): void {
    for (const path of circuit.pruned) {
      if (!scenePrune(path)) continue;
      noteDegraded(path, "idle", "not connected in this circuit");
    }
  }

  function spansOn(ids: readonly string[]) {
    const rows = runPlan?.spans;
    if (!rows) return undefined;
    const have = new Set(ids);
    const parts = rows
      .filter((row) => row.boards.every((id) => have.has(id)))
      .map((row) => row.part);
    return parts.length > 0 ? parts : undefined;
  }

  /**
   * The board whose 5V, VIN, or VBUS the part's power pins reach.
   * Ground wires are not followed, so a shared ground is not a second board.
   */
  function powerBoardOf(plan: RunPlan, partId: string): string | null {
    const part = plan.parts.find((item) => item.id === partId);
    if (!part) return null;
    const adjacent = new Map<string, string[]>();
    const link = (from: string, to: string) => {
      const list = adjacent.get(from);
      if (list) list.push(to);
      else adjacent.set(from, [to]);
    };
    for (const wire of plan.wires) {
      link(wire[0], wire[1]);
      link(wire[1], wire[0]);
    }
    const split = (full: string): { id: string; pin: string } | null => {
      const dot = full.lastIndexOf(".");
      if (dot <= 0 || dot >= full.length - 1) return null;
      return { id: full.slice(0, dot), pin: full.slice(dot + 1) };
    };
    const isGround = (full: string): boolean => {
      const end = split(full);
      if (!end) return false;
      const owner = plan.parts.find((item) => item.id === end.id);
      if (owner?.pins[end.pin]?.kind === "ground") return true;
      const board = plan.boards.find(
        (item) => end.id === item.id || end.id.startsWith(`${item.id}.`)
      );
      if (board && end.pin === board.groundPin) return true;
      const supply = plan.supplies.find((item) => item.id === end.id);
      if (supply && end.pin === supply.groundPin) return true;
      return false;
    };
    const found = new Set<string>();
    const seen = new Set<string>();
    const queue = Object.entries(part.pins)
      .filter(([, pin]) => pin.kind === "power")
      .map(([name]) => `${partId}.${name}`);
    while (queue.length > 0) {
      const full = queue.shift();
      if (!full || seen.has(full) || isGround(full)) continue;
      seen.add(full);
      const end = split(full);
      if (end) {
        for (const board of plan.boards) {
          const onBoard =
            end.id === board.id || end.id.startsWith(`${board.id}.`);
          if (
            onBoard &&
            (end.pin === board.voltagePin ||
              end.pin === "VIN" ||
              end.pin === "VBUS")
          ) {
            found.add(board.id);
          }
        }
      }
      for (const next of adjacent.get(full) ?? []) queue.push(next);
    }
    if (found.size !== 1) return null;
    return [...found][0] ?? null;
  }

  function noteDegraded(path: string, code: string, message: string): void {
    if (degradedLive.some((row) => row.path === path && row.code === code)) {
      return;
    }
    const row: Diagnostic = {
      severity: "degraded",
      code,
      path,
      port: "*",
      quantity: "Part",
      left: path,
      right: "idle",
      message,
    };
    degradedLive.push(row);
    if (!runReport) return;
    const list = runReport.degraded ?? [];
    if (list.some((item) => item.path === path && item.code === code)) return;
    runReport.degraded = [...list, row];
  }

  function bootBoard(spec: BoardSpec): AvrBoard {
    const board = new AvrBoard(spec.id);
    attachAnalog(board);
    // No supply: the CPU never starts. A later step does not boot it either.
    if (!boardPower.get(spec.id)?.supplyId) return board;
    if (!chipFacts(spec.chip)) {
      board.stop(`unsupported chip "${spec.chip}"`);
      return board;
    }
    const bytes = files?.read(spec.firmware);
    if (!bytes) {
      noteDegraded(
        spec.id,
        "missing-file",
        `firmware "${spec.firmware}" does not exist`
      );
      board.stop(`firmware "${spec.firmware}" does not exist`);
      return board;
    }
    firmwareSha.set(spec.id, host.sha256(bytes));
    const parsed = parseIntelHex(new TextDecoder().decode(bytes));
    if (!parsed.ok) {
      board.stop(parsed.error);
      return board;
    }
    board.load(parsed.bytes);
    return board;
  }

  function loadBoards(plan: RunPlan) {
    firmwareSha.clear();
    specs = boardSpecsOf(plan);
    boards = specs.map((spec) => bootBoard(spec));
    faulted.clear();
    rxSent.clear();
    for (const board of boards) noteFault(board);
  }

  /**
   * One power walk per load. `bootBoard` reads this map, so it is filled
   * before the CPUs start and not again when the servos are bound.
   */
  function fillBoardPower(plan: RunPlan) {
    const feeds = powerFeedsOf(plan);
    partFeeds = feeds.parts;
    supplySpecs = plan.supplies.map((supply) => ({
      id: supply.id,
      voltage: supply.voltage,
      currentLimit: supply.currentLimit,
      rSeries: supply.rSeries,
      ...(supply.battery ? { battery: supply.battery } : {}),
      ...(supply.ideal ? { ideal: true as const } : {}),
    }));
    boardPower = new Map();
    for (const board of plan.boards) {
      const supplyId = feeds.boards[board.id] ?? null;
      boardPower.set(board.id, {
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
  function applyInputNets() {
    if (applyingInputs || inputNets.length === 0) return;
    applyingInputs = true;
    try {
      applyGpioDrives(inputNets, boards);
    } finally {
      applyingInputs = false;
    }
  }

  function bindInputNets(plan: RunPlan) {
    inputNets = gpioInputNets(plan);
    const refresh = () => applyInputNets();
    for (const board of boards) {
      board.onPinsChanged = inputNets.length > 0 ? refresh : null;
    }
    applyInputNets();
  }

  function bindPower(plan: RunPlan) {
    loads = [];
    if (!sim) return;
    const drives = servoSignalDrives(plan);
    for (const part of plan.parts) {
      if (!part.motor || part.torqueNm === undefined) continue;
      const supplyId = partFeeds[part.id] ?? null;
      if (!supplyId) {
        noteDegraded(part.id, "unpowered", `${part.id} reaches no supply`);
      }
      const signal = drives.find((item) => item.partId === part.id);
      let drive: ServoDrive | null = null;
      if (part.drives && sim) {
        const actuatorId = sim.index.parts[part.id];
        const trnid = sim.model.actuator_trnid as Int32Array;
        const jointId =
          actuatorId === undefined ? -1 : (trnid[actuatorId * 2] ?? -1);
        if (actuatorId !== undefined && jointId >= 0) {
          const bit = signal ? arduinoPinBit(signal.pin) : undefined;
          const board = signal
            ? boards.find((item) => item.id === signal.boardId)
            : undefined;
          const wired = board !== undefined && bit !== undefined;
          if (wired && board && bit !== undefined) board.watchEdge(bit);
          drive = {
            board: wired && board ? board : null,
            pinBit: wired && bit !== undefined ? bit : -1,
            actuatorId,
            jointId,
            jointName: `${part.drives.robot}/${part.drives.joint}`,
            torqueNm: part.torqueNm,
            law: part.motor,
            track: blankTrack(),
            manualDeg: null,
          };
        }
      }
      const load: Load = {
        partId: part.id,
        supplyId,
        quiescent: supplyId ? part.motor.quiescent : 0,
        state: "idle",
        current: 0,
        drive,
        sample: null,
        stallMs: 0,
        winding: 0,
        railSlot: -1,
        powerBoard: powerBoardOf(plan, part.id),
      };
      loads.push(load);
    }
    bindRails();
    solveSupplies();
    latchSupplyNodes();
    stampNodes(simMs());
  }

  /** One circuit per supply. Motor laws are fixed for the run; s and ω are not. */
  function bindRails() {
    rails = new Map();
    for (const load of loads) load.railSlot = -1;
    const groups = new Map<string, Load[]>();
    for (const load of loads) {
      if (!load.drive || !load.supplyId) continue;
      const list = groups.get(load.supplyId);
      if (list) list.push(load);
      else groups.set(load.supplyId, [load]);
    }
    const islands = runPlan ? powerIslands(runPlan) : [];
    const islandOf = new Map(
      islands.flatMap((island) =>
        island.supplyIds.map((id) => [id, island] as const)
      )
    );
    const builtIsland = new Set<string>();
    for (const supply of supplySpecs) {
      const island = islandOf.get(supply.id);
      if (!runPlan || !island || island.supplyIds.length < 2) continue;
      if (builtIsland.has(island.id)) continue;
      const plan = runPlan;
      const fed = plan.boards.filter((board) =>
        island.supplyIds.includes(boardPower.get(board.id)?.supplyId ?? "")
      );
      const stamped = fed.filter((board) => board.stamp);
      const only = stamped.length === 1 ? stamped[0] : undefined;
      if (stamped.length === 0) continue;
      if (!only?.stamp) {
        const islandSupplies = island.supplyIds.flatMap((id) => {
          const found = plan.supplies.find((item) => item.id === id);
          return found ? [found] : [];
        });
        const boardsSorted = [...stamped].sort((a, b) =>
          a.id < b.id ? -1 : a.id > b.id ? 1 : 0
        );
        const suppliesSorted = [...islandSupplies].sort((a, b) =>
          a.id < b.id ? -1 : a.id > b.id ? 1 : 0
        );
        const primary = suppliesSorted[0];
        if (!primary) continue;
        const members = island.supplyIds.flatMap((id) => groups.get(id) ?? []);
        const byId = (a: { id: string }, b: { id: string }) =>
          a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        const reachedBy = (supplyId: string) =>
          boardsSorted.filter((board) =>
            [board.voltagePin, "VIN", "VBUS"].some((port) =>
              suppliesOnPort(plan, board.id, port).includes(supplyId)
            )
          );
        const claimed = new Set<string>();
        const hostOf = new Map<string, (typeof boardsSorted)[number] | null>();
        const attachOrder = [...suppliesSorted].sort((a, b) => {
          const aOne = reachedBy(a.id).length === 1 ? 0 : 1;
          const bOne = reachedBy(b.id).length === 1 ? 0 : 1;
          if (aOne !== bOne) return aOne - bOne;
          return byId(a, b);
        });
        for (const supply of attachOrder) {
          const reached = reachedBy(supply.id);
          const sole = reached.length === 1 ? reached[0] : undefined;
          if (sole) {
            hostOf.set(supply.id, sole);
            if (supply.connector === "usb" && sole.stamp?.vbusNode) {
              claimed.add(sole.id);
            }
            continue;
          }
          const distinctVbus =
            supply.connector === "usb" &&
            reached.some((board) => board.stamp?.vbusNode);
          if (!distinctVbus) {
            hostOf.set(supply.id, reached[0] ?? null);
            continue;
          }
          const free = reached.filter((board) => !claimed.has(board.id));
          const pool = (free.length > 0 ? free : reached).slice().sort(byId);
          const host = pool[0] ?? null;
          if (host) claimed.add(host.id);
          hostOf.set(supply.id, host);
        }
        const nodeFor = (supplyId: string): string => {
          const supply = suppliesSorted.find((item) => item.id === supplyId);
          const board = hostOf.get(supplyId) ?? null;
          const stamp = board?.stamp;
          if (!supply || !board || !stamp) {
            return supplyPositiveNode(plan, supplyId);
          }
          const onVin = suppliesOnPort(plan, board.id, "VIN").includes(
            supplyId
          );
          const onVbus = suppliesOnPort(plan, board.id, "VBUS").includes(
            supplyId
          );
          const onRail = suppliesOnPort(
            plan,
            board.id,
            board.voltagePin
          ).includes(supplyId);
          if (onVbus && stamp.vbusNode) return stamp.vbusNode;
          if (onVin && !onRail && stamp.portNodes.VIN) {
            return stamp.portNodes.VIN;
          }
          if (supply.connector === "usb" && onRail && stamp.vbusNode) {
            return stamp.vbusNode;
          }
          if (onRail) {
            return stamp.portNodes[board.voltagePin] ?? stamp.boardNode;
          }
          if (onVin && stamp.portNodes.VIN) return stamp.portNodes.VIN;
          return stamp.boardNode;
        };
        const primaryNode = nodeFor(primary.id);
        const islandSpans = spansOn(boardsSorted.map((board) => board.id));
        const circuit = createRailCircuit({
          vNom: primary.voltage,
          rSeries: primary.rSeries,
          iLimit: primary.currentLimit,
          motors: members.map((load) => {
            const drive = load.drive;
            if (!drive) throw new Error("rail motor has no drive");
            return {
              resistance: drive.law.resistance,
              k: drive.law.k,
              boardId: load.powerBoard ?? drive.board?.id,
            };
          }),
          ...(islandSpans ? { spans: islandSpans } : {}),
          ...(primary.battery ? { battery: primary.battery } : {}),
          ...(primary.ideal ? { ideal: true as const } : {}),
          primaryId: primary.id,
          primaryNode,
          boards: boardsSorted.map((board) => {
            const feeders = suppliesSorted.filter((supply) =>
              reachedBy(supply.id).some((item) => item.id === board.id)
            );
            const usb = feeders.find((supply) => supply.connector === "usb");
            const feeder = usb ?? feeders[0] ?? primary;
            const one = railAttachment({
              connector: feeder.connector,
              boardCircuit: board.boardCircuit,
              hasNetlist: board.hasNetlist,
              stamp: board.stamp,
            });
            const feed = board.vinFeed ? "vin" : one.feed;
            if (!board.stamp || !feed) {
              throw new Error(`${board.id} has no feed`);
            }
            return {
              id: board.id,
              stamp: board.stamp,
              feed,
              pin: board.pin,
            };
          }),
          also: suppliesSorted.slice(1).map((item) => ({
            id: item.id,
            vNom: item.voltage,
            rSeries: item.rSeries,
            iLimit: item.currentLimit,
            node: nodeFor(item.id),
            ...(item.battery ? { battery: item.battery } : {}),
            ...(item.ideal ? { ideal: true as const } : {}),
          })),
        });
        noteOpen(circuit);
        if (fuseStart === "tripped") circuit.tripFuse();
        for (let i = 0; i < members.length; i++) {
          const load = members[i];
          if (load) load.railSlot = i;
        }
        const group = {
          circuit,
          loads: members,
          path: null as BoardPathName | null,
          boardMin: 0,
        };
        for (const id of island.supplyIds) rails.set(id, group);
        rails.set(island.id, group);
        builtIsland.add(island.id);
        continue;
      }
      const onVin = suppliesOnPort(plan, only.id, "VIN")[0] ?? null;
      const onRail = suppliesOnPort(plan, only.id, only.voltagePin)[0] ?? null;
      const railSupply = plan.supplies.find((item) => item.id === onRail);
      const vinSupply = plan.supplies.find((item) => item.id === onVin);
      const vbus = only.stamp.vbusNode;
      const vinNode = only.stamp.portNodes.VIN ?? null;
      if (
        !railSupply ||
        !vinSupply ||
        !vinNode ||
        vinSupply.id === railSupply.id
      ) {
        continue;
      }
      const usb = railSupply.connector === "usb";
      const railNode = usb ? vbus : only.stamp.boardNode;
      if (!railNode || railNode === vinNode) continue;
      const members = island.supplyIds.flatMap((id) => groups.get(id) ?? []);
      const primary = vinSupply;
      const circuit = createRailCircuit({
        vNom: primary.voltage,
        rSeries: primary.rSeries,
        iLimit: primary.currentLimit,
        motors: members.map((load) => {
          const drive = load.drive;
          if (!drive) throw new Error("rail motor has no drive");
          return {
            resistance: drive.law.resistance,
            k: drive.law.k,
            boardId: load.powerBoard ?? drive.board?.id,
          };
        }),
        pin: only.pin,
        ledAlias: `${only.id}.led`,
        stamp: only.stamp,
        feed: "vin",
        ...(usb && vbus ? { keep: [vbus] } : {}),
        primaryId: primary.id,
        ...(primary.battery ? { battery: primary.battery } : {}),
        ...(primary.ideal ? { ideal: true as const } : {}),
        also: [
          {
            id: railSupply.id,
            vNom: railSupply.voltage,
            rSeries: railSupply.rSeries,
            iLimit: railSupply.currentLimit,
            node: railNode,
            ...(railSupply.battery ? { battery: railSupply.battery } : {}),
            ...(railSupply.ideal ? { ideal: true as const } : {}),
          },
        ],
      });
      noteOpen(circuit);
      if (fuseStart === "tripped") circuit.tripFuse();
      for (let i = 0; i < members.length; i++) {
        const load = members[i];
        if (load) load.railSlot = i;
      }
      const group = {
        circuit,
        loads: members,
        path: null as BoardPathName | null,
        boardMin: 0,
      };
      for (const id of island.supplyIds) rails.set(id, group);
      rails.set(island.id, group);
      builtIsland.add(island.id);
    }
    for (const supply of supplySpecs) {
      if (builtIsland.has(islandOf.get(supply.id)?.id ?? "")) continue;
      const members = groups.get(supply.id) ?? [];
      const fedBoards = boardsFed(supply.id);
      const stamped = fedBoards.filter((board) => board.stamp);
      const fed = boardOn(supply.id);
      const supplyStamp = runPlan?.supplies.find(
        (item) => item.id === supply.id
      )?.stamp;
      const attached = railAttachment({
        connector: supplyConnectorOf(supply.id),
        boardCircuit: fed?.boardCircuit ?? null,
        hasNetlist: fed?.hasNetlist ?? false,
        stamp: fed?.stamp ?? supplyStamp,
      });
      const path = attached.boardPath;
      // One stamped board is the shared rail with N = 1.
      const shared = stamped.length >= 1 && stamped.length === fedBoards.length;
      const sharedSpans = spansOn(stamped.map((board) => board.id));
      const circuit = shared
        ? createRailCircuit({
            vNom: supply.voltage,
            rSeries: supply.rSeries,
            iLimit: supply.currentLimit,
            motors: members.map((load) => {
              const drive = load.drive;
              if (!drive) throw new Error("rail motor has no drive");
              return {
                resistance: drive.law.resistance,
                k: drive.law.k,
                boardId: load.powerBoard ?? drive.board?.id,
              };
            }),
            ...(stamped.length === 1 && path ? { boardPath: path } : {}),
            ...(stamped.length === 1 && fed
              ? { pin: fed.pin, ledAlias: `${fed.id}.led` }
              : {}),
            ...(supply.battery ? { battery: supply.battery } : {}),
            ...(supply.ideal ? { ideal: true as const } : {}),
            ...(sharedSpans ? { spans: sharedSpans } : {}),
            boards: stamped.map((board) => {
              const one = railAttachment({
                connector: supplyConnectorOf(supply.id),
                boardCircuit: board.boardCircuit,
                hasNetlist: board.hasNetlist,
                stamp: board.stamp,
              });
              const feed = board.vinFeed ? "vin" : one.feed;
              if (!board.stamp || !feed) {
                throw new Error(`${board.id} has no feed`);
              }
              return {
                id: board.id,
                stamp: board.stamp,
                feed,
                pin: board.pin,
              };
            }),
          })
        : createRailCircuit({
            vNom: supply.voltage,
            rSeries: supply.rSeries,
            iLimit: supply.currentLimit,
            motors: members.map((load) => {
              const drive = load.drive;
              if (!drive) throw new Error("rail motor has no drive");
              return {
                resistance: drive.law.resistance,
                k: drive.law.k,
                // The terminal is VIN. The winding sits on this board's 5V node.
                boardId: load.powerBoard ?? drive.board?.id,
              };
            }),
            ...(path ? { boardPath: path } : {}),
            ...(fed ? { pin: fed.pin, ledAlias: `${fed.id}.led` } : {}),
            ...(attached.stamp && (fed?.vinFeed || attached.feed)
              ? {
                  stamp: attached.stamp,
                  feed: fed?.vinFeed ? "vin" : attached.feed,
                }
              : {}),
            ...(supply.battery ? { battery: supply.battery } : {}),
            ...(supply.ideal ? { ideal: true as const } : {}),
          });
      noteOpen(circuit);
      if (fuseStart === "tripped") circuit.tripFuse();
      for (let i = 0; i < members.length; i++) {
        const load = members[i];
        if (load) load.railSlot = i;
      }
      rails.set(supply.id, { circuit, loads: members, path, boardMin: 0 });
    }
  }

  function supplyConnectorOf(supplyId: string): string | null {
    return (
      runPlan?.supplies.find((item) => item.id === supplyId)?.connector ?? null
    );
  }

  /**
   * The first firmware board this supply powers. A shared rail still
   * uses it for the supply-level snapshot warning.
   */
  function boardOn(supplyId: string): RunBoard | null {
    return boardsFed(supplyId)[0] ?? null;
  }

  function boardsFed(supplyId: string): RunBoard[] {
    if (!runPlan) return [];
    return runPlan.boards.filter(
      (board) => boardPower.get(board.id)?.supplyId === supplyId
    );
  }

  /** The firmware board this supply feeds, when that rail stamps pins. */
  function drivenBoard(supplyId: string): AvrBoard | null {
    const board = boardOn(supplyId);
    if (!board) return null;
    return boards.find((item) => item.id === board.id) ?? null;
  }

  /** Onboard LED current. Present when this rail stamped `${board}.led`. */
  function ledCurrentOf(boardId: string): number | undefined {
    const supplyId = boardPower.get(boardId)?.supplyId;
    if (!supplyId) return undefined;
    const group = rails.get(supplyId);
    if (!group) return undefined;
    const key = `${boardId}.led`;
    if (!group.circuit.ledPaths.includes(key)) return undefined;
    return group.circuit.leds[key] ?? 0;
  }

  /** Pass current into this board's 5V node. Zero when no regulator feeds it. */
  function regulatorAmps(boardId: string): number {
    const supplyId = boardPower.get(boardId)?.supplyId;
    if (!supplyId) return 0;
    return rails.get(supplyId)?.circuit.regulatorOut(boardId) ?? 0;
  }

  function ledReading(boardId: string): {
    ledCurrent?: number;
    leds?: Record<string, number>;
  } {
    const supplyId = boardPower.get(boardId)?.supplyId;
    if (!supplyId) return {};
    const group = rails.get(supplyId);
    if (!group || group.circuit.ledPaths.length === 0) return {};
    const card = group.circuit.ledCardReading();
    const current = ledCurrentOf(boardId);
    return {
      leds: card.leds,
      ...(current === undefined
        ? {}
        : { ledCurrent: card.leds[`${boardId}.led`] ?? 0 }),
    };
  }

  /** One warning per path and ref when an observed bound is outside. */
  function noteSnapshotEnvelope(supplyId: string): void {
    const group = rails.get(supplyId);
    if (!group) return;
    const supply = runPlan?.supplies.find((item) => item.id === supplyId);
    const parts = [
      ...boardsFed(supplyId).flatMap((item) => item.stamp?.parts ?? []),
      ...(supply?.stamp?.parts ?? []),
    ];
    for (const part of parts) {
      if (!part.table) continue;
      const reading = group.circuit.tableReading(part.path);
      if (!reading) continue;
      const port = part.table.law.across[0];
      warnEnvelope(part.path, part.table.ref, part.table.envelope, {
        [`${port}.current`]: reading.amps,
        [`${port}.voltage`]: reading.volts,
      });
    }
  }

  /** One warning when a battery first reads empty. The run keeps going. */
  function noteBattery(supplyId: string): void {
    if (batteryWarned.has(supplyId)) return;
    const group = rails.get(supplyId);
    const detail = group?.circuit.batteryWarning();
    if (!detail || !group?.circuit.batteryOf(supplyId)) return;
    batteryWarned.add(supplyId);
    if (!runReport) return;
    runReport.warnings.push({
      severity: "warning",
      path: supplyId,
      port: "+",
      quantity: "Voltage",
      left: String(group.circuit.sourceVoltage(supplyId)),
      right: "ocv(0)",
      message: `${supplyId} ${detail}`,
    });
    reportPending = true;
  }

  function warnEnvelope(
    path: string,
    ref: string,
    envelope: {
      bounds: Record<string, [number, number]>;
      current: [number, number];
    },
    observed: Readonly<Record<string, number>>
  ): void {
    const key = `${path}|${ref}`;
    if (envelopeWarned.has(key)) return;
    const hit = boundOutside(envelope, observed);
    if (!hit) return;
    envelopeWarned.add(key);
    const named = boundName(hit.key);
    const message =
      `${path} port ${named.port} quantity ${named.quantity}: ` +
      `snapshot ${ref} envelope exceeded; run continues ` +
      `(${hit.value} vs ${hit.range[0]}..${hit.range[1]})`;
    if (!runReport) return;
    runReport.warnings.push({
      severity: "warning",
      path,
      port: named.port,
      quantity: named.quantity,
      left: `${hit.value}`,
      right: `${hit.range[0]}..${hit.range[1]}`,
      message,
    });
    const row = runReport.snapshots.find(
      (item) => item.path === path && item.ref === ref
    );
    if (row) row.envelope = [...(row.envelope ?? []), message];
    reportPending = true;
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

  /** Drive mode of each stamped pin at the start of this millisecond. */
  const driveAtStart = new Map<string, Map<number, PinMode>>();

  function snapshotDriveModes(): void {
    driveAtStart.clear();
    for (const board of boards) {
      board.pinChanges = [];
      const supplyId = boardPower.get(board.id)?.supplyId;
      const circuit = supplyId ? rails.get(supplyId)?.circuit : undefined;
      if (!circuit || circuit.driveBits.length === 0) continue;
      const modes = new Map<number, PinMode>();
      for (const bit of circuit.driveBits) modes.set(bit, board.driveMode(bit));
      driveAtStart.set(board.id, modes);
    }
  }

  /**
   * Intervals between edges of every stamped pin inside this millisecond.
   * A single level change charges the rail for the part of the millisecond
   * after the edge. A pulse has both edges, and those intervals are the duty.
   */
  function pinPieces(
    avr: AvrBoard,
    circuit: RailCircuit
  ): { dt: number; drive: { bit: number; mode: PinMode }[] }[] | null {
    const bits = circuit.driveBits;
    const start = driveAtStart.get(avr.id);
    if (!start || bits.length === 0) return null;
    const wanted = new Set(bits);
    const edges = avr.pinChanges.filter(
      (edge) => wanted.has(edge.bit) && edge.cycle >= avr.stepOrigin
    );
    if (edges.length === 0) return null;
    const span = avr.cycles() - avr.stepOrigin;
    if (!(span > 0)) return null;
    const mode = new Map(start);
    const pieces: { dt: number; drive: { bit: number; mode: PinMode }[] }[] =
      [];
    let t = 0;
    let changed = false;
    const driveOf = () =>
      bits.map((bit) => ({
        bit,
        mode: mode.get(bit) ?? ("input" as const),
      }));
    for (const edge of edges) {
      const when = ((edge.cycle - avr.stepOrigin) / span) * 0.001;
      const dt = when - t;
      if (dt > 1e-12) pieces.push({ dt, drive: driveOf() });
      const prev = mode.get(edge.bit);
      if (prev === "high" || prev === "low") {
        const next: PinMode = edge.high ? "high" : "low";
        if (next !== prev) {
          mode.set(edge.bit, next);
          changed = true;
        }
      }
      if (when > t) t = when;
    }
    if (!changed) return null;
    const rest = 0.001 - t;
    if (rest > 1e-12) pieces.push({ dt: rest, drive: driveOf() });
    return pieces.length > 0 ? pieces : null;
  }

  /**
   * Pin edges of every board on one rail, merged onto one timeline.
   * A board that does not toggle contributes its held mode to each piece.
   */
  function pinPiecesUnion(
    specs: readonly { id: string }[],
    circuit: RailCircuit
  ):
    | { dt: number; drive: { bit: number; mode: PinMode; boardId: string }[] }[]
    | null {
    type Edge = { boardId: string; bit: number; when: number; high: boolean };
    const edges: Edge[] = [];
    const modes = new Map<string, Map<number, PinMode>>();
    const bitsOf = new Map<string, readonly number[]>();
    for (const spec of specs) {
      const avr = boards.find((item) => item.id === spec.id);
      const bits = circuit.driveBitsOf(spec.id);
      const start = driveAtStart.get(spec.id);
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
          when: ((edge.cycle - avr.stepOrigin) / span) * 0.001,
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
    const rest = 0.001 - t;
    if (rest > 1e-12) pieces.push({ dt: rest, drive: driveOf() });
    return pieces.length > 0 ? pieces : null;
  }

  function solveOneRail(
    supplyId: string,
    fixed: number
  ): { voltage: number; current: number; board: number; boardMin: number } {
    const group = rails.get(supplyId);
    if (!group) return { voltage: 0, current: 0, board: 0, boardMin: 0 };
    const { circuit, loads: members } = group;
    let pieces: ReturnType<typeof pinPieces> = null;
    if (circuit.boardIds.length > 1) {
      // Every board on the circuit, not only the ones `supplyId` feeds.
      // Two supplies on one island name different boards.
      const specs = circuit.boardIds.flatMap((id) => {
        const board = runPlan?.boards.find((item) => item.id === id);
        return board ? [board] : [];
      });
      const quiescent = new Map<string, number>();
      for (const load of members) {
        const id = load.powerBoard ?? load.drive?.board?.id ?? specs[0]?.id;
        if (!id) continue;
        quiescent.set(id, (quiescent.get(id) ?? 0) + load.quiescent);
      }
      let accounted = 0;
      for (const spec of specs) {
        const amps =
          (boardPower.get(spec.id)?.draw ?? 0) + (quiescent.get(spec.id) ?? 0);
        circuit.setBoardLoad(spec.id, amps);
        accounted += amps;
      }
      const ranger = fixed - accounted;
      const first = specs[0];
      if (first && ranger !== 0) {
        const base =
          (boardPower.get(first.id)?.draw ?? 0) +
          (quiescent.get(first.id) ?? 0);
        circuit.setBoardLoad(first.id, base + ranger);
      }
      pieces = pinPiecesUnion(specs, circuit);
      if (!pieces) {
        for (const spec of specs) {
          const avr = boards.find((item) => item.id === spec.id);
          if (!avr) continue;
          for (const bit of circuit.driveBitsOf(spec.id)) {
            circuit.setBoardDrive(spec.id, bit, avr.driveMode(bit));
          }
        }
      }
    } else {
      circuit.setFixed(fixed);
      const avr = drivenBoard(supplyId);
      pieces = avr ? pinPieces(avr, circuit) : null;
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
    circuit.solve(pieces ?? undefined);
    noteSnapshotEnvelope(supplyId);
    for (const [id, other] of rails) {
      if (other.circuit === circuit) noteBattery(id);
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

  function rearmServos(boardId: string, board: AvrBoard) {
    for (const load of loads) {
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

  function jointNow(drive: ServoDrive): { qpos: number; omega: number } {
    if (!sim) return { qpos: 0, omega: 0 };
    const qpos = scalar(sim.data.jnt(drive.jointName).qpos as Float64Array);
    const omega = scalar(sim.data.jnt(drive.jointName).qvel as Float64Array);
    return { qpos, omega };
  }

  /** Command latched so far, measured against the joint, before this step's torque. */
  function sampleLoad(load: Load) {
    const drive = load.drive;
    if (!drive) {
      load.sample = null;
      return;
    }
    const { qpos, omega } = jointNow(drive);
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

  /**
   * Volts the ranger may read. A board on the same supply contributes its
   * latched node. A supply with no board contributes its latched terminal,
   * so a bench supply can feed the sensor on its own.
   */
  function latchedSupplyNode(supplyId: string): number {
    for (const [boardId, power] of boardPower) {
      if (power.supplyId === supplyId) return latchedBoardNode(boardId);
    }
    return latchedTerminal.get(supplyId) ?? 0;
  }

  function bindRangers(plan: RunPlan) {
    rangers = (plan.rangers ?? []).map((spec) => {
      const ranger = new RangerRuntime(spec);
      ranger.supplyId = partFeeds[spec.id] ?? null;
      ranger.volts = () =>
        ranger.supplyId ? latchedSupplyNode(ranger.supplyId) : 0;
      ranger.physics = () =>
        sim ? { mj: sim.mj, model: sim.model, data: sim.data } : null;
      return ranger;
    });
    for (const board of boards) rearmRangers(board.id, board);
  }

  function rearmRangers(boardId: string, board: AvrBoard) {
    const listening = rangers.filter(
      (ranger) => ranger.spec.trig?.boardId === boardId
    );
    for (const ranger of rangers) {
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

  /**
   * Rail for this step, from the latched command and the joint velocity.
   * A powered servo always contributes its quiescent current. A driven
   * one also contributes `max(0, s·I_motor)`.
   */
  function solveSupplies() {
    for (const load of loads) sampleLoad(load);
    const rangerFixed = new Map<string, number>();
    for (const ranger of rangers) {
      const draw = ranger.takeDraw();
      if (!ranger.supplyId) continue;
      rangerFixed.set(
        ranger.supplyId,
        (rangerFixed.get(ranger.supplyId) ?? 0) + draw
      );
    }
    const next: Record<string, WorldSupplyState> = {};
    const solved = new Set<RailCircuit>();
    for (const supply of supplySpecs) {
      const group = rails.get(supply.id);
      const circuit = group?.circuit;
      if (circuit && solved.has(circuit)) continue;
      if (circuit) solved.add(circuit);
      const onThis = (id: string | null) => {
        if (!id) return false;
        if (!circuit) return id === supply.id;
        return rails.get(id)?.circuit === circuit;
      };
      let fixed = 0;
      for (const power of boardPower.values()) {
        if (!onThis(power.supplyId)) continue;
        fixed += power.draw;
      }
      for (const load of loads) {
        if (!onThis(load.supplyId)) continue;
        fixed += load.quiescent;
      }
      for (const [id, draw] of rangerFixed) {
        if (onThis(id)) fixed += draw;
      }
      solveOneRail(supply.id, fixed);
    }
    for (const supply of supplySpecs) {
      const circuit = rails.get(supply.id)?.circuit;
      // The supply record is the terminal. The board node is reported on
      // the board, and a servo's V+ is that same node. A battery also
      // records the state of charge after this step.
      const soc = circuit?.batteryOf(supply.id) ? circuit.soc : undefined;
      const voltage = circuit?.sourceVoltage(supply.id) ?? 0;
      const current = circuit?.sourceCurrent(supply.id) ?? 0;
      next[supply.id] =
        soc === undefined ? { voltage, current } : { voltage, current, soc };
    }
    for (const load of loads) {
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
    supplyLive = next;
  }

  function reloadBoard(id: string) {
    const spec = specs.find((item) => item.id === id);
    if (!spec) {
      post({
        type: "boardFault",
        generation,
        board: id,
        message: `no board "${id}"`,
      });
      return;
    }
    const next = bootBoard(spec);
    const index = boards.findIndex((item) => item.id === id);
    if (index >= 0) boards[index] = next;
    else boards.push(next);
    rearmServos(id, next);
    rearmRangers(id, next);
    // The new image has not run, and this board's servos are idle. Publish
    // the rail those currents actually draw. A sag still under the assert
    // threshold holds the new CPU in reset. A firmware reload is not a
    // brown-out delay: once the rail is up, the image runs.
    solveSupplies();
    const power = boardPower.get(id);
    if (power?.supplyId && !next.fault) {
      const voltage = brownoutOf(id);
      if (voltage < power.assertVoltage) {
        next.holdInReset();
        power.brownout = { phase: "held", releaseAtMs: null };
        applyInputNets();
      } else {
        power.brownout = runningBrownout();
      }
    }
    rxSent.delete(id);
    faulted.delete(id);
    if (runPlan) bindInputNets(runPlan);
    const recorded = recorder?.manifest.boards.find((item) => item.id === id);
    if (recorded) recorded.sha256 = firmwareSha.get(id) ?? recorded.sha256;
    if (next.running) {
      const ms = simMs();
      recorder?.noteEvent({ timeMs: ms, kind: "reload", board: id });
      recorder?.noteSerial(id, FIRMWARE_RELOADED, ms);
      txSeen.set(id, 0);
      post({
        type: "boardReset",
        generation,
        board: id,
        marker: FIRMWARE_RELOADED,
      });
    } else {
      noteFault(next);
    }
    // The reload solved the rail without advancing time. The next CPU step
    // reads this node as the previous step.
    stampNodes(simMs());
    postState();
  }

  function serialIn(id: string, text: string, by?: WorldSender) {
    const board = boards.find((item) => item.id === id);
    if (!board?.running) return;
    if (!board.pushRx(text)) {
      rxSent.set(id, `${board.rxQueued}:${board.rxAccepted}`);
      post({
        type: "rx",
        generation,
        board: id,
        queued: board.rxQueued,
        accepted: board.rxAccepted,
      });
      return;
    }
    if (by) {
      recorder?.noteEvent({
        timeMs: simMs(),
        kind: "serial-send",
        board: id,
        text,
        by,
      });
    }
    rxSent.set(id, `${board.rxQueued}:${board.rxAccepted}`);
    post({
      type: "rx",
      generation,
      board: id,
      queued: board.rxQueued,
      accepted: board.rxAccepted,
    });
  }

  /** Board node at the end of the step. With no cable this is the terminal. */
  function boardNodeOf(supplyId: string): number {
    return rails.get(supplyId)?.circuit.boardVoltage ?? 0;
  }

  function boardVolts(boardId: string): number {
    const supplyId = boardPower.get(boardId)?.supplyId;
    if (!supplyId) return 0;
    return rails.get(supplyId)?.circuit.boardReading(boardId).voltage ?? 0;
  }

  /** Node the CPU is allowed to see: the latch, not the solve in progress. */
  function latchedBoardNode(boardId: string): number {
    return latchedNode.get(boardId) ?? 0;
  }

  /**
   * Copy each board node into the latch. Called before any CPU step, and
   * again after `solveSupplies` so a reboot in this quantum sees the rail
   * that just recovered.
   */
  function latchSupplyNodes() {
    if (!runPlan) return;
    for (const board of runPlan.boards) {
      const supplyId = boardPower.get(board.id)?.supplyId;
      latchedNode.set(board.id, supplyId ? boardVolts(board.id) : 0);
    }
    for (const supply of supplySpecs) {
      latchedTerminal.set(
        supply.id,
        rails.get(supply.id)?.circuit.sourceVoltage(supply.id) ?? 0
      );
    }
  }

  /** Record the board nodes at `ms`. A second stamp at the same ms replaces it. */
  function stampNodes(ms: number) {
    if (!adcTrace || !runPlan) return;
    const boards: Record<string, number> = {};
    for (const spec of runPlan.boards) {
      const supplyId = boardPower.get(spec.id)?.supplyId;
      boards[spec.id] = supplyId ? boardVolts(spec.id) : 0;
    }
    const last = adcNodes[adcNodes.length - 1];
    if (last && last.ms === ms) last.boards = boards;
    else adcNodes.push({ ms, boards });
    const cutoff = ms - ADC_TRACE_MS;
    adcNodes = dropOlder(adcNodes, cutoff);
    adcSamples = dropOlder(adcSamples, cutoff);
  }

  function dropOlder<T extends { ms: number }>(rows: T[], cutoff: number): T[] {
    if (rows.length === 0 || (rows[0]?.ms ?? 0) >= cutoff) return rows;
    let drop = 0;
    while (drop < rows.length && (rows[drop]?.ms ?? 0) < cutoff) drop += 1;
    return rows.slice(drop);
  }

  function noteAdc(boardId: string, sample: AdcConversion) {
    adcSamples.push({
      board: boardId,
      ms: simMs() + 1,
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
  function attachAnalog(board: AvrBoard) {
    const spec = runPlan?.boards.find((item) => item.id === board.id);
    if (!spec) return;
    board.setAnalog({
      supply: () => latchedBoardNode(board.id),
      aref: () => 0,
      channel: (channel) => {
        const plan = runPlan;
        if (!plan) return { voltage: 0, rSource: spec.pin.rLeak };
        const bit = channel < 6 ? arduinoPinBit(`A${channel}`) : undefined;
        const mode = bit === undefined ? "analog" : board.driveMode(bit);
        return analogRead({
          plan,
          boardId: board.id,
          channel,
          mode,
          pin: spec.pin,
          boardVolts: latchedBoardNode,
          supplyVolts: (supplyId) => supplyLive[supplyId]?.voltage ?? 0,
          stamped: (ch) => {
            const supplyId = boardPower.get(board.id)?.supplyId;
            const circuit = supplyId ? rails.get(supplyId)?.circuit : undefined;
            return circuit?.probePort(`A${ch}`, board.id) ?? null;
          },
        });
      },
      ...(adcTrace
        ? { converted: (sample: AdcConversion) => noteAdc(board.id, sample) }
        : {}),
    });
  }

  /**
   * What `stepBrownout` sees: the board node at its lowest sub-step.
   * With no Uno cable the board node is the supply terminal.
   */
  function brownoutOf(boardId: string): number {
    const supplyId = boardPower.get(boardId)?.supplyId;
    if (!supplyId) return 0;
    return rails.get(supplyId)?.circuit.boardReading(boardId).min ?? 0;
  }

  /** Fold this step's completed pulses into the latched command. */
  function latchServos() {
    if (!sim) return;
    const simTime = sim.data.time;
    stepPulses.clear();
    for (const board of boards) {
      const taken = board.takePulses();
      if (taken.length > 0) stepPulses.set(board.id, taken);
    }
    for (const load of loads) {
      const drive = load.drive;
      if (!drive?.board) continue;
      const cpu = drive.board;
      const driven = Boolean(cpu.running && !cpu.brownout);
      const taken = driven ? stepPulses.get(cpu.id) : undefined;
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
  function applyTorque() {
    if (!sim) return;
    for (const load of loads) {
      const drive = load.drive;
      const sample = load.sample;
      if (!drive || !sample) continue;
      const cpu = drive.board;
      const powered = load.supplyId !== null;
      const held = cpu !== null && (!cpu.running || cpu.brownout);
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
      sim.data.actuator(load.partId).ctrl = torque;
      if (held) drive.track = blankTrack();
    }
  }

  /** Display state from the sample that solved the rail and the joint after the step. */
  function classifyLoads() {
    if (!sim) return;
    for (const load of loads) {
      const drive = load.drive;
      const sample = load.sample;
      if (!drive || !sample) {
        load.state = "idle";
        load.stallMs = 0;
        continue;
      }
      const omega = scalar(sim.data.jnt(drive.jointName).qvel as Float64Array);
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
      noteBodyEnvelope(load.partId, omega);
    }
  }

  /** Joint speed and applied torque against a body snapshot's shaft bounds. */
  function noteBodyEnvelope(partId: string, speed: number): void {
    if (!sim) return;
    const snap = runPlan?.parts.find(
      (part) => part.id === partId
    )?.bodySnapshot;
    if (!snap) return;
    const torque = sim.data.actuator(partId).ctrl as number;
    const observed: Record<string, number> = {};
    for (const key of Object.keys(snap.bounds)) {
      if (key.endsWith(".speed")) observed[key] = speed;
      else if (key.endsWith(".torque")) observed[key] = torque;
    }
    warnEnvelope(
      partId,
      snap.ref,
      { bounds: snap.bounds, current: [0, 0] },
      observed
    );
  }

  function stepBoard(board: AvrBoard) {
    if (!board.running || board.fault) return;
    try {
      board.stepMillis();
    } catch (err: unknown) {
      board.stop(thrownMessage(err));
    }
    noteFault(board);
  }

  /**
   * One millisecond. Boards that are already running execute first, so this
   * step's pulses are the command. The rail is solved from that command and
   * the joint velocity. A rail below 2.675 V asserts reset on this step.
   * The torque still matches the current charged for the step; the pins
   * are Hi-Z for the recording. After the rail rises above 2.725 V the
   * CPU stays in reset for 66 ms, then the first instruction runs.
   */
  function advanceOne() {
    if (!sim) return;
    if (throwOnStep) {
      throwOnStep = false;
      throw new Error("injected step fault");
    }
    latchSupplyNodes();
    snapshotDriveModes();
    const already = new Set<string>();
    for (const board of boards) {
      const power = boardPower.get(board.id);
      if (!power?.supplyId || power.brownout.phase !== "run") continue;
      stepBoard(board);
      already.add(board.id);
    }
    latchServos();
    solveSupplies();
    const stepEndMs = simMs() + 1;
    for (const board of boards) {
      const power = boardPower.get(board.id);
      if (!power?.supplyId || board.fault) continue;
      const voltage = brownoutOf(board.id);
      const stepped = stepBrownout(power.brownout, voltage, stepEndMs);
      power.brownout = {
        phase: stepped.phase,
        releaseAtMs: stepped.releaseAtMs,
      };
      if (stepped.assertReset) {
        board.holdInReset();
        applyInputNets();
        pendingNotes.push({ kind: "reset", board: board.id });
        continue;
      }
      if (!stepped.reboot) continue;
      if (!board.reboot()) continue;
      applyInputNets();
      const regs = board.peekRegs();
      const pins = board.peekPins();
      power.resets += 1;
      pendingNotes.push({ kind: "reboot", board: board.id });
      if (regs) {
        post({
          type: "brownoutBoot",
          generation,
          board: board.id,
          regs,
          pins,
        });
      }
      rearmServos(board.id, board);
      rearmRangers(board.id, board);
    }
    latchSupplyNodes();
    for (const board of boards) {
      if (already.has(board.id)) continue;
      const power = boardPower.get(board.id);
      if (!power || power.brownout.phase !== "run") continue;
      stepBoard(board);
    }
    // A reboot this step may have produced the first pulses. Latch them
    // before the torque, without solving the rail again: the hold ended
    // on a recovered rail.
    latchServos();
    applyTorque();
    // Targets move after the CPU. A ray cast during this step still sees
    // the pose from the previous master step, the same lag as the ADC latch.
    placeTargets();
    sim.mj.mj_step(sim.model, sim.data);
    noteMotorSeams();
    classifyLoads();
    recordStep();
    stampNodes(simMs());
  }

  /**
   * Joules across the motor seam. Reads the rail's ω and current and the
   * joint speed around the body step. Does not write an engine input.
   */
  function noteMotorSeams(): void {
    if (!sim) return;
    let noted = false;
    for (const load of loads) {
      const drive = load.drive;
      const sample = load.sample;
      if (!drive || !sample) continue;
      const connected = !sample.limp;
      const omegaAfter = scalar(
        sim.data.jnt(drive.jointName).qvel as Float64Array
      );
      const ctrl = sim.data.actuator(load.partId).ctrl as number;
      seams.note({
        path: load.partId,
        dt: SEAM_STEP_S,
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
    const closed = seams.endStep();
    if (!runReport) return;
    const rows = seams.rows();
    if (rows.length === 0) return;
    runReport.seams = rows;
    for (const warning of closed.warnings) runReport.warnings.push(warning);
    if (closed.closed) reportPending = true;
  }

  function dispose() {
    serialChunks.length = 0;
    seams.reset();
    playing = false;
    throwOnStep = false;
    recorder = null;
    layout = null;
    txSeen.clear();
    pendingNotes.length = 0;
    boards = [];
    loads = [];
    rangers = [];
    inputNets = [];
    runPlan = null;
    boardPower = new Map();
    supplySpecs = [];
    partFeeds = {};
    supplyLive = {};
    latchedNode = new Map();
    latchedTerminal = new Map();
    adcNodes = [];
    adcSamples = [];
    rails = new Map();
    driveAtStart.clear();
    stepPulses.clear();
    targetHolds.clear();
    specs = [];
    files = null;
    faulted.clear();
    rxSent.clear();
    if (timer) {
      host.clear(timer);
      timer = null;
    }
    if (!sim) return;
    const going = sim;
    sim = null;
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
    failure = null;
    dispose();
    const root = host.projectReal(project);
    if (!root) {
      fail([
        {
          code: "missing-file",
          path: "",
          message: "The project folder is gone. Hint: open the folder again.",
        },
      ]);
      return false;
    }
    const bytes = host.readInside(root, worldRel);
    if (!bytes) {
      fail([
        {
          code: "missing-file",
          path: "",
          message: `World "${worldRel}" does not exist. Hint: the path is relative to the project.`,
        },
      ]);
      return false;
    }
    worldSha256 = host.sha256(bytes);
    const planned = planWorld(root, worldRel, host.plan);
    if (!planned.ok) {
      fail(planned.errors);
      return false;
    }
    const bytesReader = host.readerFor(root, worldRel);
    const compiled = await compileWorld(planned.plan, bytesReader);
    if (!compiled.ok) {
      fail(compiled.errors);
      return false;
    }
    const data = new compiled.mj.MjData(compiled.model);
    compiled.mj.mj_forward(compiled.model, data);
    sim = { ...compiled, data };
    files = bytesReader;
    playing = false;
    // Feeds are known before boot: an unwired board does not run.
    runPlan = planned.plan;
    runReport = planned.plan.report
      ? structuredClone(planned.plan.report)
      : null;
    degradedLive = [...(planned.plan.degraded ?? [])];
    reportPending = runReport !== null;
    envelopeWarned.clear();
    batteryWarned.clear();
    fillBoardPower(runPlan);
    loadBoards(runPlan);
    bindPower(runPlan);
    bindInputNets(runPlan);
    bindRangers(runPlan);
    // The ranger's idle current is on the node the first CPU step reads.
    solveSupplies();
    latchSupplyNodes();
    openRecorder();
    post({ type: "ready", generation, counts: countsOf(compiled) });
    postState();
    return true;
  }

  function stopClock() {
    playing = false;
    if (timer) {
      host.clear(timer);
      timer = null;
    }
    stepDebt = 0;
  }

  function onTick() {
    timer = null;
    if (!playing || !sim) return;
    try {
      const now = host.now();
      const elapsed = now - lastWall;
      lastWall = now;
      stepDebt += elapsed;
      let steps = Math.floor(stepDebt);
      stepDebt -= steps;
      if (steps > MAX_STEPS_PER_TICK) {
        steps = MAX_STEPS_PER_TICK;
        stepDebt = 0;
      }
      for (let i = 0; i < steps; i++) advanceOne();
      sinceState += elapsed;
      if (sinceState >= STATE_EVERY_MS) {
        sinceState = 0;
        postState();
      }
      if (playing) arm();
    } catch (err: unknown) {
      // A MuJoCo throw must not escape the timer: that kills the API process.
      stopClock();
      fail([], thrownMessage(err));
      try {
        postState();
      } catch {
        /* the error event is the one the host needs */
      }
    }
  }

  function arm() {
    if (timer) return;
    timer = host.schedule(onTick, TICK_MS);
  }

  function play(by?: WorldSender) {
    if (!sim) return;
    noteCommand("play", by);
    playing = true;
    lastWall = host.now();
    stepDebt = 0;
    sinceState = 0;
    arm();
    postState();
  }

  function pause(by?: WorldSender) {
    if (!sim) return;
    noteCommand("pause", by);
    stopClock();
    postState();
  }

  function step(n: number, pauseBy?: WorldSender, request?: number) {
    failure = null;
    if (!sim) return;
    try {
      if (!Number.isInteger(n) || n < 0 || n > MAX_STEP_N) {
        fail(
          [],
          `step(${String(n)}) is not a whole number of steps from 0 to ${MAX_STEP_N}.`
        );
        if (request !== undefined) postState(request);
        return;
      }
      // One turn: stop the clock, then advance exactly n milliseconds.
      if (pauseBy) noteCommand("pause", pauseBy);
      stopClock();
      for (let i = 0; i < n; i++) advanceOne();
      postState(request);
    } catch (err: unknown) {
      stopClock();
      fail([], thrownMessage(err));
      try {
        postState(request);
      } catch {
        /* the error event is already posted */
      }
    }
  }

  /**
   * Command a servo that has no signal wire. The angle is the motor-law
   * command, the same input a pulse would be. A signal wire owns the
   * servo, so this leaves that joint alone.
   */
  function setTarget(partId: string, radians: number) {
    if (!sim) return;
    if (!Number.isFinite(radians)) {
      fail([], `target for "${partId}" is not a finite angle.`);
      return;
    }
    const id = sim.index.parts[partId];
    if (id === undefined) {
      fail([], `no actuator for part "${partId}".`);
      return;
    }
    const drive = loads.find((item) => item.partId === partId)?.drive;
    if (!drive || drive.board) return;
    drive.manualDeg = (radians * 180) / Math.PI;
  }

  /**
   * Write each target's mocap pose for the physics step about to run.
   * `data.time` is still the time of the state the CPU just finished on.
   */
  function placeTargets() {
    if (!sim || !runPlan || runPlan.environment.targets.length === 0) return;
    const pos = sim.data.mocap_pos as Float64Array;
    const quat = sim.data.mocap_quat as Float64Array;
    const time = sim.data.time;
    for (const item of sim.index.targets) {
      const spec = runPlan.environment.targets.find(
        (target) => target.id === item.id
      );
      if (!spec) continue;
      const p = targetPosition(spec, time, targetHolds.get(item.id) ?? null);
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
  function moveTarget(id: string, position: [number, number, number]) {
    if (!sim || !runPlan) return;
    const known = runPlan.environment.targets.some(
      (target) => target.id === id
    );
    if (!known || !position.every((n) => Number.isFinite(n))) return;
    const next: WorldVec3 = [position[0], position[1], position[2]];
    targetHolds.set(id, next);
    recorder?.noteEvent({
      timeMs: simMs(),
      kind: "move-target",
      id,
      position: next,
    });
  }

  function record(query: RecordQuery): RecordBody {
    if (!recorder || !sim) {
      return { op: "error", message: "world is not running" };
    }
    if (query.op === "config") {
      if (query.boundMs !== undefined) recorder.setBoundMs(query.boundMs);
      if (query.enabled !== undefined) recorder.enabled = query.enabled;
      return { op: "ack" };
    }
    if (query.op === "info") {
      return { op: "info", info: recorder.info(sim.data.time) };
    }
    if (query.op === "adc") {
      if (!adcTrace) return { op: "error", message: "ADC trace is off" };
      return { op: "adc", trace: { nodes: adcNodes, samples: adcSamples } };
    }
    if (query.op === "frame") {
      return { op: "frame", id: recorder.id, frame: recorder.frameAt(query.t) };
    }
    if (query.op === "timeline") {
      const info = recorder.info(sim.data.time);
      const read = recorder.read({
        from: query.from,
        to: query.to,
        tracks: [
          ...info.tracks.joints,
          ...info.tracks.supplies,
          ...info.tracks.parts,
        ],
        maxFrames: query.maxPoints,
      });
      const built = timelineFromRead(read);
      return {
        op: "timeline",
        id: info.id,
        from: query.from,
        to: query.to,
        tracks: built.tracks,
        markers: built.markers,
      };
    }
    return {
      op: "read",
      read: recorder.read({
        from: query.from,
        to: query.to,
        ...(query.tracks ? { tracks: query.tracks } : {}),
        ...(query.maxFrames !== undefined
          ? { maxFrames: query.maxFrames }
          : {}),
      }),
    };
  }

  function answerRecord(message: Extract<ToWorker, { type: "record" }>) {
    const body: RecordBody =
      message.generation !== generation
        ? { op: "error", message: "world reloaded" }
        : record(message.query);
    post({
      type: "record",
      generation,
      request: message.request,
      body,
    });
  }

  function heldResult(): LoadResult {
    const held = failure;
    if (!held) return { ok: false, errors: [] };
    return {
      ok: false,
      errors: held.errors,
      ...(held.message !== undefined ? { message: held.message } : {}),
    };
  }

  async function load(input: LoadInput): Promise<LoadResult> {
    generation = input.generation ?? generation + 1;
    project = input.project;
    worldRel = input.world;
    fuseStart = input.fuseStart === "tripped" ? "tripped" : "cold";
    adcTrace = input.adcTrace === true;
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
    if (failure) throw new Error(failureText(failure));
  }

  function drainSerial(): SerialChunk[] {
    const out = serialChunks.slice();
    serialChunks.length = 0;
    return out;
  }

  async function handle(message: ToWorker) {
    if (message.type === "stop") {
      close();
      return;
    }
    if (message.type === "record") {
      answerRecord(message);
      return;
    }
    if (message.generation !== generation && message.type !== "load") {
      if (message.generation < generation) return;
    }
    if (message.type === "load") {
      await load({
        project: message.project,
        world: message.world,
        generation: message.generation,
        fuseStart: message.fuseStart,
        adcTrace: message.adcTrace,
      });
      return;
    }
    generation = message.generation;
    if (message.type === "reload") {
      await reload();
      return;
    }
    if (message.type === "play") play(message.by);
    else if (message.type === "pause") pause(message.by);
    else if (message.type === "step")
      step(message.n, message.pauseBy, message.request);
    else if (message.type === "setTarget")
      setTarget(message.partId, message.radians);
    else if (message.type === "moveTarget")
      moveTarget(message.id, message.position);
    else if (message.type === "reloadBoard") reloadBoard(message.board);
    else if (message.type === "serialIn") {
      serialIn(message.board, message.text, message.by);
    } else if (message.type === "fault") throwOnStep = true;
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length > 0) {
        const message = queue.shift();
        if (!message) break;
        await handle(message);
      }
    } catch (err: unknown) {
      stopClock();
      fail([], thrownMessage(err));
      try {
        postState();
      } catch {
        /* already reported */
      }
    } finally {
      pumping = false;
    }
    // The message that threw was already shifted off. Keep going so a later
    // step or pause queued behind it is not dropped. A second throw is caught
    // on the next pump.
    if (queue.length > 0) void pump();
  }

  function enqueue(message: ToWorker): Promise<void> {
    queue.push(message);
    return pump();
  }

  function branchReading(path: string): {
    current: number;
    voltages: number[];
  } | null {
    const seen = new Set<RailCircuit>();
    for (const group of rails.values()) {
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
    state: sample,
    serialIn,
    drainSerial,
    record,
    setTarget,
    play,
    pause,
    dispose: close,
    branchReading,
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
  /** Advance exactly `n` master steps, then resolve. */
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
