/** A document's worker: spawn, listen, load, reload, watch, kill, and the attach that starts it. */

import { Worker } from "node:worker_threads";
import type { WorldSender, WorldState } from "@sfab-bench/contract";
import { healTornWrite } from "@sfab-bench/parts";
import { subscribeRootWatch } from "../../projects";
import {
  dependencyRels,
  dependencyStamp,
  firmwareWatch,
  resolveInside,
} from "../files";
import { nodeStore } from "../node-store";
import type { FromWorker, ToWorker } from "../worker";
import {
  type AttachWorldOptions,
  type Doc,
  IDLE_MS,
  START_MS,
  type StepWaiter,
  type Sub,
  type WorldHandle,
  type WorldSubscription,
} from "./doc";
import { seekDoc, timelineDoc } from "./recording";
import {
  announce,
  broadcast,
  docKey,
  docs,
  liveWorkers,
  sendSnapshot,
  worldWorkerEntry,
} from "./registry";
import { clearRxBook, deliverSerial, resetSerial, ringOf } from "./serial";

function refreshDeps(doc: Doc) {
  doc.deps = dependencyRels(doc.project, doc.world);
  doc.stamp = dependencyStamp(doc.project, doc.deps);
}

function tie(doc: Doc) {
  if (!doc.worker) return;
  if (doc.subs.size > 0) doc.worker.ref();
  else doc.worker.unref();
}

export function armIdle(doc: Doc) {
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

export function settleStep(
  waiter: StepWaiter,
  result: WorldState | { error: string }
) {
  if (waiter.settled) return;
  waiter.settled = true;
  clearTimeout(waiter.timer);
  waiter.resolve(result);
}

export function failStepWaiters(doc: Doc, message: string) {
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

export function startLoad(
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

export function post(doc: Doc, message: ToWorker) {
  if (!doc.worker) return;
  if (doc.errors && doc.errors.length > 0) return;
  doc.worker.postMessage(message);
}

export function ensure(
  project: string,
  worldRel: string
): Doc | { error: string } {
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
