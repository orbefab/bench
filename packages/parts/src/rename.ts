/**
 * Rename one project part file. The name changes; the publisher and
 * the version stay. Every project file that names the old id is part
 * of the same step. Nothing is written here: the session commits the
 * set, or refuses and leaves the disk alone.
 */

import type { EditOp, LockFile, PartFile } from "@sfab-bench/contract";
import { SNAPSHOT_FORMAT } from "@sfab-bench/contract";

import { partFilePath } from "./document";
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

export type PlannedRename = {
  files: PlannedFile[];
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
  const nextText = rewriteId(input.text, fromId, toId);
  let part: PartFile;
  try {
    part = JSON.parse(nextText) as PartFile;
  } catch {
    return { error: "world file is not JSON" };
  }
  if (part.id !== toId) return { error: "the part id did not change" };

  const files: PlannedFile[] = [
    { path: input.file, text: null, before: input.text },
    { path: nextFile, text: nextText, before: null },
  ];
  const parentSha = new Map<string, string>();
  parentSha.set(toId, contentHash(part));

  const parents = projectParts(input.store, input.projectDir).filter(
    (file) => normalize(file) !== normalize(input.file)
  );
  for (const file of parents) {
    let before: string;
    try {
      before = input.store.readText(file);
    } catch {
      continue;
    }
    if (!before.includes(fromId)) continue;
    if (!referencesInstance(before, fromId)) continue;
    const after = rewriteId(before, fromId, toId);
    let parsedParent: PartFile;
    try {
      parsedParent = JSON.parse(after) as PartFile;
    } catch {
      return { error: "a parent part is not JSON" };
    }
    files.push({ path: file, text: after, before });
    if (parsedParent.id)
      parentSha.set(parsedParent.id, contentHash(parsedParent));
  }

  const snapshots = projectSnapshots(input.store, input.projectDir);
  const snapshotSha = new Map<string, string>();
  for (const file of snapshots) {
    let before: string;
    try {
      before = input.store.readText(file);
    } catch {
      continue;
    }
    if (!mentionsPart(parseJson(before), fromId)) continue;
    const after = rewriteId(before, fromId, toId);
    files.push({ path: file, text: after, before });
    const parsedSnap = parseJson(after);
    if (parsedSnap)
      snapshotSha.set(
        projectRel(input.projectDir, file),
        contentHash(parsedSnap)
      );
  }

  const overlays = projectOverlays(input.store, input.projectDir, parsed, to);
  for (const row of overlays) {
    files.push(row.file);
    if (row.shaKey && row.parsed) {
      snapshotSha.set(row.shaKey, contentHash(row.parsed));
    }
  }

  const locks = lockRewrites(
    input,
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
  const roots = lockedLockPaths(
    input.store,
    input.projectDir,
    fromId,
    input.file
  );
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
  store: Store,
  projectDir: string,
  partId: string,
  skipFile: string
): string[] {
  const parts = projectParts(store, projectDir);
  const out: string[] = [];
  for (const file of parts) {
    if (normalize(file) === normalize(skipFile)) continue;
    const lock = lockPathFor(file);
    if (!store.exists(lock)) continue;
    let text: string;
    try {
      text = store.readText(file);
    } catch {
      continue;
    }
    if (usesPart(store, parts, text, partId, new Set())) {
      out.push(lock);
    }
  }
  out.sort();
  return out;
}

function usesPart(
  store: Store,
  parts: readonly string[],
  text: string,
  partId: string,
  seen: Set<string>
): boolean {
  const parsed = parseJson(text) as { id?: string } | null;
  const id = parsed && typeof parsed.id === "string" ? parsed.id : "";
  if (!id || seen.has(id)) return false;
  seen.add(id);
  if (text.includes(`"${partId}"`) && referencesInstance(text, partId))
    return true;
  if (!parsed) return false;
  const refs = instancePartIds(parsed);
  for (const ref of refs) {
    if (ref === partId) return true;
    const child = parts.find((file) => {
      try {
        const body = store.readText(file);
        return (
          body.includes(`"id": "${ref}"`) || body.includes(`"id":"${ref}"`)
        );
      } catch {
        return false;
      }
    });
    if (!child) continue;
    let body: string;
    try {
      body = store.readText(child);
    } catch {
      continue;
    }
    if (usesPart(store, parts, body, partId, seen)) return true;
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

function referencesInstance(text: string, partId: string): boolean {
  const parsed = parseJson(text);
  return instancePartIds(parsed).includes(partId);
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

function rewriteId(text: string, fromId: string, toId: string): string {
  return text.split(fromId).join(toId);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
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

function projectParts(store: Store, projectDir: string): string[] {
  return walkJson(store, join(projectDir, "parts")).filter(
    (file) =>
      file.endsWith(".json") &&
      !file.endsWith(".lock.json") &&
      !file.includes(".edit-")
  );
}

function projectSnapshots(store: Store, projectDir: string): string[] {
  return walkJson(store, join(projectDir, "snapshots")).filter((file) => {
    if (!file.endsWith(".json") || file.includes(".edit-")) return false;
    const parsed = parseJson(safeRead(store, file));
    if (!parsed || typeof parsed !== "object") return false;
    return (parsed as { format?: unknown }).format === SNAPSHOT_FORMAT;
  });
}

function projectOverlays(
  store: Store,
  projectDir: string,
  parsed: { publisher: string; name: string; version: string },
  toName: string
): { file: PlannedFile; shaKey?: string; parsed?: unknown }[] {
  const dir = join(projectDir, "overlays");
  const stem = `${parsed.name}@${parsed.version}`;
  const nextStem = `${toName}@${parsed.version}`;
  const out: { file: PlannedFile; shaKey?: string; parsed?: unknown }[] = [];
  for (const file of walkJson(store, dir)) {
    if (file.includes(".edit-")) continue;
    let before: string;
    try {
      before = store.readText(file);
    } catch {
      continue;
    }
    const base = basename(file);
    const renamed = base.includes(stem);
    const mentions = before.includes(`${parsed.publisher}/${stem}`);
    if (!renamed && !mentions) continue;
    const after = mentions
      ? rewriteId(
          before,
          `${parsed.publisher}/${stem}`,
          `${parsed.publisher}/${nextStem}`
        )
      : before;
    const nextPath = renamed ? file.split(stem).join(nextStem) : file;
    if (nextPath === file) {
      if (after !== before) {
        out.push({
          file: { path: file, text: after, before },
          shaKey: projectRel(projectDir, file),
          parsed: parseJson(after),
        });
      }
      continue;
    }
    out.push({
      file: { path: file, text: null, before },
    });
    out.push({
      file: { path: nextPath, text: after, before: null },
      shaKey: projectRel(projectDir, nextPath),
      parsed: parseJson(after),
    });
  }
  return out;
}

function safeRead(store: Store, file: string): string {
  try {
    return store.readText(file);
  } catch {
    return "";
  }
}

function walkJson(store: Store, dir: string): string[] {
  const out: string[] = [];
  const visit = (folder: string) => {
    let names: string[];
    try {
      names = store.list(folder);
    } catch {
      return;
    }
    for (const name of names) {
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
