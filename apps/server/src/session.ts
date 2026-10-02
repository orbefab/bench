import type {
  ClientPrincipal,
  ProjectSession,
  SessionClient,
  SessionEvent,
  SessionSnapshot,
} from "@sfab-bench/contract";
import { getPrincipal } from "./principal";
import {
  catalogRevision,
  currentProject,
  fallbackRoot,
  listFileRecents,
  touchFileRecent,
} from "./projects";

export type SessionSocket = { send: (data: string) => void };

const sockets = new Set<SessionSocket>();

let state: ProjectSession = {
  project: { path: "" },
  fileRecents: [],
};

const runs = new Map<string, AbortController>();

export function clientOf(principal: ClientPrincipal): SessionClient {
  if (principal.kind === "loopback") return { id: "loopback", label: "Mac" };
  if (principal.kind === "paired")
    return { id: principal.deviceId, label: principal.label || "Quest" };
  return { id: principal.deviceId, label: "Account" };
}

function emit(event: SessionEvent) {
  const payload = JSON.stringify(event);
  for (const socket of sockets) {
    try {
      socket.send(payload);
    } catch {
      sockets.delete(socket);
    }
  }
}

function libraryEvent(
  root: string
): Extract<SessionEvent, { type: "library" }> {
  return {
    type: "library",
    project: { path: root },
    fileRecents: listFileRecents(root),
    revision: catalogRevision(root),
  };
}

export function subscribeSession(socket: SessionSocket) {
  sockets.add(socket);
  return () => {
    sockets.delete(socket);
  };
}

export function sessionState(): ProjectSession {
  return state;
}

export function snapshotFor(principal?: ClientPrincipal): SessionSnapshot {
  const who = principal ?? getPrincipal();
  return { ...state, you: who ? clientOf(who) : undefined };
}

export function sendSnapshot(
  socket: SessionSocket,
  principal: ClientPrincipal
) {
  socket.send(
    JSON.stringify({
      type: "snapshot",
      session: snapshotFor(principal),
    } satisfies SessionEvent)
  );
}

function readLibrary() {
  const project = currentProject();
  state = {
    project: { path: project?.path ?? "" },
    fileRecents: listFileRecents(project?.path),
  };
}

/**
 * Rebuild the param-less snapshot from the fallback folder.
 * Does not abort runs — another tab may be chatting in a different folder.
 */
export function hydrateSession() {
  readLibrary();
  emit({ type: "snapshot", session: { ...state } });
}

/** Shared recents only — does not load the file on any client. */
export function rememberOpenedFile(rel: string, root?: string | null) {
  const target = root ?? fallbackRoot();
  if (!target) return [];
  const fileRecents = touchFileRecent(rel, target);
  if (target === fallbackRoot()) {
    state = { ...state, fileRecents };
  }
  emit(libraryEvent(target));
  return fileRecents;
}

export function startSessionRun(root: string): AbortController | null {
  if (runs.has(root)) return null;
  const run = new AbortController();
  runs.set(root, run);
  return run;
}

export function endSessionRun(root: string) {
  runs.delete(root);
}

export function stopSessionRun(root?: string | null) {
  const target = root ?? fallbackRoot();
  if (!target) return;
  runs.get(target)?.abort();
}
