import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { parentPort } from "node:worker_threads";

import {
  ATMEGA328P_16MHZ_MIN_V,
  arduinoPinBit,
  atmega328pSoaWarning,
  type JointLimitKind,
  pastLimitAmount,
  RECORD_FRAME_MS,
  type RecordedFrame,
  type RecordingInfo,
  type RecordingManifest,
  type RecordingPartCatalog,
  type RecordingRead,
  type TimelineMarker,
  type TimelineTrack,
  type WorldError,
  type WorldPartMotion,
  type WorldPartState,
  type WorldPinState,
  type WorldSender,
  type WorldState,
  type WorldSupplyState,
} from "@sfab-bench/contract";

import { AvrBoard, type CpuResetRegs, FIRMWARE_RELOADED } from "./board";
import { projectReal, readerFor, readInside, type WorldBytes } from "./files";
import { parseIntelHex } from "./ihex";
import {
  type CompiledWorld,
  compileWorld,
  type WorldModelCounts,
} from "./model";
import { planWorld, type RunPlan } from "./plan";
import {
  type BrownoutState,
  DISPLAY_STALL_DEG_PER_SEC,
  displayMotion,
  type MotorLaw,
  runningBrownout,
  stepBrownout,
} from "./power";
import { type BoardPathName, isFirmwareBoard, usbPathFor } from "./power-path";
import { createRailCircuit, type RailCircuit } from "./rail-circuit";
import { motionRank, RunRecorder, timelineFromRead } from "./record";
import { blankTrack, type ServoTrack, trackServo } from "./servo";
import {
  applyGpioDrives,
  gpioInputNets,
  type PowerFeeds,
  powerFeedsOf,
  servoSignalDrives,
} from "./wiring";

const require = createRequire(import.meta.url);

function packageVersion(name: string): string {
  try {
    let dir = dirname(require.resolve(name));
    for (let hop = 0; hop < 6; hop++) {
      const pkgPath = join(dir, "package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === name) return pkg.version ?? "unknown";
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* the manifest says unknown rather than failing the run */
  }
  return "unknown";
}

const MUJOCO_VERSION = packageVersion("@mujoco/mujoco");
const AVR8JS_VERSION = packageVersion("avr8js");

const INTEGRATORS = [
  "euler",
  "rk4",
  "implicit",
  "implicitfast",
  "discrete",
] as const;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

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
  | { op: "config"; boundMs?: number; enabled?: boolean };

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
  | { op: "error"; message: string };

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

type Sim = CompiledWorld & {
  data: InstanceType<CompiledWorld["mj"]["MjData"]>;
};

const port = parentPort;
type BoardSpec = { id: string; chip: string; firmware: string };

let generation = 0;
let project = "";
let worldRel = "";
let sim: Sim | null = null;
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
};

let loads: Load[] = [];
let boardPower = new Map<string, BoardPower>();
let supplySpecs: SupplySpec[] = [];
let partFeeds: PowerFeeds["parts"] = {};
/**
 * Voltage and current used for the step in progress. Filled from the
 * previous step's part states before the CPUs and the joint move.
 */
let supplyLive: Record<string, WorldSupplyState> = {};
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
let timer: ReturnType<typeof setTimeout> | null = null;
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
  supplies: SupplySpec[];
  boards: string[];
};

let layout: RecLayout | null = null;

function thrownMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function post(message: FromWorker) {
  port?.postMessage(message);
}

