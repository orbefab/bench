/**
 * One undo history per open document. Tools, the socket, and
 * `world_set_level` all write through `EditSession`. After a write the
 * run restarts once; the watcher then sees the same dependency stamp.
 */

import { realpathSync } from "node:fs";
import { join } from "node:path";

import type {
  EditOp,
  RunReport,
  WorldClientMessage,
  WorldServerMessage,
} from "@sfab-bench/contract";
import {
  EditSession,
  EXTERNAL_EDIT,
  editLabel,
  readEditOp,
} from "@sfab-bench/parts";

import { restartWorld } from "./host";
import { absolutePath, nodeStore } from "./node-store";
import { catalogRoot } from "./plan-host";

const sessions = new Map<string, EditSession>();

export type DocumentEdit = {
  label: string;
  canUndo: boolean;
  canRedo: boolean;
  report: RunReport;
  sentence: string;
};

export async function applyDocumentEdit(
  project: string,
  world: string,
  ops: EditOp[],
  label?: string
): Promise<DocumentEdit | { error: string }> {
  const session = openSession(project, world);
  if ("error" in session) return session;
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
  const applied = session.apply(op, label);
  if ("error" in applied) return applied;
  const restarted = await restartWorld(project, world);
  if ("error" in restarted) return restarted;
  return {
    ...applied,
    sentence: editSentence(applied.label, applied.canUndo),
  };
}

export async function undoDocument(
  project: string,
  world: string
): Promise<DocumentEdit | { error: string }> {
  const session = openSession(project, world);
  if ("error" in session) return session;
  const applied = session.undo();
  if ("error" in applied) return applied;
  const restarted = await restartWorld(project, world);
  if ("error" in restarted) return restarted;
  return {
    ...applied,
    sentence: `Undid ${applied.label}. ${redoSentence(applied.canRedo)}`,
  };
}

export async function redoDocument(
  project: string,
  world: string
): Promise<DocumentEdit | { error: string }> {
  const session = openSession(project, world);
  if ("error" in session) return session;
  const applied = session.redo();
  if ("error" in applied) return applied;
  const restarted = await restartWorld(project, world);
  if ("error" in restarted) return restarted;
  return {
    ...applied,
    sentence: `Redid ${applied.label}. ${undoSentence(applied.canUndo)}`,
  };
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

/** The live socket's edit, undo, and redo. */
export async function handleLiveEdit(
  project: string,
  world: string,
  message: Extract<WorldClientMessage, { type: "edit" | "undo" | "redo" }>
): Promise<WorldServerMessage> {
  if (message.type === "undo")
    return editedMessage(await undoDocument(project, world));
  if (message.type === "redo")
    return editedMessage(await redoDocument(project, world));
  const ops: EditOp[] = [];
  for (const item of message.ops) {
    const read = readEditOp(item);
    if ("error" in read)
      return { type: "error", errors: [], message: read.error };
    if (read.document !== world) {
      return {
        type: "error",
        errors: [],
        message: "an edit names a different document",
      };
    }
    ops.push(read);
  }
  if (ops.length === 0) {
    return { type: "error", errors: [], message: "edit needs operations" };
  }
  return editedMessage(
    await applyDocumentEdit(
      project,
      world,
      ops,
      message.label ?? editLabel(ops[0] as EditOp)
    )
  );
}

function editedMessage(
  result: DocumentEdit | { error: string }
): WorldServerMessage {
  if ("error" in result)
    return { type: "error", errors: [], message: result.error };
  return {
    type: "edited",
    label: result.label,
    canUndo: result.canUndo,
    canRedo: result.canRedo,
  };
}

function openSession(
  project: string,
  world: string
): EditSession | { error: string } {
  const file = absolutePath(join(project, world));
  const key = canonical(file);
  const found = sessions.get(key);
  if (found) return found;
  const opened = EditSession.open({
    file: key,
    names: [world, file, key],
    store: nodeStore,
    catalogDir: absolutePath(catalogRoot()),
    assetRoot: absolutePath(project),
  });
  if ("error" in opened) return opened;
  sessions.set(key, opened);
  return opened;
}

function canonical(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

export { EXTERNAL_EDIT };
