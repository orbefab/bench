/** Run commands: play, pause, step, restart, and the wait for the state each one produces. */

import type { WorldSender, WorldState } from "@sfab-bench/contract";
import { COMMAND_WAIT_MS, type Doc, STEP_WAIT_MS } from "./doc";
import {
  armIdle,
  ensure,
  failStepWaiters,
  post,
  settleStep,
  startLoad,
} from "./lifecycle";
import { runningDoc } from "./recording";
import { announce, docKey, docs } from "./registry";

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
