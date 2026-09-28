import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import {
  isRunDocumentPath,
  type RecordedFrame,
  type RecordingInfo,
  type RecordingRead,
  type RunReport,
  SERIAL_TEXT_MAX,
  type WorldError,
  type WorldPinState,
  type WorldSender,
  type WorldServerMessage,
  type WorldState,
} from "@sfab-bench/contract";

import {
  type CpuResetRegs,
  RX_BACKLOG,
  type SerialPage,
  SerialRing,
} from "@sfab-bench/engine-mcu";

import { healTornWrite } from "@sfab-bench/parts";

import { subscribeRootWatch } from "../projects";
import {
  dependencyRels,
  dependencyStamp,
  type FirmwareWatch,
  firmwareWatch,
  projectReal,
  resolveInside,
} from "./files";
import { nodeStore } from "./node-store";
import type {
  AdcTrace,
  FromWorker,
  RecordBody,
  RecordQuery,
  ToWorker,
} from "./worker";

/**
 * One running world per document. Subscribers share play state, sim time,
 * and poses (D-015). The thread goes away when the host stops the document,
 * or after a quiet spell with nobody attached — the same idle idea as the
 * mcu host, with an explicit subscriber list because a world socket detaches.
 */

const IDLE_MS = 20_000;
const START_MS = 20_000;

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
  }) => Promise<
    Extract<WorldServerMessage, { type: "timeline-data" }> | { error: string }
  >;
  detach: () => void;
};

type Sub = WorldSubscription & { delivered: boolean; detached: boolean };

