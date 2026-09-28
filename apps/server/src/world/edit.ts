/**
 * One undo history per open document. Tools, the socket, and
 * `world_set_level` all write through `EditSession`. After a write the
 * run restarts once; the watcher then sees the same dependency stamp.
 */

import { realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type {
  EditOp,
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
  warnings?: string[];
};

export async function applyDocumentEdit(
  project: string,
  world: string,
  ops: EditOp[],
  label?: string,
  part?: string,
  confirm?: "break"
): Promise<DocumentEdit | NeedsConfirm | { error: string }> {
  const session = openSession(project, world, part);
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
  const restarted = await restartWorld(project, world);
  if ("error" in restarted) return restarted;
  return {
    ...applied,
    sentence: editSentence(applied.label, applied.canUndo),
  };
}

export async function undoDocument(
  project: string,
  world: string,
  part?: string
): Promise<DocumentEdit | { error: string }> {
  const session = openSession(project, world, part);
  if ("error" in session) return session;
  const applied = session.undo();
  if ("needsConfirm" in applied) return { error: "nothing to undo" };
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
  world: string,
  part?: string
): Promise<DocumentEdit | { error: string }> {
  const session = openSession(project, world, part);
  if ("error" in session) return session;
  const applied = session.redo();
  if ("needsConfirm" in applied) return { error: "nothing to redo" };
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
    return editedMessage(await undoDocument(project, world, message.part));
  if (message.type === "redo")
    return editedMessage(await redoDocument(project, world, message.part));
  const allowed = documentNames(project, world, message.part);
  const ops: EditOp[] = [];
  for (const item of message.ops) {
    const read = readEditOp(item);
    if ("error" in read)
      return { type: "error", errors: [], message: read.error };
    if (!allowed.has(read.document)) {
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
      message.label ?? editLabel(ops[0] as EditOp),
      message.part,
      message.confirm
    )
  );
}

function editedMessage(
  result: DocumentEdit | NeedsConfirm | { error: string }
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
  if ("error" in result)
    return { type: "error", errors: [], message: result.error };
  return {
    type: "edited",
    label: result.label,
    canUndo: result.canUndo,
    canRedo: result.canRedo,
    ...(result.warnings && result.warnings.length > 0
      ? { warnings: result.warnings }
      : {}),
  };
}

function openSession(
  project: string,
  world: string,
  part?: string
): EditSession | { error: string } {
  const root = absolutePath(project);
  const located = locatePart(root, world, part);
  if ("error" in located) return located;
  const key = canonical(located.file);
  const found = sessions.get(key);
  if (found) return found;
  const opened = EditSession.open({
    file: key,
    names: [...located.names, key],
    store: nodeStore,
    catalogDir: absolutePath(catalogRoot()),
    assetRoot: root,
  });
  if ("error" in opened) return opened;
  sessions.set(key, opened);
  return opened;
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
  if (!file) return { error: `no part ${part}` };
  const rel = relative(root, file).split(sep).join("/");
  return { file, names: [part, rel, file] };
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
