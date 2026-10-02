/** The document registry: which documents run, who is subscribed, and what is broadcast to them. */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Worker } from "node:worker_threads";
import {
  isRunDocumentPath,
  type WorldSender,
  type WorldServerMessage,
  type WorldState,
} from "@sfab-bench/contract";
import { projectReal, resolveInside } from "../files";
import type { Doc, Sub } from "./doc";
import { runningDoc } from "./recording";
import { sendSerialTails } from "./serial";

export const docs = new Map<string, Doc>();

export const liveWorkers = new Set<Worker>();

export function worldWorkerCount(): number {
  return liveWorkers.size;
}

/** Bundled, the worker sits beside the server bundle. From a checkout it is the TypeScript beside `world/host.ts`, one level up from this file, which tsx loads. */
export function worldWorkerEntry(): string {
  for (const rel of ["./world-worker.mjs", "../worker.ts"]) {
    const candidate = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("the world worker is missing beside the server bundle");
}

export function docKey(
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

export function broadcast(doc: Doc, event: WorldServerMessage) {
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

export function announce(
  doc: Doc,
  command: "play" | "pause",
  by: WorldSender,
  nonce?: string
) {
  doc.lastCommand = { command, by, ...(nonce ? { nonce } : {}) };
  broadcast(doc, commandEvent(command, by, nonce));
}

export function sendSnapshot(sub: Sub, doc: Doc) {
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