type Doc = {
  key: string;
  project: string;
  world: string;
  /** Test only. A tripped fuse starts hot. */
  fuseStart: "cold" | "tripped";
  /** Test only. Absent, the ADC query errors. */
  adcTrace: boolean;
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

type StepWaiter = {
  settled: boolean;
  resolve: (result: WorldState | { error: string }) => void;
  timer: ReturnType<typeof setTimeout>;
};

const docs = new Map<string, Doc>();
const liveWorkers = new Set<Worker>();

export function worldWorkerCount(): number {
  return liveWorkers.size;
}

/** Bundled, the worker sits beside the server bundle. From a checkout it is the TypeScript next to this file, which tsx loads. */
export function worldWorkerEntry(): string {
  for (const rel of ["./world-worker.mjs", "./worker.ts"]) {
    const candidate = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("the world worker is missing beside the server bundle");
}

function docKey(
  project: string,
  worldRel: string
): { key: string; project: string; world: string } | { error: string } {
  const root = projectReal(project);
  if (!root) return { error: "the project folder is gone" };
  const world = worldRel.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!world || !isRunDocumentPath(world)) {
    return { error: "not a world document" };
  }
  if (world.split("/").includes("..")) {
    return { error: "path escapes the project" };
  }
  return { key: `${root}\0${world}`, project: root, world };
}

/** Tell every subscriber. No-op when that world is not open. */
export function publishWorldEvent(
  project: string,
  worldRel: string,
  event: WorldServerMessage
): void {
  const found = docKey(project, worldRel);
  if ("error" in found) return;
  const doc = docs.get(found.key);
  if (!doc) return;
  broadcast(doc, event);
}

function broadcast(doc: Doc, event: WorldServerMessage) {
  for (const sub of doc.subs) {
    if (sub.detached) continue;
    sub.delivered = true;
    try {
      sub.onEvent(structuredClone(event));
    } catch {
      /* a subscriber that throws does not stop the others */
    }
  }
}

function snapshot(doc: Doc): WorldServerMessage | null {
  if (doc.errors) {
    return {
      type: "error",
      errors: doc.errors,
      ...(doc.errorMessage ? { message: doc.errorMessage } : {}),
    };
  }
  if (doc.lastState) {
    return {
      type: "state",
      state: doc.lastState,
      ...(doc.report ? { report: doc.report } : {}),
    };
  }
  return null;
}

function commandEvent(
  command: "play" | "pause",
  by: WorldSender,
  nonce?: string
): WorldServerMessage {
  return {
    type: "command",
    command,
    by,
    ...(nonce ? { nonce } : {}),
  };
}

function announce(
  doc: Doc,
  command: "play" | "pause",
  by: WorldSender,
  nonce?: string
) {
  doc.lastCommand = { command, by, ...(nonce ? { nonce } : {}) };
  broadcast(doc, commandEvent(command, by, nonce));
}

function sendSnapshot(sub: Sub, doc: Doc) {
  const event = snapshot(doc);
  if (event) {
    sub.delivered = true;
    sub.onEvent(structuredClone(event));
  }
  // The command follows the state, so a late joiner sees who last played
  // or paused without folding that into the physics snapshot.
  // A runtime fault sets `errorMessage` only. The state snapshot above
  // does not carry it, so send the fault as its own error event.
  if (event?.type === "state" && doc.errorMessage) {
    sub.delivered = true;
    sub.onEvent(
      structuredClone({
        type: "error",
        errors: [],
        message: doc.errorMessage,
      } satisfies WorldServerMessage)
    );
  }
  if (event?.type === "state" && doc.lastCommand) {
    sub.delivered = true;
    sub.onEvent(
      structuredClone(
        commandEvent(
          doc.lastCommand.command,
          doc.lastCommand.by,
          doc.lastCommand.nonce
        )
      )
    );
  }
  if (event?.type === "state") sendSerialTails(sub, doc);
}

function ringOf(doc: Doc, board: string): SerialRing {
  let ring = doc.serial.get(board);
  if (!ring) {
    ring = new SerialRing();
    doc.serial.set(board, ring);
  }
  return ring;
}

function sendSerialTails(sub: Sub, doc: Doc) {
  for (const id of Object.keys(doc.lastState?.boards ?? {})) {
    const ring = doc.serial.get(id);
    if (!ring || ring.next === 0) continue;
    const page = ring.tail(SERIAL_TEXT_MAX);
    if (!page.text) continue;
    sub.delivered = true;
    sub.onEvent(
      structuredClone({
        type: "serial",
        board: id,
        text: page.text,
        next: page.next,
      } satisfies WorldServerMessage)
    );
  }
}

function resetSerial(doc: Doc) {
  doc.serial = new Map();
  doc.rx = new Map();
  doc.rxSent = new Map();
}

function clearRxBook(doc: Doc, board: string) {
  doc.rx.delete(board);
  doc.rxSent.delete(board);
}

function refreshDeps(doc: Doc) {
  doc.deps = dependencyRels(doc.project, doc.world);
  doc.stamp = dependencyStamp(doc.project, doc.deps);
}

function tie(doc: Doc) {
  if (!doc.worker) return;
  if (doc.subs.size > 0) doc.worker.ref();
  else doc.worker.unref();
}

function armIdle(doc: Doc) {
  if (doc.idle) clearTimeout(doc.idle);
  if (doc.subs.size > 0) {
    doc.idle = null;
    return;
  }
  doc.idle = setTimeout(() => {
    void stopKey(doc.key);
  }, IDLE_MS);
  doc.idle.unref();
}

function failPending(doc: Doc, message: string) {
  for (const waiter of doc.pending.values()) {
    clearTimeout(waiter.timer);
    waiter.resolve({ op: "error", message });
  }
  doc.pending.clear();
}

function settleStep(
  waiter: StepWaiter,
  result: WorldState | { error: string }
) {
  if (waiter.settled) return;
  waiter.settled = true;
  clearTimeout(waiter.timer);
  waiter.resolve(result);
}

function failStepWaiters(doc: Doc, message: string) {
  for (const waiter of doc.stepWaiters.values()) {
    settleStep(waiter, { error: message });
  }
  doc.stepWaiters.clear();
}

async function killWorker(doc: Doc): Promise<void> {
  const worker = doc.worker;
  failPending(doc, "world stopped");
  failStepWaiters(doc, "world is not running");
  if (!worker) return;
  doc.worker = null;
  doc.stopping = true;
  try {
    worker.postMessage({ type: "stop" } satisfies ToWorker);
  } catch {
    /* already gone */
  }
  const exited = new Promise<void>((resolve) => {
    worker.once("exit", () => resolve());
  });
  await worker.terminate();
  await exited;
  doc.stopping = false;
}

/**
 * The thread is gone. Drop it from the live set and remember the failure
 * so the next attach, or a file change, can build again. Idempotent:
 * `error` and `exit` both call this, and the second one finds no worker.
 */
function markWorkerFailed(doc: Doc, worker: Worker, message: string) {
  liveWorkers.delete(worker);
  if (doc.worker !== worker) return;
  doc.worker = null;
  if (doc.stopping) return;
  failStepWaiters(doc, "world is not running");
  doc.errors = [];
  doc.errorMessage = message;
  doc.lastState = null;
  doc.report = null;
  broadcast(doc, { type: "error", errors: [], message });
}

function listen(doc: Doc, worker: Worker) {
  worker.on("message", (message: FromWorker) => {
    if (message.generation !== doc.generation) return;
    if (message.type === "record") {
      const waiter = doc.pending.get(message.request);
      if (!waiter || message.generation !== doc.generation) return;
      clearTimeout(waiter.timer);
      doc.pending.delete(message.request);
      waiter.resolve(message.body);
      return;
    }
    if (message.type === "state") {
      doc.lastState = message.state;
      if (message.report) doc.report = message.report;
      doc.stateEpoch += 1;
      doc.errors = null;
      // A caught step fault stays until the run is playing again. The
      // paused state posted right after the fault must not clear it.
      if (message.state.playing) doc.errorMessage = undefined;
      if (message.request !== undefined) {
        const waiter = doc.stepWaiters.get(message.request);
        if (waiter) {
          doc.stepWaiters.delete(message.request);
          settleStep(waiter, message.state);
        }
      }
      broadcast(doc, {
        type: "state",
        state: message.state,
        ...(message.report ? { report: message.report } : {}),
      });
      return;
    }
    if (message.type === "serial") {
      for (const chunk of message.chunks) {
        const ring = ringOf(doc, chunk.board);
        const before = ring.next;
        ring.append(chunk.text);
        const page = ring.read(before);
        broadcast(doc, {
          type: "serial",
          board: chunk.board,
          text: page.text,
          next: page.next,
        });
      }
      return;
    }
    if (message.type === "brownoutBoot") {
      doc.bootSnap.set(message.board, {
        regs: message.regs,
        pins: message.pins,
      });
      // The marker is already in the serial stream. Keep the ring text.
      clearRxBook(doc, message.board);
      return;
    }
    if (message.type === "boardReset") {
      clearRxBook(doc, message.board);
      const ring = ringOf(doc, message.board);
      ring.clear(message.marker);
      const page = ring.read(ring.next - message.marker.length);
      broadcast(doc, {
        type: "serial",
        board: message.board,
        text: page.text || message.marker,
        next: ring.next,
      });
      return;
    }
    if (message.type === "boardFault") {
      clearRxBook(doc, message.board);
      broadcast(doc, {
        type: "board-error",
        board: message.board,
        message: message.message,
      });
      return;
    }
    if (message.type === "rx") {
      doc.rx.set(message.board, {
        queued: message.queued,
        accepted: message.accepted,
      });
      return;
    }
    if (message.type === "error") {
      doc.errorMessage = message.message;
      if (message.errors.length > 0) {
        doc.errors = message.errors;
        doc.lastState = null;
        doc.report = null;
      }
      broadcast(doc, {
        type: "error",
        errors: message.errors,
        ...(message.message ? { message: message.message } : {}),
      });
    }
  });
  // An unhandled worker exception emits `error`. With no listener, Node 24
  // takes down the parent. Never rethrow.
  worker.on("error", (err: Error) => {
    console.error("[world]", err);
    markWorkerFailed(doc, worker, err.message);
  });
  worker.on("exit", () => {
    markWorkerFailed(doc, worker, "world worker exited");
  });
}

function waitForResult(worker: Worker, generation: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("world did not start"));
    }, START_MS);
    const onMessage = (message: FromWorker) => {
      if (message.generation !== generation) return;
      if (message.type !== "state" && message.type !== "error") return;
      cleanup();
      resolve();
    };
    const onExit = (code: number) => {
      cleanup();
      reject(new Error(`world worker exited (${code})`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      worker.off("message", onMessage);
      worker.off("exit", onExit);
    };
    worker.on("message", onMessage);
    worker.on("exit", onExit);
  });
}

