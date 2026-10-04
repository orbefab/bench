/** The session's shared state: one typed object every domain module reads and writes. */

import type {
  ChipClock,
  Diagnostic,
  JointLimitKind,
  RunReport,
  WorldError,
  WorldPartMotion,
  WorldSupplyState,
  WorldVec3,
} from "@sfab-bench/contract";
import type { CompiledWorld } from "@sfab-bench/engine-body";
import type { AvrBoard } from "@sfab-bench/engine-mcu";
import type { BatteryParams } from "@sfab-bench/parts";
import type { MotorLaw, ResetState } from "../power";
import type { RailCircuit } from "../rail-circuit";
import type { RangerRuntime } from "../ranger";
import type { ServoTrack } from "../servo";
import type {
  AdcNodeStamp,
  AdcSampleStamp,
  SerialChunk,
  SimHost,
  ToWorker,
} from "../sim";
import type { gpioInputNets, PowerFeeds } from "../wiring";
import type { ControlRuntime, ShaftRuntime } from "./shafts";

export type LiveWorld = CompiledWorld & {
  data: InstanceType<CompiledWorld["mj"]["MjData"]>;
};

export type WorldBytes = { read(relativeToWorld: string): Uint8Array | null };

export type HeldFailure = { errors: WorldError[]; message?: string };

import type { PinMode } from "@sfab-bench/engine-circuit";
import type { RunPlan } from "../plan";
import type { RunRecorder } from "../record";
import { SeamLedger } from "../seams";

export type BoardSpec = {
  id: string;
  chip: string;
  firmware: string;
  /** The chip part's SOA band floor, volts. Null: no band. */
  minOperatingVoltage: number | null;
  /** The chip's name and clock for the SOA warning. Null: not registered. */
  clock: ChipClock | null;
  /** Chip pin name per pin-state index, from the board's `expose`. */
  wire: readonly string[];
  /** Pins the board names (its `pinOrder`). `wire` may add internal drives. */
  pinCount: number;
};

