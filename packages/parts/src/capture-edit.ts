/**
 * Plan `add-capture` and `remove-capture`. Nothing is written here: the
 * session checks the planned files load, re-pins the locks, and commits
 * the set as one undo step. A project part carries the variant in its own
 * file; any other part gets it in the project's level overlay, and the
 * library file is never touched.
 */

import type {
  AxisName,
  EditOp,
  LevelOverlayFile,
  LevelSpec,
  PartFile,
} from "@sfab-bench/contract";
import { LEVEL_OVERLAY_FORMAT, SNAPSHOT_FORMAT } from "@sfab-bench/contract";

import { partFilePath } from "./document";
import { formatPart, partStyle } from "./format-part";
import { replaceLevels } from "./level-edit";
import { type LibraryOptions, loadPartById } from "./library";
import { join, normalize, relative } from "./path";
import {
  findPartFile,
  lockedRootsUsing,
  netlistsOf,
  type PortDependent,
} from "./ports";
import type { PlannedFile } from "./rename";
import { parsePartRef } from "./si";
import type { Store } from "./store";

export type CaptureInput = {
  store: Store;
  projectDir: string;
  catalogDir: string;
  libraryDir?: string;
  /** The session document and its text. */
  file: string;
  text: string;
  part: PartFile;
};

export type PlannedCapture = {
  files: PlannedFile[];
  label: string;
  inverse: EditOp;
  /** Part ids whose lock rows the step moves. */
  refresh: string[];
};

export type CaptureNeedsConfirm = {
  needsConfirm: true;
  variant: string;
  dependents: PortDependent[];
};

type AddOp = Extract<EditOp, { kind: "add-capture" }>;
type RemoveOp = Extract<EditOp, { kind: "remove-capture" }>;

const COUNTER = "snapshots/.captures.json";
const VARIANT = /^[A-Za-z0-9_-]+$/;

export function nextCaptureRef(
  store: Store,
  projectDir: string,
  partId: string,
  axis: AxisName
): string | null {
  const parsed = parsePartRef(partId);
  if (!parsed) return null;
  const stem = `${parsed.name}-${axis}-`;
  const counter = readCounter(store, projectDir)[counterKey(partId, axis)] ?? 0;
  let top = counter;
  const dir = join(projectDir, "snapshots", parsed.publisher);
  let names: string[] = [];
  try {
    names = store.list(dir);
  } catch {
    names = [];
  }
  for (const name of names) {
    if (!name.startsWith(stem) || !name.endsWith(`@${parsed.version}.json`)) {
      continue;
    }
    const n = Number(name.slice(stem.length, name.indexOf("@")));
    if (Number.isInteger(n) && n > top) top = n;
  }
  return `${parsed.publisher}/${stem}${top + 1}@${parsed.version}`;
}