async function spawn(doc: Doc): Promise<void> {
  await killWorker(doc);
  const worker = new Worker(worldWorkerEntry());
  liveWorkers.add(worker);
  doc.worker = worker;
  doc.generation += 1;
  failStepWaiters(doc, "world reloaded");
  resetSerial(doc);
  const generation = doc.generation;
  listen(doc, worker);
  const pending = waitForResult(worker, generation);
  worker.postMessage({
    type: "load",
    project: doc.project,
    world: doc.world,
    generation,
    ...(doc.fuseStart === "tripped" ? { fuseStart: "tripped" as const } : {}),
    ...(doc.adcTrace ? { adcTrace: true as const } : {}),
  } satisfies ToWorker);
  tie(doc);
  try {
    await pending;
  } catch (err: unknown) {
    // `error`/`exit` already told subscribers. Don't broadcast a second time.
    if (!doc.worker && doc.errorMessage) return;
    await killWorker(doc);
    const message = err instanceof Error ? err.message : String(err);
    doc.errors = [];
    doc.errorMessage = message;
    doc.lastState = null;
    doc.report = null;
    broadcast(doc, { type: "error", errors: [], message });
    return;
  }
  if (doc.errors && doc.errors.length > 0) await killWorker(doc);
}

async function reload(doc: Doc): Promise<void> {
  const worker = doc.worker;
  if (!worker) {
    await spawn(doc);
    return;
  }
  doc.generation += 1;
  failStepWaiters(doc, "world reloaded");
  resetSerial(doc);
  const generation = doc.generation;
  const pending = waitForResult(worker, generation);
  worker.postMessage({ type: "reload", generation } satisfies ToWorker);
  try {
    await pending;
  } catch (err: unknown) {
    if (!doc.worker && doc.errorMessage) return;
    await killWorker(doc);
    const message = err instanceof Error ? err.message : String(err);
    doc.errors = [];
    doc.errorMessage = message;
    broadcast(doc, { type: "error", errors: [], message });
    return;
  }
  if (doc.errors && doc.errors.length > 0) await killWorker(doc);
}

/**
 * Validation runs in the worker, which owns the file read. A failed
 * validation still resolves: subscribers get the error event, and no
 * sim is left playing. `change` announces `reloaded` either way, because
 * the previous run is no longer the one on disk.
 */