export type ServoDrive = {
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
export type ServoSample = {
  limp: boolean;
  saturated: boolean;
  errorRad: number;
  omega: number;
  fraction: number;
};

export type Load = {
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

export type BoardPower = {
  supplyId: string | null;
  /** Catalog amperes while a supply is connected, including during reset. */
  draw: number;
  /** Nominal BOD level, for the out-of-SOA warning. */
  brownoutVoltage: number;
  assertVoltage: number;
  releaseVoltage: number;
  /** Milliseconds reset stays after the rail releases. */
  holdMs: number;
  resets: number;
  reset: ResetState;
};

export type SupplySpec = {
  id: string;
  voltage: number;
  currentLimit: number;
  rSeries: number;
  /** Set for `battery@1`. The rail stamps this instead of the three numbers. */
  battery?: BatteryParams;
  /** `ideal-voltage@1`. The rail stamps a voltage source. */
  ideal?: boolean;
};

export type RailGroup = {
  circuit: RailCircuit;
  loads: Load[];
  /** Sub-step minimum of the board node. */
  boardMin: number;
};

export type RecLayout = {
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

export type SessionState = {
  readonly host: SimHost;
  generation: number;
  project: string;
  worldRel: string;
  failure: HeldFailure | null;
  readonly serialChunks: SerialChunk[];
  sim: LiveWorld | null;
  /** Agent moves. A held target ignores its path from the next master step. */
  readonly targetHolds: Map<string, WorldVec3>;
  files: WorldBytes | null;
  specs: BoardSpec[];
  boards: AvrBoard[];
  loads: Load[];
  /** `servo-control@1` parts, bound after the rails. */
  controls: ControlRuntime[];
  /** Joints circuit parts turn or read, bound after the rails. */
  shafts: ShaftRuntime[];
  rangers: RangerRuntime[];
  boardPower: Map<string, BoardPower>;
  supplySpecs: SupplySpec[];
  partFeeds: PowerFeeds["parts"];
  /**
   * Voltage and current used for the step in progress. Filled from the
   * previous step's part states before the CPUs and the joint move.
   */
  supplyLive: Record<string, WorldSupplyState>;
  /**
   * Board node each CPU sees during its step. Latched before the CPUs run,
   * so the ADC is at most one master step behind the rail. Latched again
   * after the solve, before a board that just left reset executes.
   */
  latchedNode: Map<string, number>;
  /**
   * Each supply's rail node (`boardNodeOf`), for a part with no power
   * board. Latched with the board nodes.
   */
  latchedRail: Map<string, number>;
  adcNodes: AdcNodeStamp[];
  adcSamples: AdcSampleStamp[];
  /** Test only. Absent on load, stamps and samples are not allocated. */
  adcTrace: boolean;
  /** Test only. A tripped fuse starts hot, before the first solve. */
  fuseStart: "cold" | "tripped";
  rails: Map<string, RailGroup>;
  /** Reused each step. Cleared at the start of the voltage and pulse passes. */
  readonly stepPulses: Map<string, { bit: number; us: number }[]>;
  readonly faulted: Set<string>;
  readonly rxSent: Map<string, string>;
  playing: boolean;
  timer: unknown;
  lastWall: number;
  /** Master steps per simulated millisecond (`stepsPerMs` of the run's step). */
  perMs: number;
  stepDebt: number;
  sinceState: number;
  readonly queue: ToWorker[];
  pumping: boolean;
  /** Test-only. The next `step` throws once, inside the sim loop. */
  throwOnStep: boolean;
  recorder: RunRecorder | null;
  recordingSeq: number;
  worldSha256: string;
  runPlan: RunPlan | null;
  runReport: RunReport | null;
  readonly seams: SeamLedger;
  /** Degraded parts for this load. Copied onto the live state. */
  degradedLive: Diagnostic[];
  reportPending: boolean;
  readonly envelopeWarned: Set<string>;
  /** One empty-battery warning per supply, for this load of the world. */
  readonly batteryWarned: Set<string>;
  readonly firmwareSha: Map<string, string>;
  inputNets: ReturnType<typeof gpioInputNets>;
  applyingInputs: boolean;
  /**
   * Per board, how much of its unflushed serial the recording has noted.
   * Whoever drains the board's serial sets it back to 0.
   */
  readonly txSeen: Map<string, number>;
  /** `cause` is set only on a reset the RESET pin asserted. */
  readonly pendingNotes: {
    kind: "reset" | "reboot";
    board: string;
    cause?: "pin";
  }[];
  layout: RecLayout | null;
  /** Drive mode of each stamped pin at the start of this millisecond. */
  readonly driveAtStart: Map<string, Map<number, PinMode>>;
};

export function createState(host: SimHost): SessionState {
  return {
    host,
    generation: 0,
    project: "",
    worldRel: "",
    failure: null,
    serialChunks: [],
    sim: null,
    targetHolds: new Map<string, WorldVec3>(),
    files: null,
    specs: [],
    boards: [],
    loads: [],
    controls: [],
    shafts: [],
    rangers: [],
    boardPower: new Map<string, BoardPower>(),
    supplySpecs: [],
    partFeeds: {},
    supplyLive: {},
    latchedNode: new Map<string, number>(),
    latchedRail: new Map<string, number>(),
    adcNodes: [],
    adcSamples: [],
    adcTrace: false,
    fuseStart: "cold",
    rails: new Map<string, RailGroup>(),
    stepPulses: new Map<string, { bit: number; us: number }[]>(),
    faulted: new Set<string>(),
    rxSent: new Map<string, string>(),
    playing: false,
    timer: null,
    lastWall: 0,
    perMs: 1,
    stepDebt: 0,
    sinceState: 0,
    queue: [],
    pumping: false,
    throwOnStep: false,
    recorder: null,
    recordingSeq: 0,
    worldSha256: "",
    runPlan: null,
    runReport: null,
    seams: new SeamLedger(),
    degradedLive: [],
    reportPending: false,
    envelopeWarned: new Set<string>(),
    batteryWarned: new Set<string>(),
    firmwareSha: new Map<string, string>(),
    inputNets: [],
    applyingInputs: false,
    txSeen: new Map<string, number>(),
    pendingNotes: [],
    layout: null,
    driveAtStart: new Map<string, Map<number, PinMode>>(),
  };
}