export function planAddCapture(
  input: CaptureInput,
  op: AddOp
): PlannedCapture | { error: string } {
  const target = resolveTarget(input, op.part);
  if ("error" in target) return target;
  const level = String(op.level);
  const slot = target.view.axes?.[op.axis]?.[level as "0"];
  if (!slot) {
    return {
      error: `${target.id} has no ${op.axis} level ${level}; a capture goes to a level the part already has`,
    };
  }
  if (!VARIANT.test(op.variant)) {
    return { error: `${op.variant} is not a variant name` };
  }
  if (op.variant in slot.variants) {
    return {
      error: `${op.axis} level ${level} of ${target.id} already has a variant ${op.variant}`,
    };
  }
  const parsed = parsePartRef(target.id);
  const ref = parsePartRef(op.ref);
  if (!parsed || !ref || ref.publisher !== parsed.publisher) {
    return { error: `${op.ref} is not a snapshot of ${target.id}` };
  }
  const shape = new RegExp(`^${escapeRe(parsed.name)}-${op.axis}-(\\d+)$`).exec(
    ref.name
  );
  if (!shape || ref.version !== parsed.version) {
    return { error: `${op.ref} is not a capture of ${target.id} ${op.axis}` };
  }
  const restoring = op.restore === true;
  if (!restoring) {
    const next = nextCaptureRef(
      input.store,
      input.projectDir,
      target.id,
      op.axis
    );
    if (op.ref !== next) {
      return { error: `capture number taken; the next is ${next}` };
    }
  }
  const files: PlannedFile[] = [];
  const snapshotFile = snapshotPath(input.projectDir, op.ref);
  if (!(restoring && op.snapshot === "")) {
    let snap: { format?: unknown };
    try {
      snap = JSON.parse(op.snapshot) as { format?: unknown };
    } catch {
      return { error: "the snapshot is not JSON" };
    }
    if (snap.format !== SNAPSHOT_FORMAT) {
      return { error: `the snapshot is not ${SNAPSHOT_FORMAT}` };
    }
    if (input.store.exists(snapshotFile)) {
      return { error: `${op.ref} already exists` };
    }
    files.push({ path: snapshotFile, text: op.snapshot, before: null });
  }
  if (!restoring) {
    const counter = readCounter(input.store, input.projectDir);
    counter[counterKey(target.id, op.axis)] = Number(shape[1]);
    files.push(counterFile(input, counter));
  }
  const impl = {
    kind: "snapshot" as const,
    ref: op.ref,
    omits: op.omits ?? [],
  };
  if (target.overlay === null) {
    const next = structuredClone(input.part);
    const map = next.axes?.[op.axis] as Record<
      string,
      { variants: Record<string, unknown> }
    >;
    (map[level] as { variants: Record<string, unknown> }).variants[op.variant] =
      impl;
    files.push({
      path: input.file,
      text: formatPart(next, partStyle(input.text)),
      before: input.text,
    });
  } else {
    const doc = target.overlay.doc;
    const axes = doc.axes as Record<
      string,
      Record<string, { variants: Record<string, unknown> }>
    >;
    const map = axes[op.axis] ?? {};
    axes[op.axis] = map;
    const slot = map[level] ?? { variants: {} };
    map[level] = slot;
    slot.variants[op.variant] = impl;
    files.push({
      path: target.overlay.file,
      text: `${JSON.stringify(doc, null, 2)}\n`,
      before: target.overlay.before,
    });
  }
  return {
    files,
    label: `captured ${op.axis} level ${level} as ${op.variant}`,
    inverse: {
      kind: "remove-capture",
      document: op.document,
      ...(op.part ? { part: op.part } : {}),
      axis: op.axis,
      level: op.level,
      variant: op.variant,
    },
    refresh: [target.id],
  };
}

export function planRemoveCapture(
  input: CaptureInput,
  op: RemoveOp,
  confirmed: boolean
): PlannedCapture | CaptureNeedsConfirm | { error: string } {
  const target = resolveTarget(input, op.part);
  if ("error" in target) return target;
  const level = String(op.level);
  const slot = target.view.axes?.[op.axis]?.[level as "0"];
  const impl = slot?.variants[op.variant];
  if (!slot || !impl) {
    return {
      error: `${op.axis} level ${level} of ${target.id} has no variant ${op.variant}`,
    };
  }
  if (impl.kind !== "snapshot") {
    return { error: `${op.variant} is not a capture` };
  }
  if (slot.default === op.variant) {
    return {
      error: `${op.variant} is the default of ${op.axis} level ${level}; choose another default first`,
    };
  }
  const held = target.overlay
    ? (
        target.overlay.doc.axes as Record<
          string,
          Record<string, { variants: Record<string, unknown> }> | undefined
        >
      )[op.axis]?.[level]?.variants
    : slot.variants;
  if (!held || !(op.variant in held)) {
    return {
      error: `${op.variant} is a library variant; the library is read-only`,
    };
  }

  const scanned = scanRules(input, target.id, op);
  if ("error" in scanned) return scanned;
  if (scanned.dependents.length > 0 && !confirmed) {
    return {
      needsConfirm: true,
      variant: op.variant,
      dependents: scanned.dependents,
    };
  }

  const files: PlannedFile[] = [];
  const mutated = scanned.docs;
  const own = mutated.get(normalize(input.file));
  if (target.overlay === null && own) {
    const map = own.part.axes?.[op.axis] as Record<
      string,
      { variants: Record<string, unknown> }
    >;
    delete (map[level] as { variants: Record<string, unknown> }).variants[
      op.variant
    ];
    own.changed = own.structure = true;
  }
  for (const doc of mutated.values()) {
    if (!doc.changed) continue;
    files.push({
      path: doc.file,
      text:
        doc.play && !doc.structure
          ? replaceLevels(doc.text, doc.part.play?.levels as never)
          : formatPart(doc.part, partStyle(doc.text)),
      before: doc.text,
    });
  }
  if (target.overlay !== null) {
    const doc = target.overlay.doc;
    const axes = doc.axes as Record<
      string,
      Record<string, { variants: Record<string, unknown> }>
    >;
    const map = axes[op.axis] as Record<
      string,
      { variants: Record<string, unknown> }
    >;
    delete (map[level] as { variants: Record<string, unknown> }).variants[
      op.variant
    ];
    if (
      Object.keys((map[level] as { variants: object }).variants).length === 0
    ) {
      delete map[level];
    }
    if (Object.keys(map).length === 0) delete axes[op.axis];
    files.push({
      path: target.overlay.file,
      text:
        Object.keys(axes).length === 0
          ? null
          : `${JSON.stringify(doc, null, 2)}\n`,
      before: target.overlay.before,
    });
  }
  const shared = Object.values(
    (target.view.axes?.[op.axis] ?? {}) as Record<
      string,
      { variants: Record<string, { kind: string; ref?: string }> }
    >
  ).some((row) =>
    Object.entries(row.variants).some(
      ([name, item]) =>
        item.kind === "snapshot" &&
        item.ref === impl.ref &&
        !(row === slot && name === op.variant)
    )
  );
  const snapshotFile = snapshotPath(input.projectDir, impl.ref);
  let snapshot = "";
  if (!shared && input.store.exists(snapshotFile)) {
    snapshot = input.store.readText(snapshotFile);
    files.push({ path: snapshotFile, text: null, before: snapshot });
  }
  return {
    files,
    label: `removed the capture ${op.variant} from ${op.axis} level ${level}`,
    inverse: {
      kind: "add-capture",
      document: op.document,
      ...(op.part ? { part: op.part } : {}),
      axis: op.axis,
      level: op.level,
      variant: op.variant,
      ref: impl.ref,
      snapshot,
      omits: impl.omits,
      restore: true,
    },
    refresh: [target.id, ...scanned.touched],
  };
}