async function load(
  doc: Doc,
  reason: "attach" | "change" | "restart"
): Promise<void> {
  const torn = repairDocument(doc.project, doc.world);
  if (torn) {
    doc.errors = [];
    doc.errorMessage = torn;
    doc.lastState = null;
    doc.report = null;
    broadcast(doc, { type: "error", errors: [], message: torn });
    return;
  }
  const before = doc.stamp;
  refreshDeps(doc);
  if (reason === "change" && doc.stamp === before) return;
  // `restart` is a file-edit reload with no write: same broadcast, and the
  // stamp check does not skip it.
  if (reason === "change" || reason === "restart") {
    doc.lastCommand = null;
    doc.errorMessage = undefined;
    doc.errors = null;
    broadcast(doc, { type: "reloaded" });
  }
  if (!doc.worker) await spawn(doc);
  else await reload(doc);
  refreshDeps(doc);
  refreshFirmware(doc);
  doc.ready = true;
}

/** Finish a torn part and lock write before the loader reads the lock. */
function repairDocument(project: string, world: string): string | null {
  const file = resolveInside(project, world);
  if (!file) return null;
  const healed = healTornWrite(nodeStore, file);
  return healed ? healed.error : null;
}

function refreshFirmware(doc: Doc) {
  doc.firmware = firmwareWatch(doc.project, doc.world);
}

function startLoad(
  doc: Doc,
  reason: "attach" | "change" | "restart"
): Promise<void> {
  if (doc.busy) {
    return doc.busy.then(() => {
      if (!docs.has(doc.key)) return;
      // Queued attach is "change": same files must not reload the run just built.
      return startLoad(doc, reason === "attach" ? "change" : reason);
    });
  }
  // Set busy before load() so a file-watch callback that runs during the
  // first synchronous read cannot start a second load on top of this one.
  let done: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    done = resolve;
  });
  doc.busy = gate;
  return load(doc, reason).finally(() => {
    if (doc.busy === gate) doc.busy = null;
    done();
  });
}

function onWatched(doc: Doc) {
  setImmediate(() => {
    if (!docs.has(doc.key)) return;
    if (doc.busy) {
      void doc.busy.then(() => {
        if (docs.has(doc.key)) onWatched(doc);
      });
      return;
    }
    const stamp = dependencyStamp(doc.project, doc.deps);
    if (stamp !== doc.stamp) {
      void startLoad(doc, "change");
      return;
    }
    const next = firmwareWatch(doc.project, doc.world);
    const changed = next.filter((item) => {
      const prev = doc.firmware.find((row) => row.id === item.id);
      return !prev || prev.rel !== item.rel || prev.stamp !== item.stamp;
    });
    doc.firmware = next;
    if (changed.length === 0) return;
    if (!doc.worker || (doc.errors && doc.errors.length > 0)) return;
    for (const item of changed) {
      post(doc, {
        type: "reloadBoard",
        board: item.id,
        generation: doc.generation,
      });
    }
  });
}

function watch(doc: Doc) {
  if (doc.unwatch) return;
  doc.unwatch = subscribeRootWatch(doc.project, () => onWatched(doc));
}

function post(doc: Doc, message: ToWorker) {
  if (!doc.worker) return;
  if (doc.errors && doc.errors.length > 0) return;
  doc.worker.postMessage(message);
}

function ensure(project: string, worldRel: string): Doc | { error: string } {
  const named = docKey(project, worldRel);
  if ("error" in named) return named;
  let doc = docs.get(named.key);
  if (!doc) {
    doc = {
      key: named.key,
      project: named.project,
      world: named.world,
      fuseStart: "cold",
      adcTrace: false,
      subs: new Set(),
      worker: null,
      generation: 0,
      lastState: null,
      report: null,
      stateEpoch: 0,
      lastCommand: null,
      errors: null,
      ready: false,
      busy: null,
      idle: null,
      unwatch: null,
      deps: dependencyRels(named.project, named.world),
      stamp: "",
      firmware: firmwareWatch(named.project, named.world),
      serial: new Map(),
      rx: new Map(),
      rxSent: new Map(),
      stopping: false,
      requestSeq: 0,
      pending: new Map(),
      stepSeq: 0,
      stepWaiters: new Map(),
      bootSnap: new Map(),
    };
    doc.stamp = dependencyStamp(doc.project, doc.deps);
    docs.set(named.key, doc);
    watch(doc);
  }
  if (doc.idle) {
    clearTimeout(doc.idle);
    doc.idle = null;
  }
  return doc;
}

