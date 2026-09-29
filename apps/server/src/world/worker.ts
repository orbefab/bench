/**
 * Node host for one world. Messaging, the play timer, and file reads.
 * The run itself is `Sim`.
 */
import { performance } from "node:perf_hooks";
import { parentPort } from "node:worker_threads";

import { sha256Bytes } from "@sfab-bench/parts";
import { Sim, type ToWorker } from "@sfab-bench/sim/sim";

import { projectReal, readerFor, readInside } from "./files";
import { packageVersion } from "./package-version";
import { nodePlanEnv } from "./plan-host";

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
  sha256: sha256Bytes,
  versions: {
    mujoco: packageVersion("@mujoco/mujoco", import.meta.url),
    avr8js: packageVersion("avr8js", import.meta.url),
  },
  projectReal,
  readInside,
  readerFor,
  plan: nodePlanEnv,
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
