/**
 * One open document. Apply, undo, and redo go through the pure edit,
 * then a load that reads the new text from an overlay instead of a
 * temp file in the project. Both the part and the lock are written to
 * `*.edit-tmp` markers, the part is renamed, then the lock. The markers
 * stay until both renames land. A crash between them leaves the lock
 * marker. The next open of an edit or a run finishes it. A part marker
 * with no lock marker is an edit that never committed; it is removed.
 */

import type {
  EditOp,
  LockFile,
  PartFile,
  RunReport,
} from "@sfab-bench/contract";

import { assetDir, isPartFile } from "./document";
import { applyEdit, type EditContext, editLabel, quantityOn } from "./edit";
import { expandPartType } from "./expand";
import { formatPart, partStyle } from "./format-part";
import { HISTORY_DEPTH, type HistoryStep } from "./history";
import { lockAfterEdit, replaceLevels } from "./level-edit";
import { type LibraryOptions, loadPartById, loadTypeById } from "./library";
import { loadWorldV2 } from "./load";
import { lockPathFor } from "./lock";
import { normalize } from "./path";
import { sha256Hex } from "./sha256";
import { canonicalJson } from "./si";
import type { Store } from "./store";

export const EXTERNAL_EDIT = "the document changed outside this session";

type SessionStep = HistoryStep & {
  lockBefore: string | null;
  lockAfter: string | null;
};

export type EditSessionOptions = {
  /** Absolute path of the part file. */
  file: string;
  /** Strings an operation may use in `document`, including this file. */
  names: readonly string[];
  store: Store;
  catalogDir: string;
  assetRoot: string;
  libraryDir?: string;
};

export type AppliedEdit = {
  label: string;
  canUndo: boolean;
  canRedo: boolean;
  report: RunReport;
};

export class EditSession {
  readonly file: string;
  private readonly names: readonly string[];
  private readonly store: Store;
  private readonly catalogDir: string;
  private readonly assetRoot: string;
  private readonly libraryDir: string | undefined;
  private text: string;
  private part: PartFile;
  private lockText: string | null;
  private undoStack: SessionStep[] = [];
  private redoStack: SessionStep[] = [];

  private constructor(opts: EditSessionOptions, text: string, part: PartFile) {
    this.file = opts.file;
    this.names = opts.names;
    this.store = opts.store;
    this.catalogDir = opts.catalogDir;
    this.assetRoot = opts.assetRoot;
    this.libraryDir = opts.libraryDir;
    this.text = text;
    this.part = part;
    const lock = lockPathFor(opts.file);
    this.lockText = opts.store.exists(lock) ? opts.store.readText(lock) : null;
  }