export async function attachWorld(
  project: string,
  worldRel: string,
  subscription: WorldSubscription,
  options?: AttachWorldOptions
): Promise<WorldHandle | { error: string }> {
  const found = ensure(project, worldRel);
  if ("error" in found) return found;
  const doc = found;
  if (options?.fuseStart && !doc.worker) {
    doc.fuseStart = options.fuseStart === "tripped" ? "tripped" : "cold";
  }
  if (options?.adcTrace !== undefined && !doc.worker) {
    doc.adcTrace = options.adcTrace;
  }
  const sub: Sub = { ...subscription, delivered: false, detached: false };
  doc.subs.add(sub);
  tie(doc);
  // A failed thread leaves `ready` set and the worker cleared. Attach again
  // to rebuild; a file change does the same through the watcher.
  if (!doc.ready || !doc.worker) await startLoad(doc, "attach");
  if (!sub.detached && !sub.delivered) sendSnapshot(sub, doc);

  const handle: WorldHandle = {
    play(nonce?: string) {
      if (sub.detached || !doc.worker) return;
      if (doc.errors && doc.errors.length > 0) return;
      announce(doc, "play", sub.sender, nonce);
      post(doc, { type: "play", generation: doc.generation, by: sub.sender });
    },
    pause(nonce?: string) {
      if (sub.detached || !doc.worker) return;
      if (doc.errors && doc.errors.length > 0) return;
      announce(doc, "pause", sub.sender, nonce);
      post(doc, { type: "pause", generation: doc.generation, by: sub.sender });
    },
    step(n: number) {
      if (sub.detached || !doc.worker) return;
      if (doc.errors && doc.errors.length > 0) return;
      let pauseBy: WorldSender | undefined;
      if (doc.lastState?.playing) {
        announce(doc, "pause", sub.sender);
        pauseBy = sub.sender;
      }
      post(doc, {
        type: "step",
        n,
        generation: doc.generation,
        ...(pauseBy ? { pauseBy } : {}),
      });
    },
    sendSerial(board: string, text: string, nonce?: string) {
      if (sub.detached) return { error: "world is not running" };
      return deliverSerial(doc, sub.sender, board, text, nonce);
    },
    seek(t: number, nonce: string) {
      return seekDoc(doc, t, nonce);
    },
    timeline(query) {
      return timelineDoc(doc, query);
    },
    detach() {
      if (sub.detached) return;
      sub.detached = true;
      doc.subs.delete(sub);
      tie(doc);
      armIdle(doc);
    },
  };
  return handle;
}

const BOARD_ID = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

function rejectSerial(
  doc: Doc,
  board: string,
  message: string,
  nonce?: string
): { error: string } {
  broadcast(doc, {
    type: "board-error",
    board,
    message,
    ...(nonce ? { nonce } : {}),
  });
  return { error: message };
}

function deliverSerial(
  doc: Doc,
  sender: WorldSender,
  board: string,
  text: string,
  nonce?: string
): { ok: true } | { error: string } {
  const reject = (message: string) => rejectSerial(doc, board, message, nonce);
  if (!doc.worker || !doc.lastState) return reject("world is not running");
  if (doc.errors && doc.errors.length > 0) {
    return reject(doc.errorMessage ?? "world failed to load");
  }
  if (!BOARD_ID.test(board)) return reject("serial needs a board id");
  if (text.length > SERIAL_TEXT_MAX) {
    return reject(`serial text is longer than ${SERIAL_TEXT_MAX} characters`);
  }
  if (text.length === 0) return reject("serial text is empty");
  const info = doc.lastState.boards[board];
  if (!info) return reject(`no board "${board}"`);
  if (!info.running) {
    const why = info.fault ? `: ${info.fault}` : "";
    return reject(`board "${board}" is stopped${why}`);
  }
  const sent = doc.rxSent.get(board) ?? 0;
  const accepted = doc.rx.get(board)?.accepted ?? 0;
  const queued = Math.max(0, sent - accepted);
  const bytes = new TextEncoder().encode(text).length;
  if (queued + bytes > RX_BACKLOG) return reject("serial input is full");
  doc.rxSent.set(board, sent + bytes);
  post(doc, {
    type: "serialIn",
    board,
    text,
    generation: doc.generation,
    by: sender,
  });
  broadcast(doc, {
    type: "serial-sent",
    board,
    text,
    by: sender,
    ...(nonce ? { nonce } : {}),
  });
  return { ok: true };
}

/**
 * Load the document if nobody has it open yet. Leaves play state alone:
 * a new run starts paused, and a run that is already playing stays playing.
 */
export async function ensureWorldRun(
  project: string,
  worldRel: string
): Promise<{ ok: true } | { error: string }> {
  const found = ensure(project, worldRel);
  if ("error" in found) return found;
  const doc = found;
  if (doc.busy) await doc.busy;
  if (!doc.ready || !doc.worker) await startLoad(doc, "attach");
  if (doc.errors && doc.errors.length > 0) {
    return {
      error:
        doc.errorMessage ?? doc.errors[0]?.message ?? "world failed to load",
    };
  }
  if (!doc.worker || !doc.lastState) return { error: "world did not start" };
  if (doc.subs.size === 0) armIdle(doc);
  return { ok: true };
}

export function readSerial(
  project: string,
  worldRel: string,
  board: string,
  from = 0
): SerialPage | { error: string } {
  const named = docKey(project, worldRel);
  if ("error" in named) return named;
  const doc = docs.get(named.key);
  if (!doc?.worker || !doc.lastState) return { error: "world is not running" };
  if (!doc.lastState.boards[board]) return { error: `no board "${board}"` };
  const ring = doc.serial.get(board);
  if (!ring) return { text: "", next: 0 };
  return ring.read(from);
}

export function sendSerial(
  project: string,
  worldRel: string,
  board: string,
  text: string,
  sender: WorldSender,
  nonce?: string
): { ok: true } | { error: string } {
  const named = docKey(project, worldRel);
  if ("error" in named) return named;
  const doc = docs.get(named.key);
  if (!doc) return { error: "world is not running" };
  return deliverSerial(doc, sender, board, text, nonce);
}