function fail(errors: WorldError[], message?: string) {
  post({ type: "error", generation, errors, ...(message ? { message } : {}) });
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
    const node = power?.supplyId ? boardNodeOf(power.supplyId) : 0;
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
      ...ledReading(power?.supplyId),
      ...(soa ? { warnings: [soa] } : {}),
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
      voltage: load.supplyId ? boardNodeOf(load.supplyId) : 0,
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
    rec.pastLimit[i] = pastLimitAmount(qpos, spec.lower, spec.upper, spec.kind);
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
    rec.partVoltage[i] = load.supplyId ? boardNodeOf(load.supplyId) : 0;
  }
  for (let i = 0; i < lay.supplies.length; i++) {
    const spec = lay.supplies[i];
    const live = spec ? supplyLive[spec.id] : undefined;
    rec.voltage[i] = live?.voltage ?? 0;
    rec.supplyCurrent[i] = live?.current ?? 0;
  }
  for (let i = 0; i < lay.boards.length; i++) {
    const id = lay.boards[i];
    const board = boards.find((item) => item.id === id);
    const power = id ? boardPower.get(id) : undefined;
    rec.boardVoltage[i] = power?.supplyId ? boardNodeOf(power.supplyId) : 0;
    if (rec.ledOn[i]) {
      rec.ledCurrent[i] = power?.supplyId
        ? (ledCurrentOf(power.supplyId) ?? 0)
        : 0;
    }
    rec.brownout[i] = board?.brownout ? 1 : 0;
    rec.belowSoa[i] = board && boardInSoa(board) ? 1 : 0;
  }
}

function boardInSoa(board: AvrBoard): boolean {
  if (!board.running || board.brownout || board.fault) return false;
  const spec = specs.find((item) => item.id === board.id);
  if (spec?.chip !== "atmega328p") return false;
  const power = boardPower.get(board.id);
  if (!power?.supplyId) return false;
  const voltage = boardNodeOf(power.supplyId);
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
  layout = { joints, bodies, parts, supplies: supplySpecs, boards: boardIds };
  recordingSeq += 1;
  recorder = new RunRecorder({
    id: `r${recordingSeq}`,
    manifest: manifestOf(),
    joints: joints.map(({ robot, joint }) => ({ robot, joint })),
    bodies: bodies.map(({ robot, link }) => ({ robot, link })),
    parts: parts.map((load) => load.partId),
    supplies: supplySpecs.map((supply) => supply.id),
    boards: boardIds,
    boardLed: boardIds.map(
      (id) =>
        runPlan?.boards.find((board) => board.id === id)?.boardCircuit ===
        "nano-usb"
    ),
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
    mujoco: MUJOCO_VERSION,
    avr8js: AVR8JS_VERSION,
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
  if (chunks.length > 0) post({ type: "serial", generation, chunks });
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
  });
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

function bootBoard(spec: BoardSpec): AvrBoard {
  const board = new AvrBoard(spec.id);
  // No supply: the CPU never starts. A later step does not boot it either.
  if (!boardPower.get(spec.id)?.supplyId) return board;
  if (spec.chip !== "atmega328p") {
    board.stop(`unsupported chip "${spec.chip}"`);
    return board;
  }
  const bytes = files?.read(spec.firmware);
  if (!bytes) {
    board.stop(`firmware "${spec.firmware}" does not exist`);
    return board;
  }
  firmwareSha.set(spec.id, sha256(bytes));
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
    };
    loads.push(load);
  }
  bindRails();
  solveSupplies();
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
  for (const supply of supplySpecs) {
    const members = groups.get(supply.id) ?? [];
    const fed = boardOn(supply.id);
    const path = fed
      ? usbPathFor(supplyTypeOf(supply.id), fed.type, fed.circuit)
      : null;
    const circuit = createRailCircuit({
      vNom: supply.voltage,
      rSeries: supply.rSeries,
      iLimit: supply.currentLimit,
      motors: members.map((load) => {
        const drive = load.drive;
        if (!drive) throw new Error("rail motor has no drive");
        return {
          resistance: drive.law.resistance,
          k: drive.law.k,
        };
      }),
      ...(path ? { boardPath: path } : {}),
    });
    if (path === "uno-usb" && fuseStart === "tripped") circuit.tripFuse();
    for (let i = 0; i < members.length; i++) {
      const load = members[i];
      if (load) load.railSlot = i;
    }
    rails.set(supply.id, { circuit, loads: members, path, boardMin: 0 });
  }
}

