/**
 * Rename one project part file. The name changes; the publisher and
 * the version stay. Every project file that names the old id is part
 * of the same step. Nothing is written here: the session commits the
 * set, or refuses and leaves the disk alone.
 */

import type { EditOp, LockFile, PartFile } from "@sfab-bench/contract";
import { SNAPSHOT_FORMAT } from "@sfab-bench/contract";

import { partFilePath } from "./document";
import { formatPart, partStyle } from "./format-part";
import { lockPathFor } from "./lock";
import { basename, join, normalize, relative } from "./path";
import { findPartFile } from "./ports";
import { contentHash, parsePartRef } from "./si";
import type { Store } from "./store";

export type PlannedFile = {
  path: string;
  text: string | null;
  before: string | null;
};

/** A project file the rename could not read or parse, so it did not look at it. */
export type SkippedFile = {
  /** Project-relative. */
  file: string;
  error: string;
};

export type PlannedRename = {
  files: PlannedFile[];
  skipped: SkippedFile[];
  /** Part text at the new path. */
  text: string;
  part: PartFile;
  nextFile: string;
  /** Project-relative paths. */
  fromRel: string;
  toRel: string;
  fromId: string;
  toId: string;
  inverse: EditOp;
};

const NAME = /^[a-z0-9-]+$/;

export function planPartRename(input: {
  store: Store;
  projectDir: string;
  catalogDir: string;
  libraryDir?: string;
  file: string;
  text: string;
  part: PartFile;
  to: string;
  document: string;
}): PlannedRename | { error: string } {
  const parsed = parsePartRef(input.part.id);
  if (!parsed) return { error: "this part has no name" };
  const to = input.to.trim();
  if (!NAME.test(to)) return { error: "the name is not a part name" };
  if (to === parsed.name) return { error: "the name is unchanged" };
  const toId = `${parsed.publisher}/${to}@${parsed.version}`;
  if (!parsePartRef(toId)) return { error: "the name is not a part name" };
  const taken = findPartFile(
    input.store,
    input.projectDir,
    {
      catalogDir: input.catalogDir,
      ...(input.libraryDir ? { libraryDir: input.libraryDir } : {}),
    },
    toId
  );
  if (taken) return { error: `${toId} already exists` };
  const nextFile = partFilePath(input.projectDir, toId);
  if (!nextFile) return { error: "the name is not a part name" };
  if (input.store.exists(nextFile)) return { error: `${toId} already exists` };

  const fromId = input.part.id;
  let source: unknown;
  try {
    source = JSON.parse(input.text) as unknown;
  } catch {
    return { error: "world file is not JSON" };
  }
  const own = swapDoc({ text: input.text, value: source }, fromId, toId);
  const part = own.value as PartFile;
  const nextText = own.text;
  if (part.id !== toId) return { error: "the part id did not change" };

  const files: PlannedFile[] = [
    { path: input.file, text: null, before: input.text },
    { path: nextFile, text: nextText, before: null },
  ];
  const parentSha = new Map<string, string>();
  parentSha.set(toId, contentHash(part));

  const docs = new Docs(input.store, input.projectDir);
  const projectFiles = projectParts(docs);
  const parents = projectFiles.filter(
    (file) => normalize(file) !== normalize(input.file)
  );
  for (const file of parents) {
    const doc = docs.load(file);
    if (!doc) continue;
    if (!instancePartIds(doc.value).includes(fromId)) continue;
    const next = swapDoc(doc, fromId, toId);
    files.push({ path: file, text: next.text, before: doc.text });
    const nextPart = next.value as PartFile;
    if (nextPart.id) parentSha.set(nextPart.id, contentHash(nextPart));
  }

  const snapshotSha = new Map<string, string>();
  for (const file of projectSnapshots(docs)) {
    const doc = docs.load(file);
    if (!doc || !mentionsPart(doc.value, fromId)) continue;
    const next = swapDoc(doc, fromId, toId);
    files.push({ path: file, text: next.text, before: doc.text });
    snapshotSha.set(
      projectRel(input.projectDir, file),
      contentHash(next.value)
    );
  }

  const overlays = projectOverlays(docs, parsed, to);
  for (const row of overlays) {
    files.push(row.file);
    if (row.shaKey && row.parsed) {
      snapshotSha.set(row.shaKey, contentHash(row.parsed));
    }
  }

  const locks = lockRewrites(
    input,
    docs,
    projectFiles,
    fromId,
    toId,
    nextFile,
    parentSha,
    snapshotSha
  );
  if ("error" in locks) return locks;
  files.push(...locks.files);

  const inverse: EditOp = {
    kind: "rename-part",
    document: input.document,
    to: parsed.name,
  };
  return {
    files,
    skipped: docs.skipped(),
    text: nextText,
    part,
    nextFile,
    fromRel: projectRel(input.projectDir, input.file),
    toRel: projectRel(input.projectDir, nextFile),
    fromId,
    toId,
    inverse,
  };
}

