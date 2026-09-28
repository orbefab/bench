/** Node `Store` for `@sfab-bench/parts`. Creates parent directories on write. */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type { Store } from "@sfab-bench/parts";

/** A relative path is absolute from this process before parts sees it. */
export function absolutePath(file: string): string {
  return path.isAbsolute(file) ? file : path.resolve(file);
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
    mkdirSync(path.dirname(abs), { recursive: true });
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
    mkdirSync(path.dirname(abs), { recursive: true });
    renameSync(absolutePath(from), abs);
  },
  remove(file) {
    rmSync(absolutePath(file), { force: true });
  },
  list(file) {
    return readdirSync(absolutePath(file));
  },
};
