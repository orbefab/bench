/** Node `Store` for `@sfab-bench/parts`. Creates parent directories on write. */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type { Store } from "@sfab-bench/parts";

/** A relative path is absolute from this process before parts sees it. */
export function absolutePath(file: string): string {
  return path.isAbsolute(file) ? file : path.resolve(file);
}

/** Directories this process created for a write, so a prune drops only those. */
const madeDirs = new Set<string>();

/** Create `abs`'s parent directories, remembering each one that was missing. */
function makeParent(abs: string): void {
  const missing: string[] = [];
  for (
    let dir = path.dirname(abs);
    !existsSync(dir) && dir !== path.dirname(dir);
    dir = path.dirname(dir)
  ) {
    missing.push(dir);
  }
  if (missing.length === 0) return;
  mkdirSync(path.dirname(abs), { recursive: true });
  for (const dir of missing) madeDirs.add(dir);
}

/**
 * Undoing the first capture leaves `snapshots/<publisher>/` and
 * `overlays/<publisher>/` empty. Walk up from the removed file and drop each
 * empty directory this process made, ending with `snapshots/` or
 * `overlays/` itself. One the user made stays, even when empty.
 */
function pruneEmptyCaptureDirs(removed: string): void {
  const parts = removed.split(path.sep);
  const at = Math.max(
    parts.lastIndexOf("snapshots"),
    parts.lastIndexOf("overlays")
  );
  if (at < 0) return;
  for (let depth = parts.length - 1; depth > at; depth -= 1) {
    const dir = parts.slice(0, depth).join(path.sep);
    if (!madeDirs.has(dir)) return;
    try {
      if (readdirSync(dir).length > 0) return;
      rmdirSync(dir);
      madeDirs.delete(dir);
    } catch {
      return;
    }
  }
}

export const nodeStore: Store = {
  readText(file) {
    return readFileSync(absolutePath(file), "utf8");
  },
  exists(file) {
    return existsSync(absolutePath(file));
  },
  writeText(file, text) {
    const abs = absolutePath(file);
    makeParent(abs);
    // A crash mid-write leaves the previous file. The temp is not a
    // part document, and it is removed if the rename does not land.
    const tmp = `${abs}.edit-tmp`;
    try {
      writeFileSync(tmp, text);
      renameSync(tmp, abs);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
  },
  rename(from, to) {
    const abs = absolutePath(to);
    makeParent(abs);
    renameSync(absolutePath(from), abs);
  },
  remove(file) {
    const abs = absolutePath(file);
    rmSync(abs, { force: true });
    pruneEmptyCaptureDirs(abs);
  },
  list(file) {
    return readdirSync(absolutePath(file));
  },
};
