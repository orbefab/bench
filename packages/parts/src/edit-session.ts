/**
 * One open part. Apply, undo, and redo go through the pure edit, then a
 * load that reads the new text from an overlay. The part and every root
 * lock the edit re-pins are written to `*.edit-tmp` markers. A manifest
 * (`*.edit-set`) is the commit point when more than the part and its own
 * lock change. The next open of an edit or a run finishes a torn write.
 */

import type {
  EditOp,
  EditRefusal,
  LockFile,
  PartFile,
  RunReport,
} from "@sfab-bench/contract";

import {
  captureConfirmSentence,
  planAddCapture,
  planRemoveCapture,
} from "./capture-edit";
import { assetDir, isPartFile } from "./document";
import {
  applyEdit,
  documentNetlist,
  type EditContext,
  editLabel,
  quantityOn,
  refusalOf,
} from "./edit";
import { expandPartType } from "./expand";
import { formatPart, partStyle } from "./format-part";
import { HISTORY_DEPTH, type HistoryStep } from "./history";
import { lockAfterEdit, replaceLevels } from "./level-edit";
import { type LibraryOptions, loadPartById, loadTypeById } from "./library";
import { loadWorldV2 } from "./load";
import { lockPathFor } from "./lock";
import { normalize, relative } from "./path";
import {
  bindDependents,
  collectPartPorts,
  lockedRootsUsing,
  type PortDependent,
  type PortWorld,
  portDependents,
  portDomain,
  portNames,
} from "./ports";
import { type PlannedFile, planPartRename, type SkippedFile } from "./rename";import { sha256Hex } from "./sha256";
import { canonicalJson } from "./si";
import type { Store } from "./store";

export const EXTERNAL_EDIT = "the document changed outside this session";

type SavedFile = {
  path: string;
  before: string | null;
  after: string | null;
};

type SessionStep = HistoryStep & {
  lockBefore: string | null;
  lockAfter: string | null;
  files: SavedFile[];
  /** Absolute paths of the open document, when this step moved it. */
  relocated?: { before: string; after: string };
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
  /** Ports a break disconnected. Absent when the edit broke none. */
  warnings?: string[];
  /** Project-relative. Set when this step moved the open document. */
  moved?: { from: string; to: string };
  /** Part ids before and after this step. The server keeps aliases. */
  renamed?: { from: string; to: string };
  /** Project files a rename could not read, so it did not check them for the old id. */
  skipped?: SkippedFile[];
};

export type NeedsConfirm = {
  needsConfirm: true;
  count: number;
  ports: { name: string; dependents: PortDependent[] }[];
  /** Set when the port wording does not fit. */
  message?: string;
};

/** `refusal` is set when the pure edit refused, so a client need not read the sentence. */
export type EditResult =
  | AppliedEdit
  | { error: string; refusal?: EditRefusal }
  | NeedsConfirm;

export class EditSession {
  private filePath: string;
  private names: readonly string[];
  private readonly store: Store;
  private readonly catalogDir: string;
  private readonly assetRoot: string;
  private readonly libraryDir: string | undefined;
  private text: string;
  private part: PartFile;
  private lockText: string | null;
  private undoStack: SessionStep[] = [];
  private redoStack: SessionStep[] = [];
  /** Hashes of files the last edit wrote, so an outside change clears history. */
  private watched: { path: string; hash: string | null }[] = [];

  /** Absolute path of the part file. A rename moves it. */
  get file(): string {
    return this.filePath;
  }