function lockRewrites(
  input: {
    store: Store;
    projectDir: string;
    file: string;
  },
  docs: Docs,
  projectFiles: readonly string[],
  fromId: string,
  toId: string,
  nextFile: string,
  parentSha: Map<string, string>,
  snapshotSha: Map<string, string>
): { files: PlannedFile[] } | { error: string } {
  const files: PlannedFile[] = [];
  const newPath = projectRel(input.projectDir, nextFile);
  const newSha = parentSha.get(toId);
  if (!newSha) return { error: "the renamed part has no hash" };
  const seen = new Set<string>();
  const consider = (lockPath: string, moving: boolean) => {
    const key = normalize(lockPath);
    if (seen.has(key)) return;
    if (!input.store.exists(lockPath)) return;
    seen.add(key);
    let before: string;
    try {
      before = input.store.readText(lockPath);
    } catch (err: unknown) {
      return {
        error: err instanceof Error ? err.message : "lock file did not load",
      } as const;
    }
    let lock: LockFile;
    try {
      lock = JSON.parse(before) as LockFile;
    } catch {
      return { error: "lock file is not JSON" } as const;
    }
    let changed = false;
    for (const row of lock.parts) {
      if (row.id === fromId) {
        row.id = toId;
        row.path = newPath;
        row.sha256 = newSha;
        changed = true;
        continue;
      }
      const sha = parentSha.get(row.id);
      if (sha && sha !== row.sha256) {
        row.sha256 = sha;
        changed = true;
      }
    }
    if (lock.snapshots) {
      for (const row of lock.snapshots) {
        const sha = snapshotSha.get(row.path);
        if (sha && sha !== row.sha256) {
          row.sha256 = sha;
          changed = true;
        }
      }
    }
    if (lock.overlays) {
      const from = fromId.slice(fromId.indexOf("/") + 1);
      const to = toId.slice(toId.indexOf("/") + 1);
      for (const row of lock.overlays) {
        const path =
          row.id === fromId ? row.path.split(from).join(to) : row.path;
        const sha = snapshotSha.get(path);
        if (path !== row.path) {
          row.path = path;
          changed = true;
        }
        if (row.id === fromId) {
          row.id = toId;
          changed = true;
        }
        if (sha && sha !== row.sha256) {
          row.sha256 = sha;
          changed = true;
        }
      }
    }
    if (moving) {
      const stem = basename(nextFile).replace(/\.json$/, "");
      if (lock.world !== stem) {
        lock.world = stem;
        changed = true;
      }
    }
    if (sortById(lock.parts)) changed = true;
    if (lock.types && sortById(lock.types)) changed = true;
    if (lock.snapshots && sortById(lock.snapshots)) changed = true;
    if (lock.overlays && sortById(lock.overlays)) changed = true;
    if (!changed) return;
    const after = formatLock(lock, before);
    if (moving) {
      files.push({ path: lockPath, text: null, before });
      files.push({ path: lockPathFor(nextFile), text: after, before: null });
    } else {
      files.push({ path: lockPath, text: after, before });
    }
  };

  const own = consider(lockPathFor(input.file), true);
  if (own && "error" in own) return own;
  const roots = lockedLockPaths(docs, projectFiles, fromId, input.file);
  for (const lockPath of roots) {
    const decided = consider(lockPath, false);
    if (decided && "error" in decided) return decided;
  }
  return { files };
}

/**
 * Locks of project parts that instance `partId`, other than the part
 * being renamed. The walk is the lock files, not a second resolver:
 * a root lock is the pin, and a nested part has none.
 */
