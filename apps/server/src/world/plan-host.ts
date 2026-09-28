/** Node file host for `@sfab-bench/sim`. The catalog stays beside this package. */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { configurePlanEnv, configureStampEnv } from "@sfab-bench/sim";

import { absolutePath, nodeStore } from "./node-store";

export function catalogRoot(): string {
  return fileURLToPath(new URL("../../catalog", import.meta.url));
}

let installed = false;

export function installPlanHost(): void {
  if (installed) return;
  installed = true;
  const catalogDir = () => catalogRoot();
  configurePlanEnv({
    store: nodeStore,
    catalogDir,
    exists: existsSync,
    readText: (file) => readFileSync(file, "utf8"),
    realpath: (file) => realpathSync(file),
    resolve: (...parts) => path.resolve(...parts),
    relative: (from, to) => path.relative(from, to),
    dirname: (file) => path.dirname(file),
    isAbsolute: (file) => path.isAbsolute(file),
    absolutePath,
    sep: path.sep,
  });
  configureStampEnv({
    store: nodeStore,
    absolutePath,
    defaultCatalog: catalogDir,
    join: (...parts) => path.join(...parts),
  });
}
