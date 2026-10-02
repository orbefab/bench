import {
  type Dirent,
  existsSync,
  type FSWatcher,
  readdirSync,
  readFileSync,
  statSync,
  watch,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  type CatalogEntry,
  PART_FORMAT,
  type ProjectRow,
  partDocumentProject,
} from "@sfab-bench/contract";
import { db } from "./db";

const STEP_RE = /\.(step|stp)$/i;
const GLB_RE = /\.(glb|gltf)$/i;
const WORLD_RE = /\.world\.json$/i;
const MAX_FILES = 2500;

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "__pycache__",
  ".git",
  ".venv",
  ".cad-venv",
  ".cad-cache",
  "cad-cache",
  ".turbo",
  ".next",
  "coverage",
  "tmp",
]);

export type ProjectKind = "loopback" | "paired" | "account";

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    path TEXT PRIMARY KEY,
    last_file TEXT,
    opened_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS file_recents (
    project TEXT NOT NULL,
    path TEXT NOT NULL,
    opened_at INTEGER NOT NULL,
    PRIMARY KEY (project, path)
  );
`);

export const MAX_FILE_RECENTS = 12;

type WatchListener = () => void;

type LiveRoot = {
  revision: number;
  watcher: FSWatcher | null;
  watchTimer: ReturnType<typeof setTimeout> | null;
  listeners: Set<WatchListener>;
};

/** Watchers and catalog revisions, one per folder this process has used. */
const live = new Map<string, LiveRoot>();
/** Param-less requests use this. Boot + today's web (no `?project=`). */
let fallback: string | null = null;
const onFallbackChange = new Set<() => void>();

export function subscribeProjectChange(fn: () => void) {
  onFallbackChange.add(fn);
  return () => onFallbackChange.delete(fn);
}

function notifyFallbackChanged() {
  for (const fn of onFallbackChange) fn();
}

function liveOf(root: string): LiveRoot {
  let row = live.get(root);
  if (!row) {
    row = {
      revision: 0,
      watcher: null,
      watchTimer: null,
      listeners: new Set(),
    };
    live.set(root, row);
  }
  return row;
}

function bumpCatalog(root: string) {
  liveOf(root).revision += 1;
}

export function catalogRevision(root?: string | null): number {
  const target = root ?? fallback;
  if (!target) return 0;
  return liveOf(target).revision;
}

export function expandUserPath(input: string): string {
  const raw = input.trim();
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return join(homedir(), raw.slice(2));
  return raw;
}

export function posixRel(from: string, to: string) {
  return relative(from, to).split(sep).join("/");
}

export function insideRoot(root: string, abs: string) {
  const rel = relative(resolve(root), abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function skipDir(name: string) {
  return name.startsWith(".") || SKIP_DIRS.has(name);
}

export function shouldSkipDir(name: string) {
  return skipDir(name);
}

/** A root document: a part file under `parts/<pub>/` that carries `play`. */
function rootPartFile(dir: string, name: string): boolean {
  if (partDocumentProject(join(dir, name)) === null) return false;
  try {
    const json = JSON.parse(readFileSync(join(dir, name), "utf8")) as {
      format?: string;
      play?: unknown;
    };
    return (
      json.format === PART_FORMAT &&
      json.play !== null &&
      typeof json.play === "object"
    );
  } catch {
    return false;
  }
}

function walk(dir: string, root: string, acc: CatalogEntry[]) {
  if (acc.length >= MAX_FILES || !existsSync(dir)) return;
  let ents: Dirent[];
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of ents) {
    if (acc.length >= MAX_FILES) return;
    if (ent.isDirectory()) {
      if (skipDir(ent.name)) continue;
      walk(join(dir, ent.name), root, acc);
      continue;
    }
    if (!ent.isFile()) continue;
    if (STEP_RE.test(ent.name)) {
      acc.push({ path: posixRel(root, join(dir, ent.name)), kind: "step" });
    } else if (GLB_RE.test(ent.name) && !/\.raw\.(glb|gltf)$/i.test(ent.name)) {
      acc.push({ path: posixRel(root, join(dir, ent.name)), kind: "glb" });
    } else if (WORLD_RE.test(ent.name) || rootPartFile(dir, ent.name)) {
      acc.push({ path: posixRel(root, join(dir, ent.name)), kind: "world" });
    }
  }
}

export function listProjectFiles(root: string): CatalogEntry[] {
  const files: CatalogEntry[] = [];
  walk(resolve(root), resolve(root), files);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

function rowFrom(
  path: string,
  lastFile: string | null,
  openedAt: number
): ProjectRow {
  return { path, name: basename(path), lastFile, openedAt };
}

function readRow(abs: string): ProjectRow | null {
  const row = db
    .prepare("SELECT path, last_file, opened_at FROM projects WHERE path = ?")
    .get(abs) as
    | { path: string; last_file: string | null; opened_at: number }
    | undefined;
  if (!row) return null;
  return rowFrom(row.path, row.last_file, row.opened_at);
}

export function isRegistered(abs: string): boolean {
  return readRow(abs) != null;
}

export function listRecents(limit = 8): ProjectRow[] {
  const rows = db
    .prepare(
      "SELECT path, last_file, opened_at FROM projects ORDER BY opened_at DESC LIMIT ?"
    )
    .all(limit) as {
    path: string;
    last_file: string | null;
    opened_at: number;
  }[];
  return rows
    .filter((row) => existsSync(row.path))
    .map((row) => rowFrom(row.path, row.last_file, row.opened_at));
}

function startWatch(root: string) {
  const slot = liveOf(root);
  if (slot.watcher) return;
  try {
    slot.watcher = watch(root, { recursive: true }, (_event, filename) => {
      const raw = filename ? String(filename) : "";
      const name = raw ? (raw.split(sep)[0] ?? "") : "";
      if (name && skipDir(name)) return;
      if (slot.watchTimer) clearTimeout(slot.watchTimer);
      slot.watchTimer = setTimeout(() => {
        bumpCatalog(root);
        for (const fn of slot.listeners) {
          try {
            fn();
          } catch (err) {
            console.error("[watch]", err);
          }
        }
      }, 250);
      slot.watchTimer.unref();
    });
    slot.watcher.unref();
    slot.watcher.on("error", () => {
      /* directory may have vanished */
    });
  } catch {
    /* recursive watch is best-effort */
  }
}

function ensureLive(root: string) {
  liveOf(root);
  startWatch(root);
}

/** File changes under a project, debounced with the catalog revision bump. */
export function subscribeRootWatch(
  root: string,
  fn: WatchListener
): () => void {
  const abs = resolve(root);
  const slot = liveOf(abs);
  startWatch(abs);
  slot.listeners.add(fn);
  return () => {
    slot.listeners.delete(fn);
  };
}

/**
 * Test-only. Close every project watcher so the process can exit. On Linux,
 * Node 22 builds a recursive watch from one child watcher per subdirectory,
 * and `unref()` on the parent does not reach them.
 */
export function closeRootWatches(only?: (root: string) => boolean): void {
  for (const [root, slot] of live) {
    if (only && !only(root)) continue;
    if (slot.watchTimer) clearTimeout(slot.watchTimer);
    slot.watchTimer = null;
    slot.watcher?.close();
    slot.watcher = null;
  }
}

export function projectRow(root: string): ProjectRow {
  return readRow(root) ?? rowFrom(root, null, Date.now());
}

/** Process default for requests that omit `?project=`. */
export function fallbackRoot(): string | null {
  return fallback != null && existsSync(fallback) ? fallback : null;
}

export function currentProject(): ProjectRow | null {
  const root = fallbackRoot();
  if (!root) return null;
  return projectRow(root);
}

function assertDirectory(input: string): string {
  const abs = resolve(expandUserPath(input));
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw Object.assign(new Error(`not a directory: ${input}`), {
      status: 400,
    });
  }
  return abs;
}

/**
 * Record the folder in sqlite and start watching it.
 * Does not change the param-less fallback. Does not bump `opened_at` on a
 * folder that is already registered — a `?project=` poll must not reshuffle recents.
 */
export function registerProject(input: string): ProjectRow {
  const abs = assertDirectory(input);
  const prev = db
    .prepare("SELECT last_file, opened_at FROM projects WHERE path = ?")
    .get(abs) as { last_file: string | null; opened_at: number } | undefined;
  if (prev) {
    ensureLive(abs);
    return rowFrom(abs, prev.last_file, prev.opened_at);
  }
  const now = Date.now();
  db.prepare(
    "INSERT INTO projects (path, last_file, opened_at) VALUES (?, ?, ?)"
  ).run(abs, null, now);
  ensureLive(abs);
  bumpCatalog(abs);
  return rowFrom(abs, null, now);
}

/**
 * Register and set the param-less default. Today's web never sends `?project=`,
 * so this is how Open folder still switches those clients. A request that
 * already named `?project=` is unaffected. See ADR 0006.
 */
export function openProject(input: string): ProjectRow {
  const abs = assertDirectory(input);
  const now = Date.now();
  const prev = db
    .prepare("SELECT last_file FROM projects WHERE path = ?")
    .get(abs) as { last_file: string | null } | undefined;
  db.prepare(
    "INSERT INTO projects (path, last_file, opened_at) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET opened_at = excluded.opened_at"
  ).run(abs, prev?.last_file ?? null, now);
  ensureLive(abs);
  bumpCatalog(abs);
  const row = rowFrom(abs, prev?.last_file ?? null, now);
  const changed = fallback !== row.path;
  fallback = row.path;
  if (changed) notifyFallbackChanged();
  return row;
}

/**
 * Folder this request is about.
 * Loopback may name any directory (registered on first use).
 * Paired / account may only name a folder already in recents.
 * No query → the process fallback (boot default).
 */
export function resolveRequestRoot(
  requested: string | undefined,
  kind: ProjectKind
): string | null {
  const raw = requested?.trim();
  if (!raw) return fallbackRoot();
  const abs = assertDirectory(raw);
  if (kind === "loopback") {
    registerProject(abs);
    return abs;
  }
  if (!isRegistered(abs)) {
    throw Object.assign(new Error("folder is not on this Mac"), {
      status: 403,
    });
  }
  ensureLive(abs);
  return abs;
}

export function setLastFile(rel: string | null, root?: string | null) {
  const target = root ?? fallback;
  if (!target) return;
  db.prepare("UPDATE projects SET last_file = ? WHERE path = ?").run(
    rel,
    target
  );
}

export function listFileRecents(
  root?: string | null,
  limit = MAX_FILE_RECENTS
): string[] {
  const target = root ?? fallback;
  if (!target) return [];
  const rows = db
    .prepare(
      "SELECT path FROM file_recents WHERE project = ? ORDER BY opened_at DESC LIMIT ?"
    )
    .all(target, limit) as { path: string }[];
  return rows
    .map((row) => row.path)
    .filter((rel) => existsSync(join(target, rel)));
}

/** Record that someone opened a STEP/GLB. Does not change anyone's viewport. */
export function touchFileRecent(rel: string, root?: string | null) {
  const target = root ?? fallback;
  if (!target) return listFileRecents(target);
  const path = rel.trim().replace(/^\/+/, "");
  if (!path) return listFileRecents(target);
  const now = Date.now();
  db.prepare(
    "INSERT INTO file_recents (project, path, opened_at) VALUES (?, ?, ?) ON CONFLICT(project, path) DO UPDATE SET opened_at = excluded.opened_at"
  ).run(target, path, now);
  setLastFile(path, target);
  return listFileRecents(target);
}

export function listBrowse(input?: string) {
  const start = input?.trim() ? resolve(expandUserPath(input)) : homedir();
  if (!existsSync(start) || !statSync(start).isDirectory()) {
    throw Object.assign(new Error(`not a directory: ${input}`), {
      status: 400,
    });
  }
  const parent = dirname(start);
  const dirs: { name: string; path: string }[] = [];
  for (const ent of readdirSync(start, { withFileTypes: true })) {
    if (!ent.isDirectory() || skipDir(ent.name)) continue;
    dirs.push({ name: ent.name, path: join(start, ent.name) });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  return {
    path: start,
    parent: parent !== start ? parent : null,
    dirs,
  };
}

/** Open SFAB_BENCH_PROJECT, else the last recent that still exists, else nothing. */
export function bootProject() {
  const fromEnv = process.env.SFAB_BENCH_PROJECT?.trim();
  if (fromEnv) {
    openProject(fromEnv);
    return;
  }
  for (const row of listRecents(1)) {
    openProject(row.path);
    return;
  }
}
