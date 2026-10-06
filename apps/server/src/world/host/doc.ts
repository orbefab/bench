/** The per-document state and the timing constants every host module shares. */

import type { Worker } from "node:worker_threads";
import type {
  RunReport,
  WorldError,
  WorldGhostSpec,
  WorldPinState,
  WorldSender,
  WorldServerMessage,
  WorldState,
} from "@sfab-bench/contract";
import type { CpuResetRegs, SerialRing } from "@sfab-bench/engine-mcu";
import type { FirmwareWatch } from "../files";
import type { RecordBody } from "../worker";

/**
 * One running world per document. Subscribers share play state, sim time,
 * and poses (D-015). The thread goes away when the host stops the document,
 * or after a quiet spell with nobody attached — the same idle idea as the
 * mcu host, with an explicit subscriber list because a world socket detaches.
 */

export const IDLE_MS = 20_000;

export const START_MS = 20_000;

export type WorldSubscription = {
  sender: WorldSender;
  onEvent: (event: WorldServerMessage) => void;
};

/**
 * Internal run options. None of these are stored in the world file.
 */
export type AttachWorldOptions = {
  /**
   * Test only. Default cold. `"tripped"` opens the Uno fuse before the
   * first solve.
   */
  fuseStart?: "cold" | "tripped";
  /**
   * Test only. Record each board node and each ADC sample. Absent, the
   * worker keeps no trace and the adc query errors.
   */
  adcTrace?: boolean;
};

export type WorldHandle = {
  play: (nonce?: string) => void;
  pause: (nonce?: string) => void;
  step: (n: number) => void;
  sendSerial: (
    board: string,
    text: string,
    nonce?: string
  ) => { ok: true } | { error: string };
  /** This subscriber only. Does not broadcast and does not move the run. */
  seek: (
    t: number,
    nonce: string
  ) => Promise<
    Extract<WorldServerMessage, { type: "frame" }> | { error: string }
  >;
  timeline: (query: {
    from: number;
    to: number;
    maxPoints: number;
    tracks?: string[];
  }) => Promise<
    Extract<WorldServerMessage, { type: "timeline-data" }> | { error: string }
  >;
  /** Turn the snapshot ghost on or off. Restarts the run from zero. */
  ghost: (spec: WorldGhostSpec | null) => void;
  detach: () => void;
};

export type Sub = WorldSubscription & { delivered: boolean; detached: boolean };

export type Doc = {
  key: string;
  project: string;
  world: string;
  /** Test only. A tripped fuse starts hot. */
  fuseStart: "cold" | "tripped";
  /** Test only. Absent, the ADC query errors. */
  adcTrace: boolean;
  /** The snapshot ghost the run carries, shared like play state. */
  ghost: WorldGhostSpec | null;
  subs: Set<Sub>;
  worker: Worker | null;
  generation: number;
  lastState: WorldState | null;
  /** Latest run report. Sent with the first state and again if it changes. */
  report: RunReport | null;
  /** How many state snapshots this document has applied. Steps wait on it. */
  stateEpoch: number;
  /** Last play or pause, so a subscriber who attaches later can show who sent it. */
  lastCommand: {
    command: "play" | "pause";
    by: WorldSender;
    nonce?: string;
  } | null;
  errors: WorldError[] | null;
  errorMessage?: string;
  ready: boolean;
  busy: Promise<void> | null;
  idle: ReturnType<typeof setTimeout> | null;
  unwatch: (() => void) | null;
  deps: string[];
  stamp: string;
  firmware: FirmwareWatch[];
  serial: Map<string, SerialRing>;
  rx: Map<string, { queued: number; accepted: number }>;
  /** Bytes this host has handed to the worker since the board last booted. */
  rxSent: Map<string, number>;
  stopping: boolean;
  requestSeq: number;
  pending: Map<
    number,
    {
      resolve: (body: RecordBody) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >;
  /** `world_step` waits on the state its own step message produces. */
  stepSeq: number;
  stepWaiters: Map<number, StepWaiter>;
  /** Registers and pins captured at brownout reboot, before the first instruction. */
  bootSnap: Map<string, { regs: CpuResetRegs; pins: WorldPinState }>;
};

export type StepWaiter = {
  settled: boolean;
  resolve: (result: WorldState | { error: string }) => void;
  timer: ReturnType<typeof setTimeout>;
};

export const BOARD_ID = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

export const STEP_WAIT_MS = 45_000;

export const COMMAND_WAIT_MS = 10_000;
