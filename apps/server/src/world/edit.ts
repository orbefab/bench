/**
 * One undo history per open document. Tools, the socket, and
 * `world_set_level` all write through `EditSession`. After a write the
 * run restarts once; the watcher then sees the same dependency stamp.
 */

import { realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type {
  EditOp,
  EditRefusal,
  RunReport,
  WorldClientMessage,
  WorldServerMessage,
} from "@sfab-bench/contract";
import {
  confirmSentence,
  EditSession,
  EXTERNAL_EDIT,
  editLabel,
  type NeedsConfirm,
  partFilePath,
} from "@sfab-bench/parts";

import { publishWorldEvent, restartWorld, stopWorld } from "./host";
import { editRefused } from "./live-message";
import { absolutePath, nodeStore } from "./node-store";
import { catalogRoot } from "./plan-host";

const sessions = new Map<string, EditSession>();

/** Part ids this process has renamed, so undo still finds the file. */
const partFileAlias = new Map<string, string>();

type SessionMeta = {
  /** Absent when the session is the open document. */
  part?: string;
  worlds: Set<string>;
};

const sessionMeta = new Map<string, SessionMeta>();

function worldKey(project: string, world: string): string {
  return `${project}\0${world}`;
}

/** Undo flags for every part history this world has opened. */
export function historiesFor(
  project: string,
  world: string
): { part?: string; canUndo: boolean; canRedo: boolean }[] {
  const id = worldKey(project, world);
  const rows: { part?: string; canUndo: boolean; canRedo: boolean }[] = [];
  for (const [file, session] of sessions) {
    const meta = sessionMeta.get(file);
    if (!meta?.worlds.has(id)) continue;
    rows.push({
      ...(meta.part ? { part: meta.part } : {}),
      canUndo: session.canUndo,
      canRedo: session.canRedo,
    });
  }
  return rows;
}

/**
 * Undo flags when a part tab connects. Includes this document's own
 * session even when it was first opened as a nested part of another file.
 */
export function historiesForConnect(
  project: string,
  world: string
): { part?: string; canUndo: boolean; canRedo: boolean }[] {
  const rows = historiesFor(project, world);
  const root = canonical(absolutePath(join(absolutePath(project), world)));
  const session = sessions.get(root);
  if (!session) return rows;
  if (rows.some((row) => row.part === undefined)) return rows;
  return [{ canUndo: session.canUndo, canRedo: session.canRedo }, ...rows];
}

export type DocumentEdit = {
  label: string;
  canUndo: boolean;
  canRedo: boolean;
  report: RunReport;
  sentence: string;
  warnings?: string[];
  /** Project-relative. Set when this step moved the open document. */
  moved?: { from: string; to: string };
  /** Ids. Kept so a later undo still finds the session. Not on the wire. */
  renamed?: { from: string; to: string };
};

/**
 * A write that did not happen. `refusal` is set when the edit itself was
 * refused. `runFault` is set when the edit landed and the document then
 * could not run: that is a run problem, not a refusal.
 */
export type EditError = {
  error: string;
  refusal?: EditRefusal;
  runFault?: true;
};

export async function applyDocumentEdit(
  project: string,
  world: string,
  ops: EditOp[],
  label?: string,
  part?: string,
  confirm?: "break"
): Promise<DocumentEdit | NeedsConfirm | EditError> {
  const opened = openSession(project, world, part);
  if ("error" in opened) return opened;
  const { session, key } = opened;
  if (ops.length === 0) return { error: "edit needs operations" };
  const op: EditOp =
    ops.length === 1
      ? ops[0]
      : {
          kind: "batch",
          document: ops[0]?.document ?? world,
          label: label ?? "edit",
          ops,
        };
  if (
    confirm === "break" ||
    op.confirm === "break" ||
    ops.some((item) => item.confirm === "break")
  ) {
    op.confirm = "break";
  }
  const applied = session.apply(op, label);
  if ("needsConfirm" in applied) return applied;
  if ("error" in applied) return applied;
  const unread = (applied.skipped ?? []).map(
    (row) => `${row.file}: ${row.error}`
  );
  return finishEdit(project, world, part, session, key, {
    ...applied,
    ...(unread.length > 0
      ? {
          warnings: [
            ...(applied.warnings ?? []),
            ...unread.map((line) => `not checked for the old name, ${line}`),
          ],
        }
      : {}),
    sentence:
      unread.length > 0
        ? `${editSentence(applied.label, applied.canUndo)} Not checked for the old name: ${unread.join("; ")}.`
        : editSentence(applied.label, applied.canUndo),
  });
}

export async function undoDocument(
  project: string,
  world: string,
  part?: string
): Promise<DocumentEdit | EditError> {
  const opened = openSession(project, world, part);
  if ("error" in opened) return opened;
  const { session, key } = opened;
  const applied = session.undo();
  if ("needsConfirm" in applied) return { error: "nothing to undo" };
  if ("error" in applied) return applied;
  return finishEdit(project, world, part, session, key, {
    ...applied,
    sentence: `Undid ${applied.label}. ${redoSentence(applied.canRedo)}`,
  });
}

export async function redoDocument(
  project: string,
  world: string,
  part?: string
): Promise<DocumentEdit | EditError> {
  const opened = openSession(project, world, part);
  if ("error" in opened) return opened;
  const { session, key } = opened;
  const applied = session.redo();
  if ("needsConfirm" in applied) return { error: "nothing to redo" };
  if ("error" in applied) return applied;
  return finishEdit(project, world, part, session, key, {
    ...applied,
    sentence: `Redid ${applied.label}. ${undoSentence(applied.canUndo)}`,
  });
}

export function editSentence(label: string, canUndo: boolean): string {
  return `${label}. ${undoSentence(canUndo)}`;
}

function undoSentence(canUndo: boolean): string {
  return canUndo ? "Undo is available." : "Undo is not available.";
}

function redoSentence(canRedo: boolean): string {
  return canRedo ? "Redo is available." : "Redo is not available.";
}

/**
 * The live socket's edit, undo, and redo. The socket has already read the
 * ops (`parseWorldClient`), so they are typed here and read once.
 */
export async function handleLiveEdit(
  project: string,
  world: string,
  message: Extract<WorldClientMessage, { type: "edit" | "undo" | "redo" }>
): Promise<WorldServerMessage> {
  if (message.type === "undo") {
    return editedMessage(
      await undoDocument(project, world, message.part),
      "undo",
      message.part
    );
  }
  if (message.type === "redo") {
    return editedMessage(
      await redoDocument(project, world, message.part),
      "redo",
      message.part
    );
  }
  const allowed = documentNames(project, world, message.part);
  if (message.ops.some((op) => !allowed.has(op.document))) {
    return editRefused("edit", "an edit names a different document", {
      part: message.part,
    });
  }
  return editedMessage(
    await applyDocumentEdit(
      project,
      world,
      message.ops,
      message.label ?? editLabel(message.ops[0] as EditOp),
      message.part,
      message.confirm
    ),
    "edit",
    message.part
  );
}

function editedMessage(
  result: DocumentEdit | NeedsConfirm | EditError,
  kind: "edit" | "undo" | "redo",
  part: string | undefined
): WorldServerMessage {
  if ("needsConfirm" in result) {
    return {
      type: "needs-confirm",
      count: result.count,
      ports: result.ports.map((port) => ({
        name: port.name,
        dependents: port.dependents.map((dep) =>
          dep.kind === "snapshot"
            ? `capture ${dep.ref}`
            : `${dep.kind} ${dep.owner} ${dep.ref}`
        ),
      })),
      message: confirmSentence(result.ports),
    };
  }
  if ("error" in result) {
    if (result.runFault) {
      return { type: "error", errors: [], message: result.error };
    }
    return editRefused(kind, result.error, {
      part,
      refusal: result.refusal,
    });
  }
  return editedPayload(result);
}

function announce(
  project: string,
  world: string,
  part: string | undefined,
  result: DocumentEdit,
  historyWorld?: string
): void {
  publishWorldEvent(
    project,
    world,
    editedPayload(result, part, project, historyWorld ?? world)
  );
}

function editedPayload(
  result: DocumentEdit,
  part?: string,
  project?: string,
  world?: string
): WorldServerMessage {
  const histories =
    project !== undefined && world !== undefined
      ? historiesFor(project, world)
      : undefined;
  return {
    type: "edited",
    label: result.label,
    canUndo: result.canUndo,
    canRedo: result.canRedo,
    ...(part ? { part } : {}),
    ...(histories ? { histories } : {}),
    ...(result.warnings && result.warnings.length > 0
      ? { warnings: result.warnings }
      : {}),
    ...(result.moved ? { moved: result.moved } : {}),
  };
}

function openSession(
  project: string,
  world: string,
  part?: string
): { session: EditSession; key: string } | { error: string } {
  const root = absolutePath(project);
  const located = locatePart(root, world, part);
  if ("error" in located) return located;
  const key = canonical(located.file);
  const meta = sessionMeta.get(key) ?? { worlds: new Set<string>() };
  meta.worlds.add(worldKey(project, world));
  if (part) meta.part = part;
  sessionMeta.set(key, meta);
  if (part) partFileAlias.set(part, key);
  const found = sessions.get(key);
  if (found) return { session: found, key };
  const opened = EditSession.open({
    file: key,
    names: [...located.names, key],
    store: nodeStore,
    catalogDir: absolutePath(catalogRoot()),
    assetRoot: root,
  });
  if ("error" in opened) return opened;
  sessions.set(key, opened);
  return { session: opened, key };
}

/**
 * Re-key the session when the file moved, then restart the run.
 * The open document's own rename stops that doc after the clients
 * hear `moved`: the file is gone, and they reconnect at the new path.
 * A nested rename still restarts the document it was sent through.
 */
async function finishEdit(
  project: string,
  world: string,
  part: string | undefined,
  session: EditSession,
  beforeKey: string,
  result: DocumentEdit
): Promise<DocumentEdit | EditError> {
  rekey(project, session, beforeKey, result);
  if (result.moved && sameRel(result.moved.from, world)) {
    // The tab reconnects at the new path. Nested histories opened from
    // this document follow it, so undo still names them there.
    followMovedDocument(project, world, result.moved.to);
    announce(project, world, part, result, result.moved.to);
    await stopWorld(project, world);
    return result;
  }
  const restarted = await restartWorld(project, world);
  if ("error" in restarted) return { error: restarted.error, runFault: true };
  announce(project, world, part, result);
  return result;
}

function rekey(
  project: string,
  session: EditSession,
  beforeKey: string,
  result: DocumentEdit
): void {
  if (!result.moved && !result.renamed) return;
  const root = absolutePath(project);
  const nextFile = result.moved
    ? canonical(absolutePath(join(root, result.moved.to)))
    : canonical(session.file);
  const names = new Set<string>([
    ...(result.moved ? [result.moved.to, result.moved.from] : []),
    nextFile,
  ]);
  if (result.renamed) {
    names.add(result.renamed.from);
    names.add(result.renamed.to);
    partFileAlias.set(result.renamed.from, nextFile);
    partFileAlias.set(result.renamed.to, nextFile);
  }
  session.adopt(nextFile, [...names]);
  if (nextFile === beforeKey) return;
  sessions.delete(beforeKey);
  sessions.set(nextFile, session);
  const meta = sessionMeta.get(beforeKey);
  sessionMeta.delete(beforeKey);
  if (meta) sessionMeta.set(nextFile, meta);
}

/** Point every history of `from` at `to`. The file keys stay put. */
function followMovedDocument(project: string, from: string, to: string): void {
  const fromKey = worldKey(project, from);
  const toKey = worldKey(project, to);
  if (fromKey === toKey) return;
  for (const meta of sessionMeta.values()) {
    if (!meta.worlds.has(fromKey)) continue;
    meta.worlds.delete(fromKey);
    meta.worlds.add(toKey);
  }
}

function sameRel(a: string, b: string): boolean {
  const clean = (path: string) => path.replace(/\\/g, "/").replace(/^\.\//, "");
  return clean(a) === clean(b);
}

function locatePart(
  root: string,
  world: string,
  part?: string
): { file: string; names: string[] } | { error: string } {
  if (!part) {
    const file = absolutePath(join(root, world));
    return { file, names: [world, file] };
  }
  const file = partFilePath(root, part);
  if (file && nodeStore.exists(file)) {
    const rel = relative(root, file).split(sep).join("/");
    return { file, names: [part, rel, file] };
  }
  const aliased = partFileAlias.get(part);
  if (aliased) {
    const rel = relative(root, aliased).split(sep).join("/");
    return { file: aliased, names: [part, rel, aliased] };
  }
  return { error: `no part ${part}` };
}

function documentNames(
  project: string,
  world: string,
  part?: string
): Set<string> {
  const located = locatePart(absolutePath(project), world, part);
  if ("error" in located) return new Set([world]);
  return new Set(located.names);
}

function canonical(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

export { EXTERNAL_EDIT };