function lockedLockPaths(
  docs: Docs,
  parts: readonly string[],
  partId: string,
  skipFile: string
): string[] {
  const out: string[] = [];
  for (const file of parts) {
    if (normalize(file) === normalize(skipFile)) continue;
    const lock = lockPathFor(file);
    if (!docs.exists(lock)) continue;
    const doc = docs.load(file);
    if (!doc) continue;
    if (usesPart(docs, parts, doc.value, partId, new Set())) {
      out.push(lock);
    }
  }
  out.sort();
  return out;
}

function usesPart(
  docs: Docs,
  parts: readonly string[],
  value: unknown,
  partId: string,
  seen: Set<string>
): boolean {
  const id = (value as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || !id || seen.has(id)) return false;
  seen.add(id);
  const refs = instancePartIds(value);
  if (refs.includes(partId)) return true;
  for (const ref of refs) {
    const child = parts.find((file) => {
      const doc = docs.load(file);
      return (doc?.value as { id?: unknown } | undefined)?.id === ref;
    });
    if (!child) continue;
    const doc = docs.load(child);
    if (doc && usesPart(docs, parts, doc.value, partId, seen)) return true;
  }
  return false;
}

function instancePartIds(value: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const row = node as Record<string, unknown>;
    const instances = row.instances;
    if (
      instances &&
      typeof instances === "object" &&
      !Array.isArray(instances)
    ) {
      for (const inst of Object.values(instances as Record<string, unknown>)) {
        if (!inst || typeof inst !== "object") continue;
        const part = (inst as { part?: unknown }).part;
        if (typeof part === "string") out.push(part);
      }
    }
    for (const child of Object.values(row)) walk(child);
  };
  walk(value);
  return out;
}

function mentionsPart(value: unknown, partId: string): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value))
    return value.some((item) => mentionsPart(item, partId));
  const row = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(row)) {
    if (key === "part" && child === partId) return true;
    if (mentionsPart(child, partId)) return true;
  }
  return false;
}

/** Every string value that is exactly `fromId` becomes `toId`. Keys and longer strings stay. */
function swapIds(
  value: unknown,
  fromId: string,
  toId: string
): { value: unknown; hit: boolean } {
  if (typeof value === "string") {
    return value === fromId
      ? { value: toId, hit: true }
      : { value, hit: false };
  }
  if (Array.isArray(value)) {
    let hit = false;
    const items = value.map((item) => {
      const next = swapIds(item, fromId, toId);
      hit ||= next.hit;
      return next.value;
    });
    return { value: items, hit };
  }
  if (value && typeof value === "object") {
    let hit = false;
    const row: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const next = swapIds(child, fromId, toId);
      hit ||= next.hit;
      row[key] = next.value;
    }
    return { value: row, hit };
  }
  return { value, hit: false };
}

type Doc = { text: string; value: unknown };

/**
 * The document with its id strings swapped, in the style it was written.
 * A file `formatPart` would not print back unchanged keeps its own layout:
 * the quoted ids are replaced in the text, and the result is kept only if
 * it parses to the swapped value.
 */
function swapDoc(
  doc: Doc,
  fromId: string,
  toId: string
): { text: string; value: unknown; hit: boolean } {
  const swapped = swapIds(doc.value, fromId, toId);
  if (!swapped.hit) return { text: doc.text, value: doc.value, hit: false };
  const style = partStyle(doc.text);
  if (formatPart(doc.value, style) !== doc.text) {
    const spliced = doc.text
      .split(JSON.stringify(fromId))
      .join(JSON.stringify(toId));
    if (JSON.stringify(JSON.parse(spliced)) === JSON.stringify(swapped.value)) {
      return { text: spliced, value: swapped.value, hit: true };
    }
  }
  return {
    text: formatPart(swapped.value, style),
    value: swapped.value,
    hit: true,
  };
}

/** Reads project JSON once. A file it cannot read or parse is recorded, not dropped. */
class Docs {
  private readonly cache = new Map<string, Doc | null>();
  private readonly failed = new Map<string, string>();

  constructor(
    private readonly store: Store,
    readonly projectDir: string
  ) {}

