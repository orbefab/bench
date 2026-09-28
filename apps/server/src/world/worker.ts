/**
 * Node host for one world. Messaging, the play timer, and file reads.
 * The run itself is `Sim`.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { parentPort } from "node:worker_threads";

import { sha256Bytes } from "@sfab-bench/parts";
import { Sim, type ToWorker } from "@sfab-bench/sim/sim";

import { projectReal, readerFor, readInside } from "./files";
import { installPlanHost } from "./plan-host";

installPlanHost();

const require = createRequire(import.meta.url);

function packageVersion(name: string): string {
  try {
    let dir = dirname(require.resolve(name));
    for (let hop = 0; hop < 6; hop++) {
      const pkgPath = join(dir, "package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === name) return pkg.version ?? "unknown";
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* the manifest says unknown rather than failing the run */
  }
  return "unknown";
}

const port = parentPort;
const sim = new Sim({
  post(message) {
    port?.postMessage(message);
  },
  now: () => performance.now(),
  schedule: (fn, ms) => setTimeout(fn, ms),
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  ledTrace: process.env.SFAB_LED_TRACE === "1",
  sha256: sha256Bytes,
  versions: {
    mujoco: packageVersion("@mujoco/mujoco"),
    avr8js: packageVersion("avr8js"),
  },
  projectReal,
  readInside,
  readerFor,
});

if (port) {
  port.on("message", (message: ToWorker) => {
    sim.accept(message);
  });
}

export type {
  AdcNodeStamp,
  AdcSampleStamp,
  AdcTrace,
  FromWorker,
  RecordBody,
  RecordQuery,
  ToWorker,
} from "@sfab-bench/sim/sim";
