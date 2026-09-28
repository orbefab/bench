/** Node `Store` for `@sfab-bench/parts`. Creates parent directories on write. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    writeFileSync(abs, text);
  },
};