/** Test-only. Bytes waiting on USART0 RX, and how many have been accepted. */
export function boardRx(
  project: string,
  worldRel: string,
  board: string
): { queued: number; accepted: number } | { error: string } {
  const named = docKey(project, worldRel);
  if ("error" in named) return named;
  const doc = docs.get(named.key);
  if (!doc?.lastState) return { error: "world is not running" };
  if (!doc.lastState.boards[board]) return { error: `no board "${board}"` };
  return doc.rx.get(board) ?? { queued: 0, accepted: 0 };
}

function ask(doc: Doc, query: RecordQuery): Promise<RecordBody> {
  const worker = doc.worker;
  if (!worker || !doc.lastState || (doc.errors && doc.errors.length > 0)) {
    return Promise.resolve({
      op: "error",
      message: doc.errorMessage ?? "world is not running",
    });
  }
  const request = doc.requestSeq + 1;
  doc.requestSeq = request;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      doc.pending.delete(request);
      resolve({ op: "error", message: "recording did not answer" });
    }, START_MS);
    doc.pending.set(request, { resolve, timer });
    try {
      worker.postMessage({
        type: "record",
        generation: doc.generation,
        request,
        query,
      } satisfies ToWorker);
    } catch (err: unknown) {
      clearTimeout(timer);
      doc.pending.delete(request);
      const message = err instanceof Error ? err.message : "recording failed";
      resolve({ op: "error", message });
    }
  });
}

function runningDoc(
  project: string,
  worldRel: string
): Doc | { error: string } {
  const named = docKey(project, worldRel);
  if ("error" in named) return named;
  const doc = docs.get(named.key);
  if (!doc?.worker || !doc.lastState) return { error: "world is not running" };
  if (doc.errors && doc.errors.length > 0) {
    return { error: doc.errorMessage ?? "world failed to load" };
  }
  return doc;
}

async function seekDoc(
  doc: Doc,
  t: number,
  nonce: string
): Promise<Extract<WorldServerMessage, { type: "frame" }> | { error: string }> {
  const body = await ask(doc, { op: "frame", t });
  if (body.op === "error") return { error: body.message };
  if (body.op !== "frame") return { error: "recording did not answer" };
  return {
    type: "frame",
    recording: body.id,
    t: body.frame?.t ?? t,
    frame: body.frame,
    nonce,
  };
}

async function timelineDoc(
  doc: Doc,
  query: { from: number; to: number; maxPoints: number }
): Promise<
  Extract<WorldServerMessage, { type: "timeline-data" }> | { error: string }
> {
  const maxPoints = Math.max(1, Math.min(4000, Math.floor(query.maxPoints)));
  const body = await ask(doc, {
    op: "timeline",
    from: query.from,
    to: query.to,
    maxPoints,
  });
  if (body.op === "error") return { error: body.message };
  if (body.op !== "timeline") return { error: "recording did not answer" };
  return {
    type: "timeline-data",
    recording: body.id,
    from: body.from,
    to: body.to,
    tracks: body.tracks,
    markers: body.markers,
  };
}

/**
 * Registers and pin levels taken at the latest brownout reboot, before
 * that CPU executed an instruction. Null when this board has not rebooted.
 */
export function brownoutBootSnapshot(
  project: string,
  worldRel: string,
  board: string
): { regs: CpuResetRegs; pins: WorldPinState } | null {
  const named = docKey(project, worldRel);
  if ("error" in named) return null;
  return docs.get(named.key)?.bootSnap.get(board) ?? null;
}

/** What this document is recording. W6 reads this; the socket does too. */
export async function recordingInfo(
  project: string,
  worldRel: string
): Promise<RecordingInfo | { error: string }> {
  const doc = runningDoc(project, worldRel);
  if ("error" in doc) return doc;
  const body = await ask(doc, { op: "info" });
  if (body.op === "error") return { error: body.message };
  if (body.op !== "info") return { error: "recording did not answer" };
  return body.info;
}

/**
 * Frames and events in `[from, to]`, seconds of sim time.
 * `maxFrames` picks real frames and keeps the extremes of the ones it skips.
 */
export async function readRecording(
  project: string,
  worldRel: string,
  query: {
    from: number;
    to: number;
    tracks?: string[];
    maxFrames?: number;
  }
): Promise<RecordingRead | { error: string }> {
  const doc = runningDoc(project, worldRel);
  if ("error" in doc) return doc;
  const body = await ask(doc, { op: "read", ...query });
  if (body.op === "error") return { error: body.message };
  if (body.op !== "read") return { error: "recording did not answer" };
  return body.read;
}

/**
 * Test only. Board nodes and ADC samples for a run opened with `adcTrace`.
 * A sample's `ms` is the step it completed in. Its reference is the board
 * node stamped at `ms - 1`, except a CPU that booted in that same quantum.
 * Without the option the worker answers "ADC trace is off".
 */
export async function readAdcTrace(
  project: string,
  worldRel: string
): Promise<AdcTrace | { error: string }> {
  const doc = runningDoc(project, worldRel);
  if ("error" in doc) return doc;
  const body = await ask(doc, { op: "adc" });
  if (body.op === "error") return { error: body.message };
  if (body.op !== "adc") return { error: "recording did not answer" };
  return body.trace;
}