function supplyTypeOf(supplyId: string): string {
  return runPlan?.supplies.find((item) => item.id === supplyId)?.type ?? "";
}

/** The fed board, when this supply powers a firmware board. */
function boardOn(
  supplyId: string
): { type: string; circuit: string | null } | null {
  if (!runPlan) return null;
  for (const board of runPlan.boards) {
    if (!isFirmwareBoard(board.type)) continue;
    if (boardPower.get(board.id)?.supplyId === supplyId) {
      return { type: board.type, circuit: board.boardCircuit };
    }
  }
  return null;
}

/** The Nano whose class-2 path this supply inserted, if it did. */
function nanoBoard(supplyId: string): AvrBoard | null {
  if (!runPlan) return null;
  for (const board of runPlan.boards) {
    if (board.boardCircuit !== "nano-usb") continue;
    if (boardPower.get(board.id)?.supplyId !== supplyId) continue;
    return boards.find((item) => item.id === board.id) ?? null;
  }
  return null;
}

/** D13 LED current, present while a class-2 Nano path is in the rail. */
function ledCurrentOf(supplyId: string): number | undefined {
  const group = rails.get(supplyId);
  if (group?.path !== "nano-usb" && group?.path !== "nano-5v") return undefined;
  return group.circuit.ledCurrent;
}

function ledReading(
  supplyId: string | null | undefined
): { ledCurrent: number } | Record<string, never> {
  if (!supplyId) return {};
  const current = ledCurrentOf(supplyId);
  return current === undefined ? {} : { ledCurrent: current };
}