export function captureConfirmSentence(
  variant: string,
  dependents: PortDependent[]
): string {
  const list = dependents.map((row) => `${row.owner} ${row.ref}`).join("; ");
  const noun = dependents.length === 1 ? "level rule" : "level rules";
  return `This removes ${variant}, which ${dependents.length} ${noun} select (${list}). Nothing changed. Send it again with break to put those rules back on the level's default.`;
}

type Target = {
  id: string;
  /** The part with any overlay merged in. */
  view: PartFile;
  /** Null when the variant lives in the part's own file. */
  overlay: {
    file: string;
    doc: LevelOverlayFile;
    before: string | null;
  } | null;
};

function resolveTarget(
  input: CaptureInput,
  named: string | undefined
): Target | { error: string } {
  const id = named ?? input.part.id;
  const own = partFilePath(input.projectDir, id);
  if (id === input.part.id && own && normalize(own) === normalize(input.file)) {
    return { id, view: input.part, overlay: null };
  }
  if (own && input.store.exists(own)) {
    return { error: `open ${id} to capture it` };
  }
  const options: LibraryOptions = {
    store: input.store,
    catalogDir: input.catalogDir,
    assetRoot: input.projectDir,
    ...(input.libraryDir ? { libraryDir: input.libraryDir } : {}),
  };
  if (!findPartFile(input.store, input.projectDir, options, id)) {
    return { error: `no part ${id}` };
  }
  const loaded = loadPartById(input.projectDir, options, id);
  if (!("part" in loaded)) return { error: loaded.message };
  const parsed = parsePartRef(id);
  if (!parsed) return { error: `${id} is not a part id` };
  const file = join(
    input.projectDir,
    "overlays",
    parsed.publisher,
    `${parsed.name}@${parsed.version}.levels.json`
  );
  let before: string | null = null;
  let doc: LevelOverlayFile = {
    format: LEVEL_OVERLAY_FORMAT,
    part: id,
    axes: {},
  };
  if (input.store.exists(file)) {
    before = input.store.readText(file);
    try {
      doc = JSON.parse(before) as LevelOverlayFile;
    } catch {
      return { error: "the level overlay is not JSON" };
    }
    doc.axes ??= {};
  }
  return { id, view: loaded.part, overlay: { file, doc, before } };
}

type ScannedDoc = {
  file: string;
  text: string;
  part: PartFile;
  changed: boolean;
  /** play.levels changed. */
  play: boolean;
  /** Something other than play.levels changed. */
  structure: boolean;
};