/** The full frame at or before `t` seconds. Null when that time was dropped. */
export async function frameAt(
  project: string,
  worldRel: string,
  t: number
): Promise<RecordedFrame | null | { error: string }> {
  const doc = runningDoc(project, worldRel);
  if ("error" in doc) return doc;
  const body = await ask(doc, { op: "frame", t });
  if (body.op === "error") return { error: body.message };
  if (body.op !== "frame") return { error: "recording did not answer" };
  return body.frame;
}

/** Test-only. Keep this many milliseconds of sim time instead of 10 minutes. */
export async function setRecordingBound(
  project: string,
  worldRel: string,
  boundMs: number
): Promise<{ ok: true } | { error: string }> {
  const doc = runningDoc(project, worldRel);
  if ("error" in doc) return doc;
  const body = await ask(doc, { op: "config", boundMs });
  if (body.op === "error") return { error: body.message };
  return { ok: true };
}

/** Test-only. The lockstep loop skips the recorder while this is false. */
export async function setRecordingEnabled(
  project: string,
  worldRel: string,
  enabled: boolean
): Promise<{ ok: true } | { error: string }> {
  const doc = runningDoc(project, worldRel);
  if ("error" in doc) return doc;
  const body = await ask(doc, { op: "config", enabled });
  if (body.op === "error") return { error: body.message };
  return { ok: true };
}

/** Test-only. The next `step` on this document throws inside the worker. */
export function faultWorld(project: string, worldRel: string): void {
  const named = docKey(project, worldRel);
  if ("error" in named) return;
  const doc = docs.get(named.key);
  if (!doc?.worker) return;
  doc.worker.postMessage({
    type: "fault",
    generation: doc.generation,
  } satisfies ToWorker);
}

export async function stopWorld(
  project: string,
  worldRel: string
): Promise<void> {
  const named = docKey(project, worldRel);
  if ("error" in named) return;
  await stopKey(named.key);
}

async function stopKey(key: string): Promise<void> {
  const doc = docs.get(key);
  if (!doc) return;
  docs.delete(key);
  if (doc.idle) clearTimeout(doc.idle);
  doc.unwatch?.();
  doc.unwatch = null;
  for (const sub of doc.subs) sub.detached = true;
  doc.subs.clear();
  await killWorker(doc);
}

const STEP_WAIT_MS = 45_000;
const COMMAND_WAIT_MS = 10_000;

/** Path check only. Does not load the document or start a worker. */
export function resolveWorldFile(
  project: string,
  worldRel: string
): { project: string; world: string } | { error: string } {
  const named = docKey(project, worldRel);
  if ("error" in named) return named;
  if (!resolveInside(named.project, named.world)) {
    return { error: `world "${named.world}" does not exist` };
  }
  return { project: named.project, world: named.world };
}

/** Test-only. True after `ensure` has created this document. */
export function worldDocumentOpen(project: string, worldRel: string): boolean {
  const named = docKey(project, worldRel);
  if ("error" in named) return false;
  return docs.has(named.key);
}

/** Test-only. True while `world_step` is waiting on its own step reply. */
export function worldStepInFlight(project: string, worldRel: string): boolean {
  const named = docKey(project, worldRel);
  if ("error" in named) return false;
  const doc = docs.get(named.key);
  return (doc?.stepWaiters.size ?? 0) > 0;
}

/** Reject a `world_step` span before any run starts. */
export function rejectWorldStep(ms: number): { error: string } | null {
  if (!Number.isInteger(ms) || ms < 1 || ms > 10_000) {
    return { error: "ms must be a whole number from 1 to 10000" };
  }
  return null;
}

export type WorldRunView = {
  state: WorldState;
  lastCommand: {
    command: "play" | "pause";
    by: WorldSender;
  } | null;
};

export function worldRunView(
  project: string,
  worldRel: string
): WorldRunView | { error: string } {
  const doc = runningDoc(project, worldRel);
  if ("error" in doc) return doc;
  if (!doc.lastState) return { error: "world is not running" };
  return {
    state: structuredClone(doc.lastState),
    lastCommand: doc.lastCommand
      ? {
          command: doc.lastCommand.command,
          by: structuredClone(doc.lastCommand.by),
        }
      : null,
  };
}

function hold(doc: Doc) {
  if (doc.idle) {
    clearTimeout(doc.idle);
    doc.idle = null;
  }
}

function release(doc: Doc) {
  if (!docs.has(doc.key)) return;
  if (doc.subs.size === 0) armIdle(doc);
}

function simMs(simTime: number): number {
  return Math.round(simTime * 1000);
}

