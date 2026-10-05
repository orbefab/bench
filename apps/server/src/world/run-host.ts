/**
 * The Node host for a frozen comparison run (`@sfab-bench/sim/run-context`):
 * the files a context freezes, and the clock a side runs on.
 */
import { performance } from "node:perf_hooks";

import { sha256Bytes } from "@sfab-bench/parts";
import type { RunClock, RunFiles } from "@sfab-bench/sim/run-context";

import { projectReal, readerFor, readInside } from "./files";
import { packageVersion } from "./package-version";
import { nodePlanEnv } from "./plan-host";

export const nodeRunFiles: RunFiles = {
  projectReal,
  readInside,
  readerFor,
  plan: nodePlanEnv,
};

export const nodeRunClock: RunClock = {
  post() {},
  now: () => performance.now(),
  schedule: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clear(handle: unknown) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  sha256: sha256Bytes,
  versions: {
    mujoco: packageVersion("@mujoco/mujoco", import.meta.url),
    avr8js: packageVersion("avr8js", import.meta.url),
  },
  keepSerial: false,
};
