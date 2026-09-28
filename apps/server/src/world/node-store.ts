/** Node `Store` for `@sfab-bench/parts`. Creates parent directories on write. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Store } from "@sfab-bench/parts";

export const nodeStore: Store = {
  readText(path) {
    return readFileSync(path, "utf8");
  },
  exists(path) {
    return existsSync(path);
  },
  writeText(path, text) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  },
};