function waitForEpoch(
  doc: Doc,
  epoch: number,
  pred: (state: WorldState) => boolean,
  timeoutMs: number
): Promise<WorldState | { error: string }> {
  const ready = (): WorldState | null => {
    const state = doc.lastState;
    if (doc.stateEpoch > epoch && state && pred(state)) return state;
    return null;
  };
  const immediate = ready();
  if (immediate) return Promise.resolve(immediate);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve({ error: "timed out waiting for the world" });
    }, timeoutMs);
    const poll = setInterval(() => {
      if (!docs.has(doc.key)) {
        cleanup();
        resolve({ error: "world is not running" });
        return;
      }
      const state = ready();
      if (!state) return;
      cleanup();
      resolve(state);
    }, 10);
    const cleanup = () => {
      clearInterval(poll);
      clearTimeout(timer);
    };
  });
}

async function commandWorld(
  project: string,
  worldRel: string,
  command: "play" | "pause",
  sender: WorldSender
): Promise<{ ok: true } | { error: string }> {
  const doc = runningDoc(project, worldRel);
  if ("error" in doc) return doc;
  hold(doc);
  try {
    const epoch = doc.stateEpoch;
    announce(doc, command, sender);
    post(doc, {
      type: command,
      generation: doc.generation,
      by: sender,
    });
    const state = await waitForEpoch(
      doc,
      epoch,
      (next) => (command === "play" ? next.playing : !next.playing),
      COMMAND_WAIT_MS
    );
    if ("error" in state) return state;
    return { ok: true };
  } finally {
    release(doc);
  }
}

export function playWorld(
  project: string,
  worldRel: string,
  sender: WorldSender
): Promise<{ ok: true } | { error: string }> {
  return commandWorld(project, worldRel, "play", sender);
}

export function pauseWorld(
  project: string,
  worldRel: string,
  sender: WorldSender
): Promise<{ ok: true } | { error: string }> {
  return commandWorld(project, worldRel, "pause", sender);
}

function waitForStep(
  doc: Doc,
  request: number
): Promise<WorldState | { error: string }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const waiter = doc.stepWaiters.get(request);
      if (!waiter) return;
      doc.stepWaiters.delete(request);
      settleStep(waiter, { error: "timed out waiting for the world" });
    }, STEP_WAIT_MS);
    doc.stepWaiters.set(request, {
      settled: false,
      resolve,
      timer,
    });
  });
}

/**
 * One worker step. The reply is the state that command produced, not
 * whatever snapshot is newest when the poll next runs.
 */
/**
 * Queue a target move. The worker applies it on the next master step
 * and records a `move-target` event. The caller has already checked
 * that `id` is a target in this world.
 */
export function moveWorldTarget(
  project: string,
  worldRel: string,
  id: string,
  position: [number, number, number]
): { ok: true } | { error: string } {
  const doc = runningDoc(project, worldRel);
  if ("error" in doc) return doc;
  post(doc, {
    type: "moveTarget",
    id,
    position,
    generation: doc.generation,
  });
  return { ok: true };
}

export async function stepWorld(
  project: string,
  worldRel: string,
  ms: number,
  sender: WorldSender
): Promise<{ state: WorldState } | { error: string }> {
  const bad = rejectWorldStep(ms);
  if (bad) return bad;
  const doc = runningDoc(project, worldRel);
  if ("error" in doc) return doc;
  hold(doc);
  try {
    const request = doc.stepSeq + 1;
    doc.stepSeq = request;
    const generation = doc.generation;
    if (doc.lastState?.playing) announce(doc, "pause", sender);
    const pending = waitForStep(doc, request);
    if (doc.generation !== generation) {
      failStepWaiters(doc, "world reloaded");
      return { error: "world reloaded" };
    }
    post(doc, {
      type: "step",
      n: ms,
      generation,
      pauseBy: sender,
      request,
    });
    if (!doc.worker) {
      failStepWaiters(doc, "world is not running");
      return { error: "world is not running" };
    }
    const landed = await pending;
    if ("error" in landed) return landed;
    return { state: landed };
  } finally {
    release(doc);
  }
}

/**
 * Reload the document the way a file edit does, without writing it.
 * Sim time returns to 0, paused, on a new recording.
 */
export async function restartWorld(
  project: string,
  worldRel: string
): Promise<{ ok: true } | { error: string }> {
  const found = ensure(project, worldRel);
  if ("error" in found) return found;
  const doc = found;
  hold(doc);
  try {
    if (doc.busy) await doc.busy;
    if (!docs.has(doc.key)) return { error: "world is not running" };
    if (!doc.ready || !doc.worker) await startLoad(doc, "attach");
    if (!docs.has(doc.key)) return { error: "world is not running" };
    if (doc.errors && doc.errors.length > 0) {
      return { error: doc.errorMessage ?? "world failed to load" };
    }
    const previous = doc.lastState?.recording?.id;
    await startLoad(doc, "restart");
    if (!docs.has(doc.key)) return { error: "world is not running" };
    if (doc.errors && doc.errors.length > 0) {
      return { error: doc.errorMessage ?? "world failed to load" };
    }
    const state = doc.lastState;
    if (!state || state.playing || simMs(state.simTime) !== 0) {
      return { error: "world did not return to sim time 0" };
    }
    const id = state.recording?.id;
    if (!id || (previous !== undefined && id === previous)) {
      return { error: "recording did not restart" };
    }
    return { ok: true };
  } finally {
    release(doc);
  }
}