function solveOneRail(
  supplyId: string,
  fixed: number
): { voltage: number; current: number; board: number; boardMin: number } {
  const group = rails.get(supplyId);
  if (!group) return { voltage: 0, current: 0, board: 0, boardMin: 0 };
  const { circuit, loads: members } = group;
  circuit.setFixed(fixed);
  const avr = nanoBoard(supplyId);
  if (avr) {
    const bit = arduinoPinBit("D13");
    const pins = avr.peekPins();
    const driving = bit !== undefined && (pins.ddr & (1 << bit)) !== 0;
    const high = bit !== undefined && (pins.level & (1 << bit)) !== 0;
    circuit.setD13(!driving ? "input" : high ? "high" : "low");
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
  circuit.solve();
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
 * Rail for this step, from the latched command and the joint velocity.
 * A powered servo always contributes its quiescent current. A driven
 * one also contributes `max(0, s·I_motor)`.
 */
function solveSupplies() {
  for (const load of loads) sampleLoad(load);
  const next: Record<string, WorldSupplyState> = {};
  for (const supply of supplySpecs) {
    let fixed = 0;
    for (const power of boardPower.values()) {
      if (power.supplyId !== supply.id) continue;
      fixed += power.draw;
    }
    for (const load of loads) {
      if (load.supplyId !== supply.id) continue;
      fixed += load.quiescent;
    }
    const solved = solveOneRail(supply.id, fixed);
    // The supply record is the terminal. The board node is reported on
    // the board, and a servo's V+ is that same node.
    next[supply.id] = { voltage: solved.voltage, current: solved.current };
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
  // The new image has not run, and this board's servos are idle. Publish
  // the rail those currents actually draw. A sag still under the assert
  // threshold holds the new CPU in reset. A firmware reload is not a
  // brown-out delay: once the rail is up, the image runs.
  solveSupplies();
  const power = boardPower.get(id);
  if (power?.supplyId && !next.fault) {
    const voltage = brownoutOf(power.supplyId);
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

/**
 * What `stepBrownout` sees: the board node at its lowest sub-step.
 * With no Uno cable the board node is the supply terminal.
 */
function brownoutOf(id: string): number {
  return rails.get(id)?.boardMin ?? 0;
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
  }
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
    const voltage = brownoutOf(power.supplyId);
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
  }
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
  sim.mj.mj_step(sim.model, sim.data);
  classifyLoads();
  recordStep();
}

function dispose() {
  playing = false;
  throwOnStep = false;
  recorder = null;
  layout = null;
  txSeen.clear();
  pendingNotes.length = 0;
  boards = [];
  loads = [];
  inputNets = [];
  runPlan = null;
  boardPower = new Map();
  supplySpecs = [];
  partFeeds = {};
  supplyLive = {};
  rails = new Map();
  stepPulses.clear();
  specs = [];
  files = null;
  faulted.clear();
  rxSent.clear();
  if (timer) {
    clearTimeout(timer);
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
  dispose();
  const root = projectReal(project);
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
  const bytes = readInside(root, worldRel);
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
  worldSha256 = sha256(bytes);
  const planned = planWorld(root, worldRel);
  if (!planned.ok) {
    fail(planned.errors);
    return false;
  }
  const bytesReader = readerFor(root, worldRel);
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
  fillBoardPower(runPlan);
  loadBoards(runPlan);
  bindPower(runPlan);
  bindInputNets(runPlan);
  openRecorder();
  post({ type: "ready", generation, counts: countsOf(compiled) });
  postState();
  return true;
}

function stopClock() {
  playing = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  stepDebt = 0;
}

function onTick() {
  timer = null;
  if (!playing || !sim) return;
  try {
    const now = performance.now();
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
  timer = setTimeout(onTick, TICK_MS);
}

function play(by?: WorldSender) {
  if (!sim) return;
  noteCommand("play", by);
  playing = true;
  lastWall = performance.now();
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

function answerRecord(message: Extract<ToWorker, { type: "record" }>) {
  const reply = (body: RecordBody) => {
    post({
      type: "record",
      generation,
      request: message.request,
      body,
    });
  };
  if (message.generation !== generation || !recorder || !sim) {
    reply({
      op: "error",
      message:
        message.generation !== generation
          ? "world reloaded"
          : "world is not running",
    });
    return;
  }
  const query = message.query;
  if (query.op === "config") {
    if (query.boundMs !== undefined) recorder.setBoundMs(query.boundMs);
    if (query.enabled !== undefined) recorder.enabled = query.enabled;
    reply({ op: "ack" });
    return;
  }
  if (query.op === "info") {
    reply({ op: "info", info: recorder.info(sim.data.time) });
    return;
  }
  if (query.op === "frame") {
    reply({ op: "frame", id: recorder.id, frame: recorder.frameAt(query.t) });
    return;
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
    reply({
      op: "timeline",
      id: info.id,
      from: query.from,
      to: query.to,
      tracks: built.tracks,
      markers: built.markers,
    });
    return;
  }
  reply({
    op: "read",
    read: recorder.read({
      from: query.from,
      to: query.to,
      ...(query.tracks ? { tracks: query.tracks } : {}),
      ...(query.maxFrames !== undefined ? { maxFrames: query.maxFrames } : {}),
    }),
  });
}

async function handle(message: ToWorker) {
  if (message.type === "stop") {
    stopClock();
    dispose();
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
    generation = message.generation;
    project = message.project;
    worldRel = message.world;
    fuseStart = message.fuseStart === "tripped" ? "tripped" : "cold";
    await build();
    return;
  }
  generation = message.generation;
  if (message.type === "reload") {
    stopClock();
    await build();
    return;
  }
  if (message.type === "play") play(message.by);
  else if (message.type === "pause") pause(message.by);
  else if (message.type === "step")
    step(message.n, message.pauseBy, message.request);
  else if (message.type === "setTarget")
    setTarget(message.partId, message.radians);
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

if (port) {
  port.on("message", (message: ToWorker) => {
    queue.push(message);
    void pump();
  });
}