/** Level rules that select the variant, in every project document that uses the part. */
function scanRules(
  input: CaptureInput,
  targetId: string,
  op: RemoveOp
):
  | {
      dependents: PortDependent[];
      docs: Map<string, ScannedDoc>;
      touched: string[];
    }
  | { error: string } {
  const opts = {
    catalogDir: input.catalogDir,
    ...(input.libraryDir ? { libraryDir: input.libraryDir } : {}),
  };
  const roots = lockedRootsUsing(
    input.store,
    input.projectDir,
    opts,
    targetId,
    "",
    false
  );
  const docs = new Map<string, ScannedDoc>();
  const add = (file: string, text: string, part: PartFile) => {
    docs.set(normalize(file), {
      file,
      text,
      part,
      changed: false,
      play: false,
      structure: false,
    });
  };
  add(input.file, input.text, structuredClone(input.part));
  for (const root of roots) {
    if (docs.has(normalize(root.file))) continue;
    const text = input.store.readText(root.file);
    add(root.file, text, JSON.parse(text) as PartFile);
  }
  const dependents: PortDependent[] = [];
  const touched: string[] = [];
  const picks = (spec: LevelSpec | undefined): boolean => {
    if (spec === undefined || typeof spec !== "object") return false;
    const pick = spec[op.axis];
    return (
      typeof pick === "object" &&
      pick.class === op.level &&
      pick.variant === op.variant
    );
  };
  const drop = (spec: LevelSpec): LevelSpec => {
    const next = { ...(spec as object) } as Record<string, unknown>;
    next[op.axis] = op.level;
    return next as LevelSpec;
  };
  for (const doc of docs.values()) {
    const rel = relative(normalize(input.projectDir), normalize(doc.file));
    const levels = doc.part.play?.levels;
    if (levels) {
      if (picks(levels.default)) {
        dependents.push(dep(doc.part.id, `default ${rel}`, op));
        levels.default = drop(levels.default);
        doc.changed = doc.play = true;
      }
      for (const group of ["types", "paths"] as const) {
        const rules = levels[group];
        if (!rules) continue;
        for (const [key, spec] of Object.entries(rules)) {
          if (!picks(spec)) continue;
          dependents.push(dep(doc.part.id, `${group}.${key} ${rel}`, op));
          rules[key] = drop(spec);
          doc.changed = doc.play = true;
        }
      }
    }
    for (const netlist of netlistsOf(doc.part)) {
      for (const [name, inst] of Object.entries(netlist.instances)) {
        if (inst.part !== targetId || !picks(inst.level)) continue;
        dependents.push(dep(doc.part.id, `instance ${name} ${rel}`, op));
        inst.level = drop(inst.level as LevelSpec);
        doc.changed = doc.structure = true;
      }
    }
    if (doc.changed) touched.push(doc.part.id);
  }
  for (const doc of docs.values()) {
    if (!doc.structure || normalize(doc.file) === normalize(input.file))
      continue;
    if (formatPart(JSON.parse(doc.text), partStyle(doc.text)) !== doc.text) {
      return {
        error: `cannot rewrite ${relative(normalize(input.projectDir), normalize(doc.file))}; change its level rule first`,
      };
    }
  }
  return { dependents, docs, touched };
}

function dep(owner: string, where: string, op: RemoveOp): PortDependent {
  return {
    kind: "level",
    owner,
    ref: `${op.axis} ${op.level} ${op.variant} (${where})`,
  };
}

function snapshotPath(projectDir: string, ref: string): string {
  const parsed = parsePartRef(ref);
  if (!parsed) return join(projectDir, "snapshots", `${ref}.json`);
  return join(
    projectDir,
    "snapshots",
    parsed.publisher,
    `${parsed.name}@${parsed.version}.json`
  );
}

function counterKey(partId: string, axis: AxisName): string {
  const parsed = parsePartRef(partId);
  return parsed
    ? `${parsed.publisher}/${parsed.name}-${axis}@${parsed.version}`
    : `${partId}-${axis}`;
}

function readCounter(store: Store, projectDir: string): Record<string, number> {
  const file = join(projectDir, COUNTER);
  if (!store.exists(file)) return {};
  try {
    return JSON.parse(store.readText(file)) as Record<string, number>;
  } catch {
    return {};
  }
}

function counterFile(
  input: CaptureInput,
  counter: Record<string, number>
): PlannedFile {
  const file = join(input.projectDir, COUNTER);
  const sorted = Object.fromEntries(
    Object.entries(counter).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  );
  return {
    path: file,
    text: `${JSON.stringify(sorted, null, 2)}\n`,
    before: input.store.exists(file) ? input.store.readText(file) : null,
  };
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
