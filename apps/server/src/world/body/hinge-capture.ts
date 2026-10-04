/** Host binding. Hinge capture lives in `@sfab-bench/sim`. */
import { captureSource } from "@sfab-bench/sim/capture-source";
import {
  type HingeCaptureEntry,
  type HingeCaptureInput,
  writeHingeSnapshot as simWriteHingeSnapshot,
} from "@sfab-bench/sim/hinge-capture";

import { nodeCaptureEnv } from "../../capture-host";

export type { HingeCaptureEntry, HingeCaptureInput };

/** The source is the catalog, or `projectDir` over it. */
export function writeHingeSnapshot(
  input: Omit<HingeCaptureInput, "source"> & { projectDir?: string }
): Promise<void> {
  const { projectDir, ...rest } = input;
  return simWriteHingeSnapshot(
    {
      ...rest,
      source: captureSource(input.catalog, projectDir, nodeCaptureEnv),
    },
    nodeCaptureEnv
  );
}