  private constructor(opts: EditSessionOptions, text: string, part: PartFile) {
    this.filePath = opts.file;
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

  /** Point this session at the file it now edits. The server re-keys the map. */
  adopt(file: string, names: readonly string[]): void {
    this.filePath = file;
    this.names = names;
  }

  apply(op: EditOp, label?: string): EditResult {
    const noted = this.noteDisk();
    if (noted === "bad") return { error: "world file is not a document" };
    if (noted === "drifted") {
      this.undoStack = [];
      this.redoStack = [];
      this.watched = [];
    }
    if (this.readOnly()) return { error: "catalog part is read-only" };
    if (op.kind === "rename-part") {
      if (noted === "drifted") return { error: EXTERNAL_EDIT };
      if (this.under(this.libraryDir)) {
        return { error: "library part is read-only" };
      }
      return this.commitRename(op);
    }
    if (op.kind === "add-capture" || op.kind === "remove-capture") {
      return this.commitCapture(op, label);
    }
    return this.commit(op, label ?? editLabel(op));
  }

  undo(): EditResult {
    const step = this.undoStack[this.undoStack.length - 1];
    if (!step) return { error: "nothing to undo" };
    if (!this.filesMatch(step, "after")) return { error: EXTERNAL_EDIT };
    const applied = this.restore(step, "before");
    if ("error" in applied) return applied;
    this.undoStack.pop();
    this.redoStack.push(step);
    return {
      label: step.label,
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      report: applied.report,
      ...(applied.moved ? { moved: applied.moved } : {}),
      ...(applied.renamed ? { renamed: applied.renamed } : {}),
    };
  }

  redo(): EditResult {
    const step = this.redoStack[this.redoStack.length - 1];
    if (!step) return { error: "nothing to redo" };
    if (!this.filesMatch(step, "before")) return { error: EXTERNAL_EDIT };
    const applied = this.restore(step, "after");
    if ("error" in applied) return applied;
    this.redoStack.pop();
    this.undoStack.push(step);
    return {
      label: step.label,
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      report: applied.report,
      ...(applied.moved ? { moved: applied.moved } : {}),
      ...(applied.renamed ? { renamed: applied.renamed } : {}),
    };
  }

  private commitRename(
    op: Extract<EditOp, { kind: "rename-part" }>
  ): EditResult {
    const project = assetDir(this.file);
    const planned = planPartRename({
      store: this.store,
      projectDir: project,
      catalogDir: this.catalogDir,
      ...(this.libraryDir ? { libraryDir: this.libraryDir } : {}),
      file: this.file,
      text: this.text,
      part: this.part,
      to: op.to,
      document: op.document,
    });
    if ("error" in planned) return planned;
    const loaded = this.validateAt(planned.nextFile, planned.files);
    if ("error" in loaded) return loaded;
    const written = this.writeFiles(
      planned.files.map((file) => ({ path: file.path, text: file.text }))
    );
    if (written) return written;
    const fromFile = this.file;
    const lockBefore = this.lockText;
    const previousText =
      planned.files.find((file) => file.path === fromFile)?.before ?? "";
    const saved = planned.files.map((file) => ({
      path: file.path,
      before: file.before,
      after: file.text,
    }));
    const short = planned.fromId.split("/")[1]?.split("@")[0] ?? planned.fromId;
    const label = `renamed ${short} to ${op.to.trim()}`;
    this.filePath = planned.nextFile;
    this.text = planned.text;
    this.part = planned.part;
    const nextLock = planned.files.find(
      (file) => file.path === lockPathFor(planned.nextFile)
    );
    this.lockText = nextLock?.text ?? null;
    this.names = [
      ...new Set([
        ...this.names,
        planned.nextFile,
        planned.fromId,
        planned.toId,
        planned.fromRel,
        planned.toRel,
      ]),
    ].filter((name) => name !== fromFile);
    this.watched = saved.map((file) => ({
      path: file.path,
      hash: file.after === null ? null : sha256Hex(file.after),
    }));
    this.redoStack = [];
    this.undoStack.push({
      label,
      op,
      inverse: planned.inverse,
      before: sha256Hex(previousText),
      after: sha256Hex(planned.text),
      lockBefore,
      lockAfter: this.lockText,
      files: saved,
      relocated: { before: fromFile, after: planned.nextFile },
    });
    if (this.undoStack.length > HISTORY_DEPTH) this.undoStack.shift();
    if (!loaded.report) return { error: "world file did not load" };
    return {
      label,
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      report: loaded.report,
      moved: { from: planned.fromRel, to: planned.toRel },
      renamed: { from: planned.fromId, to: planned.toId },
      ...(planned.skipped.length > 0 ? { skipped: planned.skipped } : {}),
    };
  }

  private commitCapture(
    op: Extract<EditOp, { kind: "add-capture" | "remove-capture" }>,
    label?: string
  ): EditResult {
    const input = {
      store: this.store,
      projectDir: assetDir(this.file),
      catalogDir: this.catalogDir,
      ...(this.libraryDir ? { libraryDir: this.libraryDir } : {}),
      file: this.file,
      text: this.text,
      part: this.part,
    };
    const planned =
      op.kind === "add-capture"
        ? planAddCapture(input, op)
        : planRemoveCapture(input, op, op.confirm === "break");
    if ("error" in planned) return planned;
    if ("needsConfirm" in planned) {
      return {
        needsConfirm: true,
        count: planned.dependents.length,
        ports: [{ name: planned.variant, dependents: planned.dependents }],
        message: captureConfirmSentence(planned.variant, planned.dependents),
      };
    }
    const pinned = this.repin(planned.files, planned.refresh);
    if ("error" in pinned) return pinned;
    const files = [...planned.files, ...pinned.rows];
    const loaded = this.validateAt(this.file, files);
    if ("error" in loaded) return loaded;
    const written = this.writeFiles(
      files.map((file) => ({ path: file.path, text: file.text }))
    );
    if (written) return written;
    const before = sha256Hex(this.text);
    const lockBefore = this.lockText;
    const saved = files.map((file) => ({
      path: file.path,
      before: file.before,
      after: file.text,
    }));
    const own = files.find((file) => file.path === this.file);
    if (own?.text) {
      this.text = own.text;
      this.part = JSON.parse(own.text) as PartFile;
    }
    const lock = files.find((file) => file.path === lockPathFor(this.file));
    if (lock) this.lockText = lock.text;
    this.watched = saved.map((file) => ({
      path: file.path,
      hash: file.after === null ? null : sha256Hex(file.after),
    }));
    const stepLabel = label ?? planned.label;
    this.redoStack = [];
    this.undoStack.push({
      label: stepLabel,
      op,
      inverse: planned.inverse,
      before,
      after: sha256Hex(this.text),
      lockBefore,
      lockAfter: this.lockText,
      files: saved,
    });
    if (this.undoStack.length > HISTORY_DEPTH) this.undoStack.shift();
    if (!loaded.report) return { error: "world file did not load" };
    return {
      label: stepLabel,
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      report: loaded.report,
    };
  }

  /** Every root lock that depends on the refreshed parts, re-pinned against the planned files. */
  private repin(
    planned: PlannedFile[],
    refresh: string[]
  ): { rows: PlannedFile[] } | { error: string } {
    const project = assetDir(this.file);
    const target = refresh[0] as string;
    const roots = lockedRootsUsing(
      this.store,
      project,
      {
        catalogDir: this.catalogDir,
        ...(this.libraryDir ? { libraryDir: this.libraryDir } : {}),
      },
      target,
      ""
    );
    const rows: PlannedFile[] = [];
    for (const root of roots) {
      const lockPath = lockPathFor(root.file);
      let before: string;
      let pinned: LockFile;
      try {
        before = this.store.readText(lockPath);
        pinned = JSON.parse(before) as LockFile;
      } catch (err: unknown) {
        return {
          error: err instanceof Error ? err.message : "lock file did not load",
        };
      }
      const loaded = loadWorldV2(root.file, {
        ...this.options(),
        store: multiOverlay(this.store, [
          ...planned,
          { path: lockPath, text: null, before },
        ]),
      });
      const blocked = loaded.diagnostics.filter(
        (diag) => diag.severity === "error"
      );
      if (blocked.length > 0 || !loaded.lock) {
        const message = blocked.map((diag) => diag.message).join("; ");
        return { error: message || `${root.id} did not load` };
      }
      const decided = lockAfterEdit(pinned, loaded.lock, refresh);
      if ("error" in decided) return decided;
      const after = formatLock(decided.lock, before);
      if (after !== before) rows.push({ path: lockPath, text: after, before });
    }
    return { rows };
  }

  private commit(op: EditOp, label: string): EditResult {
    const edited = applyEdit(this.part, op, this.context());
    if ("error" in edited) {
      return {
        error: edited.error.message,
        refusal: refusalOf(edited.error),
      };
    }
    const sealed = this.sealPorts(this.part, edited.part, edited.inverse);
    if ("error" in sealed) return sealed;
    if (sealed.broken.length > 0 && op.confirm !== "break") {
      const count = sealed.broken.reduce(
        (n, port) => n + port.dependents.length,
        0
      );
      return { needsConfirm: true, count, ports: sealed.broken };
    }
    const part = sealed.part;
    const inverse = sealed.inverse;
    let nextText: string;
    try {
      nextText = this.serialize(part, op);
    } catch (err: unknown) {
      return {
        error: err instanceof Error ? err.message : "could not edit the part",
      };
    }
    const loaded = this.validate(nextText);
    if ("error" in loaded) return loaded;
    const parents = this.retargetRoots(part.id, nextText);
    if ("error" in parents) return parents;
    const own =
      this.lockText || parents.rows.length === 0
        ? this.nextLock(loaded.lock, part.id)
        : null;
    if (own !== null && typeof own !== "string") return own;
    const lockText = own;
    const files = this.changedFiles(nextText, lockText, parents.rows);
    const written = this.writeFiles(files);
    if (written) return written;
    const before = sha256Hex(this.text);
    const after = sha256Hex(nextText);
    const lockBefore = this.lockText;
    const saved = files.map((file) => ({
      path: file.path,
      before: file.before,
      after: file.text,
    }));
    this.text = nextText;
    this.part = part;
    this.lockText = lockText;
    this.watched = saved.map((file) => ({
      path: file.path,
      hash: file.after === null ? null : sha256Hex(file.after),
    }));
    if (saved.length > 0) {
      this.redoStack = [];
      this.undoStack.push({
        label,
        op,
        inverse,
        before,
        after,
        lockBefore,
        lockAfter: lockText,
        files: saved,
      });
      if (this.undoStack.length > HISTORY_DEPTH) this.undoStack.shift();
    }
    if (!loaded.report) return { error: "world file did not load" };
    const warnings =
      op.confirm === "break"
        ? sealed.broken.map(
            (port) =>
              `port ${port.name} (${port.dependents.map((dep) => dep.ref).join(", ")})`
          )
        : [];
    return {
      label,
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      report: loaded.report,
      ...(warnings && warnings.length > 0 ? { warnings } : {}),
    };
  }

  private serialize(part: PartFile, op: EditOp): string {
    if (op.kind === "set-level" && part.play) {
      return replaceLevels(this.text, part.play.levels);
    }
    return formatPart(part, partStyle(this.text));
  }

  /**
   * An auto port that already has a dependent keeps its name. When the
   * edit would rename it, or merge or split its net, the old name is
   * written into `expose` on the same undo step.
   */
  private sealPorts(
    before: PartFile,
    after: PartFile,
    inverse: EditOp
  ):
    | {
        part: PartFile;
        inverse: EditOp;
        broken: { name: string; dependents: PortDependent[] }[];
      }
    | { error: string } {
    const project = assetDir(this.file);
    const deps = portDependents(
      this.store,
      project,
      {
        catalogDir: this.catalogDir,
        ...(this.libraryDir ? { libraryDir: this.libraryDir } : {}),
      },
      before.id
    );
    const prior = bindDependents(
      collectPartPorts(this.portWorld(before), before.id),
      deps
    );
    const netlist = documentNetlist(after);
    const pins: { key: string; ref: string }[] = [];
    if (netlist) {
      let derived = collectPartPorts(this.portWorld(after), after.id);
      for (const port of prior) {
        if (port.source !== "auto" || port.dependents.length === 0) continue;
        const same = derived.find(
          (item) => item.name === port.name && sameRefs(item.refs, port.refs)
        );
        if (same) continue;
        const remaining = port.refs.filter((ref) =>
          derived.some((item) => item.refs.includes(ref))
        );
        if (remaining.length === 0) continue;
        const target = [...remaining].sort()[0];
        if (!target || netlist.expose[port.name]) continue;
        netlist.expose[port.name] = target;
        pins.push({ key: port.name, ref: target });
        derived = collectPartPorts(this.portWorld(after), after.id);
      }
    }
    const names = new Set(
      bindDependents(
        collectPartPorts(this.portWorld(after), after.id),
        deps
      ).map((port) => port.name)
    );
    const broken = prior
      .filter((port) => port.fixed && !names.has(port.name))
      .map((port) => ({ name: port.name, dependents: port.dependents }));
    let nextInverse = inverse;
    if (pins.length > 0) {
      nextInverse = {
        kind: "batch",
        document: inverse.document,
        label: "pin",
        ops: [
          inverse,
          {
            kind: "pin-expose",
            document: inverse.document,
            entries: pins,
            remove: true,
          },
        ],
      };
    }
    return { part: after, inverse: nextInverse, broken };
  }

  private retargetRoots(
    partId: string,
    nextText: string
  ):
    | { rows: { path: string; before: string; after: string }[] }
    | { error: string } {
    const project = assetDir(this.file);
    const roots = lockedRootsUsing(
      this.store,
      project,
      {
        catalogDir: this.catalogDir,
        ...(this.libraryDir ? { libraryDir: this.libraryDir } : {}),
      },
      partId,
      this.file
    );
    const rows: { path: string; before: string; after: string }[] = [];
    for (const root of roots) {
      const lockPath = lockPathFor(root.file);
      let before: string;
      try {
        before = this.store.readText(lockPath);
      } catch (err: unknown) {
        return {
          error: err instanceof Error ? err.message : "lock file did not load",
        };
      }
      const loaded = loadWorldV2(root.file, {
        ...this.options(),
        store: overlayStore(this.store, this.file, nextText, lockPath),
      });
      const blocked = loaded.diagnostics.filter(
        (diag) => diag.severity === "error"
      );
      if (blocked.length > 0 || !loaded.lock) {
        const message = blocked.map((diag) => diag.message).join("; ");
        return { error: message || `${root.id} did not load` };
      }
      let pinned: LockFile;
      try {
        pinned = JSON.parse(before) as LockFile;
      } catch {
        return { error: "lock file is not JSON" };
      }
      const decided = lockAfterEdit(pinned, loaded.lock, [partId]);
      if ("error" in decided) return decided;
      rows.push({
        path: lockPath,
        before,
        after: formatLock(decided.lock, before),
      });
    }
    return { rows };
  }

  private changedFiles(
    nextText: string,
    lockText: string | null,
    parents: { path: string; before: string; after: string }[]
  ): { path: string; text: string | null; before: string | null }[] {
    const files: {
      path: string;
      text: string | null;
      before: string | null;
    }[] = [];
    if (nextText !== this.text) {
      files.push({ path: this.file, text: nextText, before: this.text });
    }
    const lockPath = lockPathFor(this.file);
    if (lockText !== this.lockText) {
      files.push({ path: lockPath, text: lockText, before: this.lockText });
    }
    for (const parent of parents) {
      if (parent.after !== parent.before) {
        files.push({
          path: parent.path,
          text: parent.after,
          before: parent.before,
        });
      }
    }
    return files;
  }

  private restore(
    step: SessionStep,
    which: "before" | "after"
  ): AppliedEdit | { error: string } {
    const files = step.files.map((file) => ({
      path: file.path,
      text: file[which],
      before: null,
    }));
    const written = this.writeFiles(files);
    if (written) return written;
    const home = step.relocated ? step.relocated[which] : this.file;
    const partFile = step.files.find((file) => file.path === home);
    const partText = partFile ? partFile[which] : this.text;
    if (partText === null) return { error: "world file is not a document" };
    let part: PartFile;
    try {
      part = JSON.parse(partText) as PartFile;
    } catch {
      return { error: "world file is not JSON" };
    }
    if (!isPartFile(part)) return { error: "world file is not a document" };
    this.filePath = home;
    const lockFile = step.files.find((file) => file.path === lockPathFor(home));
    this.text = partText;
    this.part = part;
    if (lockFile) this.lockText = lockFile[which];
    else if (step.relocated) this.lockText = null;
    if (step.relocated) {
      const away =
        which === "before" ? step.relocated.after : step.relocated.before;
      this.names = [
        ...new Set(
          [...this.names, home, part.id].filter((name) => name !== away)
        ),
      ];
    }
    this.watched = step.files.map((file) => ({
      path: file.path,
      hash: file[which] === null ? null : sha256Hex(file[which] as string),
    }));
    const loaded = this.validate(partText);
    if ("error" in loaded) return loaded;
    if (!loaded.report) return { error: "world file did not load" };
    const relocated = movedOf(step, which, part.id);
    return {
      label: step.label,
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      report: loaded.report,
      ...(relocated.moved ? { moved: relocated.moved } : {}),
      ...(relocated.renamed ? { renamed: relocated.renamed } : {}),
    };
  }

  private filesMatch(step: SessionStep, which: "before" | "after"): boolean {
    if (step.files.length === 0) {
      const want = which === "after" ? step.after : step.before;
      return this.diskHash() === want;
    }
    for (const file of step.files) {
      const disk = this.diskText(file.path);
      const want = file[which];
      if (disk === null && want === null) continue;
      if (disk === null || want === null) return false;
      if (sha256Hex(disk) !== sha256Hex(want)) return false;
    }
    return true;
  }

  private writeFiles(
    files: { path: string; text: string | null }[]
  ): { error: string } | null {
    if (files.length === 0) return null;
    const lockPath = lockPathFor(this.file);
    const pair = files.every(
      (file) => file.path === this.file || file.path === lockPath
    );
    if (pair) {
      const part = files.find((file) => file.path === this.file);
      const lock = files.find((file) => file.path === lockPath);
      return this.writePair(
        part?.text ?? this.text,
        lock ? lock.text : this.lockText
      );
    }
    return writeEditSet(this.store, files);
  }

  private validateAt(
    file: string,
    files: PlannedFile[]
  ): { lock: LockFile; report: RunReport | null } | { error: string } {
    const loaded = loadWorldV2(file, {
      ...this.options(),
      store: multiOverlay(this.store, files),
    });
    const blocked = loaded.diagnostics.filter(
      (diag) => diag.severity === "error"
    );
    if (blocked.length > 0 || !loaded.run || !loaded.lock) {
      const message = blocked.map((diag) => diag.message).join("; ");
      return { error: message || "world file did not load" };
    }
    return { lock: loaded.lock, report: loaded.report };
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
    if (blocked.length > 0 || !loaded.run || !loaded.lock) {
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
    if (this.watchedDrifted()) {
      this.undoStack = [];
      this.redoStack = [];
      this.watched = [];
    }
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
    const text = this.diskText(this.file);
    return text === null ? null : sha256Hex(text);
  }

  private diskText(path: string): string | null {
    if (!this.store.exists(path)) return null;
    try {
      return this.store.readText(path);
    } catch {
      return null;
    }
  }

  private watchedDrifted(): boolean {
    for (const file of this.watched) {
      const disk = this.diskText(file.path);
      const hash = disk === null ? null : sha256Hex(disk);
      if (hash !== file.hash) return true;
    }
    return false;
  }

  private portWorld(focus?: PartFile): PortWorld {
    const worldDir = assetDir(this.file);
    const opts = this.options();
    return {
      part(id) {
        if (focus && id === focus.id) return focus;
        const found = loadPartById(worldDir, opts, id);
        return "part" in found ? found.part : null;
      },
      typePorts(part) {
        if (typeof part.type !== "string") {
          return expandPartType(part.type).ports;
        }
        const type = loadTypeById(worldDir, opts, part.type);
        return "type" in type ? type.type.ports : null;
      },
    };
  }

  private readOnly(): boolean {
    return this.under(this.catalogDir);
  }

  private under(root: string | undefined): boolean {
    if (!root) return false;
    const doc = normalize(this.file);
    const base = normalize(root).replace(/\/$/, "");
    return doc === base || doc.startsWith(`${base}/`);
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
      portsOf: (id) => portNames(this.portWorld(), id),
      domainOf: (id, port) => portDomain(this.portWorld(), id, port),
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
  const set = finishEditSet(store, file);
  if (set) return set.error ? { error: set.error } : null;
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

function sameRefs(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((ref, index) => ref === right[index]);
}

const EDIT_SET = ".edit-set";

type SetRow = { path: string; empty: boolean };

function writeEditSet(
  store: Store,
  files: { path: string; text: string | null }[]
): { error: string } | null {
  const rows: SetRow[] = files.map((file) => ({
    path: file.path,
    empty: file.text === null,
  }));
  const manifest = (committed: boolean) =>
    `${JSON.stringify({ committed, files: rows })}\n`;
  let committed = false;
  try {
    for (const file of files) {
      store.writeText(`${file.path}${EDIT_SET}`, manifest(false));
    }
    for (const file of files) {
      store.writeText(`${file.path}${EDIT_MARKER}`, file.text ?? "");
    }
    for (const file of files) {
      store.writeText(`${file.path}${EDIT_SET}`, manifest(true));
    }
    committed = true;
    for (const file of files) {
      const tmp = `${file.path}${EDIT_MARKER}`;
      if (file.text === null) {
        if (store.exists(file.path)) store.remove(file.path);
        if (store.exists(tmp)) store.remove(tmp);
      } else {
        store.rename(tmp, file.path);
      }
    }
    for (const file of files) store.remove(`${file.path}${EDIT_SET}`);
  } catch (err: unknown) {
    if (!committed) {
      for (const file of files) {
        try {
          store.remove(`${file.path}${EDIT_MARKER}`);
          store.remove(`${file.path}${EDIT_SET}`);
        } catch {
          /* the write error is the one we return */
        }
      }
    }
    return {
      error: err instanceof Error ? err.message : "could not write the part",
    };
  }
  return null;
}

/**
 * A committed manifest finishes every file in the set. An uncommitted
 * one is discarded. Returns null when this file has no manifest.
 */
function finishEditSet(store: Store, file: string): { error?: string } | null {
  const markers = [`${file}${EDIT_SET}`, `${lockPathFor(file)}${EDIT_SET}`];
  const marker = markers.find((path) => store.exists(path));
  if (!marker) return null;
  let parsed: { committed?: boolean; files?: SetRow[] };
  try {
    parsed = JSON.parse(store.readText(marker)) as {
      committed?: boolean;
      files?: SetRow[];
    };
  } catch (err: unknown) {
    return {
      error: err instanceof Error ? err.message : "could not finish the edit",
    };
  }
  const files = parsed.files ?? [];
  try {
    if (!parsed.committed) {
      for (const row of files) {
        if (store.exists(`${row.path}${EDIT_MARKER}`)) {
          store.remove(`${row.path}${EDIT_MARKER}`);
        }
        if (store.exists(`${row.path}${EDIT_SET}`)) {
          store.remove(`${row.path}${EDIT_SET}`);
        }
      }
      return {};
    }
    for (const row of files) {
      const tmp = `${row.path}${EDIT_MARKER}`;
      if (!store.exists(tmp)) continue;
      if (row.empty) {
        if (store.exists(row.path)) store.remove(row.path);
        store.remove(tmp);
      } else {
        store.rename(tmp, row.path);
      }
    }
    for (const row of files) {
      if (store.exists(`${row.path}${EDIT_SET}`)) {
        store.remove(`${row.path}${EDIT_SET}`);
      }
    }
  } catch (err: unknown) {
    return {
      error: err instanceof Error ? err.message : "could not finish the edit",
    };
  }
  return {};
}

function movedOf(
  step: SessionStep,
  which: "before" | "after",
  toId: string
): {
  moved?: { from: string; to: string };
  renamed?: { from: string; to: string };
} {
  if (!step.relocated) return {};
  const fromAbs =
    which === "before" ? step.relocated.after : step.relocated.before;
  const toAbs = step.relocated[which];
  const project = assetDir(toAbs);
  const rel = (file: string) =>
    relative(normalize(project), normalize(file)).split("\\").join("/");
  const fromText = step.files.find((file) => file.path === fromAbs)?.[
    which === "before" ? "after" : "before"
  ];
  let fromId = "";
  if (fromText) {
    try {
      const parsed = JSON.parse(fromText) as { id?: string };
      if (typeof parsed.id === "string") fromId = parsed.id;
    } catch {
      fromId = "";
    }
  }
  return {
    moved: { from: rel(fromAbs), to: rel(toAbs) },
    ...(fromId ? { renamed: { from: fromId, to: toId } } : {}),
  };
}

function multiOverlay(inner: Store, files: readonly PlannedFile[]): Store {
  const text = new Map<string, string | null>();
  for (const file of files) text.set(normalize(file.path), file.text);
  const refuse = (): never => {
    throw new Error("an overlay store does not write");
  };
  return {
    readText(path) {
      const key = normalize(path);
      if (!text.has(key)) return inner.readText(path);
      const body = text.get(key);
      if (body === null || body === undefined) {
        throw new Error("missing");
      }
      return body;
    },
    exists(path) {
      const key = normalize(path);
      if (text.has(key)) return text.get(key) !== null;
      return inner.exists(path);
    },
    writeText: refuse,
    rename: refuse,
    remove: refuse,
    list(path) {
      return inner.list(path);
    },
  };
}

function overlayStore(
  inner: Store,
  file: string,
  text: string,
  alsoHide?: string
): Store {
  const doc = normalize(file);
  const hidden = new Set<string>([normalize(lockPathFor(file))]);
  if (alsoHide) hidden.add(normalize(alsoHide));
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
      if (hidden.has(key)) return false;
      return inner.exists(path);
    },
    writeText: refuse,
    rename: refuse,
    remove: refuse,
    list(path) {
      return inner.list(path);
    },
  };
}