  exists(file: string): boolean {
    return this.store.exists(file);
  }

  list(dir: string): string[] {
    if (!this.store.exists(dir)) return [];
    try {
      return this.store.list(dir);
    } catch (err: unknown) {
      this.fail(dir, err);
      return [];
    }
  }

  load(file: string): Doc | null {
    const key = normalize(file);
    if (this.cache.has(key)) return this.cache.get(key) ?? null;
    let doc: Doc | null = null;
    try {
      const text = this.store.readText(file);
      doc = { text, value: JSON.parse(text) as unknown };
    } catch (err: unknown) {
      this.fail(file, err);
    }
    this.cache.set(key, doc);
    return doc;
  }

  skipped(): SkippedFile[] {
    return [...this.failed]
      .map(([file, error]) => ({ file, error }))
      .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  }

  private fail(file: string, err: unknown): void {
    const error =
      err instanceof SyntaxError
        ? "not valid JSON"
        : err instanceof Error
          ? err.message
          : "could not be read";
    this.failed.set(projectRel(this.projectDir, file), error);
  }
}

function sortById<T extends { id: string }>(rows: T[]): boolean {
  const before = rows.map((row) => row.id).join("\0");
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return rows.map((row) => row.id).join("\0") !== before;
}

function formatLock(lock: LockFile, previous: string): string {
  if (previous && !previous.startsWith("{\n"))
    return `${JSON.stringify(lock)}\n`;
  return `${JSON.stringify(lock, null, 2)}\n`;
}

function projectRel(projectDir: string, file: string): string {
  return relative(normalize(projectDir), normalize(file)).split("\\").join("/");
}

function projectParts(docs: Docs): string[] {
  return walkJson(docs, join(docs.projectDir, "parts")).filter(
    (file) =>
      file.endsWith(".json") &&
      !file.endsWith(".lock.json") &&
      !file.includes(".edit-")
  );
}

function projectSnapshots(docs: Docs): string[] {
  return walkJson(docs, join(docs.projectDir, "snapshots")).filter((file) => {
    if (!file.endsWith(".json") || file.includes(".edit-")) return false;
    const value = docs.load(file)?.value;
    if (!value || typeof value !== "object") return false;
    return (value as { format?: unknown }).format === SNAPSHOT_FORMAT;
  });
}

function projectOverlays(
  docs: Docs,
  parsed: { publisher: string; name: string; version: string },
  toName: string
): { file: PlannedFile; shaKey?: string; parsed?: unknown }[] {
  const dir = join(docs.projectDir, "overlays");
  const stem = `${parsed.name}@${parsed.version}`;
  const nextStem = `${toName}@${parsed.version}`;
  const fromId = `${parsed.publisher}/${stem}`;
  const toId = `${parsed.publisher}/${nextStem}`;
  const out: { file: PlannedFile; shaKey?: string; parsed?: unknown }[] = [];
  for (const file of walkJson(docs, dir)) {
    if (file.includes(".edit-")) continue;
    const doc = docs.load(file);
    if (!doc) continue;
    const renamed = basename(file).includes(stem);
    const swapped = swapDoc(doc, fromId, toId);
    if (!renamed && !swapped.hit) continue;
    const { text: after, value } = swapped;
    const nextPath = renamed ? file.split(stem).join(nextStem) : file;
    if (nextPath === file) {
      out.push({
        file: { path: file, text: after, before: doc.text },
        shaKey: projectRel(docs.projectDir, file),
        parsed: value,
      });
      continue;
    }
    out.push({
      file: { path: file, text: null, before: doc.text },
    });
    out.push({
      file: { path: nextPath, text: after, before: null },
      shaKey: projectRel(docs.projectDir, nextPath),
      parsed: value,
    });
  }
  return out;
}

function walkJson(docs: Docs, dir: string): string[] {
  const out: string[] = [];
  const visit = (folder: string) => {
    for (const name of docs.list(folder)) {
      if (name.startsWith(".")) continue;
      const child = join(folder, name);
      if (name.endsWith(".json") || name.endsWith(".lock.json")) {
        out.push(child);
        continue;
      }
      if (!name.includes(".")) visit(child);
    }
  };
  visit(dir);
  out.sort();
  return out;
}
