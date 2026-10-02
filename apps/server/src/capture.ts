/** Host binding. The capture runner lives in `@sfab-bench/sim`. */
import {
  type CaptureCase,
  type CaptureEntry,
  type CaptureFile,
  type CaptureFreeRun,
  type CaptureRun,
  type CaptureStats,
  type FreeCase,
  type FreeRunSpec,
  captureCatalog as simCaptureCatalog,
  captureFromConfig as simCaptureFromConfig,
  runClassScenes as simRunClassScenes,
} from "@sfab-bench/sim/capture";

import { nodeCaptureEnv } from "./capture-host";
import { nodeStampEnv } from "./world/plan-host";

export type {
  CaptureCase,
  CaptureEntry,
  CaptureFile,
  CaptureFreeRun,
  CaptureRun,
  CaptureStats,
  FreeCase,
  FreeRunSpec,
};

export function captureCatalog(fixtureFile?: string): Promise<CaptureStats> {
  return simCaptureCatalog(nodeCaptureEnv, nodeStampEnv, fixtureFile);
}

export function captureFromConfig(
  opts: CaptureRun = {}
): Promise<CaptureStats> {
  return simCaptureFromConfig(opts, nodeCaptureEnv, nodeStampEnv);
}

export function runClassScenes(
  scene: FreeRunSpec,
  specs: Parameters<typeof simRunClassScenes>[1]
): ReturnType<typeof simRunClassScenes> {
  return simRunClassScenes(scene, specs, nodeCaptureEnv);
}