  static open(opts: EditSessionOptions): EditSession | { error: string } {
    const healed = healTornWrite(opts.store, opts.file);
    if (healed) return healed;
    let text: string;
    try {
      text = opts.store.readText(opts.file);
    } catch (err: unknown) {
      return {
        error: err instanceof Error ? err.message : "world file did not load",
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return { error: "world file is not JSON" };
    }
    if (!isPartFile(parsed)) return { error: "world file is not a document" };
    return new EditSession(opts, text, parsed);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  apply(op: EditOp, label?: string): AppliedEdit | { error: string } {
    const noted = this.noteDisk();
    if (noted === "bad") return { error: "world file is not a document" };
    if (noted === "drifted") {
      this.undoStack = [];
      this.redoStack = [];
    }
    if (this.readOnly()) return { error: "catalog part is read-only" };
    return this.commit(op, label ?? editLabel(op), true);
  }

  undo(): AppliedEdit | { error: string } {
    const step = this.undoStack[this.undoStack.length - 1];
    if (!step) return { error: "nothing to undo" };
    if (this.diskHash() !== step.after) return { error: EXTERNAL_EDIT };
    const applied = this.commit(
      step.inverse,
      step.label,
      false,
      step.lockBefore
    );
    if ("error" in applied) return applied;
    this.undoStack.pop();
    this.redoStack.push(step);
    return {
      label: step.label,
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      report: applied.report,
    };
  }

  redo(): AppliedEdit | { error: string } {
    const step = this.redoStack[this.redoStack.length - 1];
    if (!step) return { error: "nothing to redo" };
    if (this.diskHash() !== step.before) return { error: EXTERNAL_EDIT };
    const applied = this.commit(step.op, step.label, false, step.lockAfter);
    if ("error" in applied) return applied;
    this.redoStack.pop();
    this.undoStack.push(step);
    return {
      label: step.label,
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      report: applied.report,
    };
  }

  private commit(
    op: EditOp,
    label: string,
    record: boolean,
    lockOverride?: string | null
  ): AppliedEdit | { error: string } {
    const edited = applyEdit(this.part, op, this.context());
    if ("error" in edited) return { error: edited.error.message };
    let nextText: string;
    try {
      nextText = this.serialize(edited.part, op);
    } catch (err: unknown) {
      return {
        error: err instanceof Error ? err.message : "could not edit the part",
      };
    }
    const loaded = this.validate(nextText);
    if ("error" in loaded) return loaded;
    const built =
      lockOverride !== undefined
        ? lockOverride
        : this.nextLock(loaded.lock, edited.part.id);
    if (typeof built !== "string" && built !== null) return built;
    const lockText = built;
    const written = this.writePair(nextText, lockText);
    if (written) return written;
    let part: PartFile;
    try {
      part = JSON.parse(nextText) as PartFile;
    } catch {
      return { error: "world file is not JSON" };
    }
    const before = sha256Hex(this.text);
    const after = sha256Hex(nextText);
    const lockBefore = this.lockText;
    this.text = nextText;
    this.part = part;
    this.lockText = lockText;
    if (record && (before !== after || lockBefore !== lockText)) {
      this.redoStack = [];
      this.undoStack.push({
        label,
        op,
        inverse: edited.inverse,
        before,
        after,
        lockBefore,
        lockAfter: lockText,
      });
      if (this.undoStack.length > HISTORY_DEPTH) this.undoStack.shift();
    }
    if (!loaded.report) return { error: "world file did not load" };
    return {
      label,
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      report: loaded.report,
    };
  }

  private serialize(part: PartFile, op: EditOp): string {
    if (op.kind === "set-level" && part.play) {
      return replaceLevels(this.text, part.play.levels);
    }
    return formatPart(part, partStyle(this.text));
  }

  private validate(
    text: string
  ): { lock: LockFile; report: RunReport | null } | { error: string } {
    const loaded = loadWorldV2(this.file, {
      ...this.options(),
      store: overlayStore(this.store, this.file, text),
    });
    const blocked = loaded.diagnostics.filter(
      (diag) => diag.severity === "error"
    );
    if (blocked.length > 0 || !loaded.world || !loaded.lock) {
      const message = blocked.map((diag) => diag.message).join("; ");
      return { error: message || "world file did not load" };
    }
    return { lock: loaded.lock, report: loaded.report };
  }

  private nextLock(
    resolved: LockFile,
    partId: string
  ): string | null | { error: string } {
    if (!this.lockText) return formatLock(resolved, null);
    let pinned: LockFile;
    try {
      pinned = JSON.parse(this.lockText) as LockFile;
    } catch {
      return { error: "lock file is not JSON" };
    }
    const decided = lockAfterEdit(pinned, resolved, [partId]);
    if ("error" in decided) return decided;
    return formatLock(decided.lock, this.lockText);
  }

  /**
   * Both markers are written before either rename. A throw before the
   * part rename removes them. A throw after it leaves the lock marker
   * so the next open can finish the pair.
   */
  private writePair(
    partText: string,
    lockText: string | null
  ): { error: string } | null {
    if (partText === this.text && lockText === this.lockText) return null;
    const lockPath = lockPathFor(this.file);
    const partTmp = markerPath(this.file);
    const lockTmp = markerPath(lockPath);
    let partRenamed = false;
    try {
      this.store.writeText(partTmp, partText);
      this.store.writeText(lockTmp, lockText ?? "");
      this.store.rename(partTmp, this.file);
      partRenamed = true;
      if (lockText === null) {
        if (this.store.exists(lockPath)) this.store.remove(lockPath);
        this.store.remove(lockTmp);
      } else {
        this.store.rename(lockTmp, lockPath);
      }
    } catch (err: unknown) {
      if (!partRenamed) {
        try {
          this.store.remove(partTmp);
          this.store.remove(lockTmp);
        } catch {
          /* the write error is the one we return */
        }
      }
      return {
        error: err instanceof Error ? err.message : "could not write the part",
      };
    }
    return null;
  }

  private noteDisk(): "same" | "drifted" | "bad" {
    let disk: string;
    try {
      disk = this.store.readText(this.file);
    } catch {
      return "bad";
    }
    if (sha256Hex(disk) === sha256Hex(this.text)) return "same";
    let parsed: unknown;
    try {
      parsed = JSON.parse(disk) as unknown;
    } catch {
      return "bad";
    }
    if (!isPartFile(parsed)) return "bad";
    this.text = disk;
    this.part = parsed;
    const lock = lockPathFor(this.file);
    this.lockText = this.store.exists(lock) ? this.store.readText(lock) : null;
    return "drifted";
  }

  private diskHash(): string | null {
    try {
      return sha256Hex(this.store.readText(this.file));
    } catch {
      return null;
    }
  }

  private readOnly(): boolean {
    const doc = normalize(this.file);
    const root = normalize(this.catalogDir).replace(/\/$/, "");
    return doc === root || doc.startsWith(`${root}/`);
  }

  private context(): EditContext {
    const worldDir = assetDir(this.file);
    const opts = this.options();
    return {
      names: this.names,
      partById(id) {
        const found = loadPartById(worldDir, opts, id);
        return "part" in found ? found.part : null;
      },
      portsOf(id) {
        const found = loadPartById(worldDir, opts, id);
        if (!("part" in found)) return null;
        const part = found.part;
        if (typeof part.type !== "string") {
          return Object.keys(expandPartType(part.type).ports);
        }
        const type = loadTypeById(worldDir, opts, part.type);
        return "type" in type ? Object.keys(type.type.ports) : null;
      },
      quantityOf(id, name) {
        const found = loadPartById(worldDir, opts, id);
        return "part" in found ? quantityOn(found.part, name) : null;
      },
    };
  }

  private options(): LibraryOptions {
    return {
      store: this.store,
      catalogDir: this.catalogDir,
      assetRoot: this.assetRoot,
      ...(this.libraryDir ? { libraryDir: this.libraryDir } : {}),
    };
  }
}

const EDIT_MARKER = ".edit-tmp";

function markerPath(file: string): string {
  return `${file}${EDIT_MARKER}`;
}

/**
 * A lock marker finishes the pair. An empty one deletes the lock.
 * A part marker with no lock marker is removed; the part on disk is
 * still the one from before the edit.
 */
export function healTornWrite(
  store: Store,
  file: string
): { error: string } | null {
  const lockPath = lockPathFor(file);
  const partTmp = markerPath(file);
  const lockTmp = markerPath(lockPath);
  const partMarker = store.exists(partTmp);
  const lockMarker = store.exists(lockTmp);
  if (!partMarker && !lockMarker) return null;
  if (partMarker && !lockMarker) {
    try {
      store.remove(partTmp);
    } catch (err: unknown) {
      return {
        error: err instanceof Error ? err.message : "could not finish the edit",
      };
    }
    return null;
  }
  try {
    if (partMarker) store.rename(partTmp, file);
    const body = store.readText(lockTmp);
    if (body.length === 0) {
      if (store.exists(lockPath)) store.remove(lockPath);
      store.remove(lockTmp);
    } else {
      store.rename(lockTmp, lockPath);
    }
  } catch (err: unknown) {
    return {
      error: err instanceof Error ? err.message : "could not finish the edit",
    };
  }
  return null;
}

function formatLock(lock: LockFile, previous: string | null): string {
  if (previous && !previous.startsWith("{\n"))
    return `${canonicalJson(lock)}\n`;
  return `${JSON.stringify(lock, null, 2)}\n`;
}

function overlayStore(inner: Store, file: string, text: string): Store {
  const doc = normalize(file);
  const lock = normalize(lockPathFor(file));
  const refuse = (): never => {
    throw new Error("an overlay store does not write");
  };
  return {
    readText(path) {
      return normalize(path) === doc ? text : inner.readText(path);
    },
    exists(path) {
      const key = normalize(path);
      if (key === doc) return true;
      // The lock on disk still describes the previous text. Hiding it
      // lets the load build a lock instead of refusing the pin this
      // edit is about to replace.
      if (key === lock) return false;
      return inner.exists(path);
    },
    writeText: refuse,
    rename: refuse,
    remove: refuse,
  };
}
