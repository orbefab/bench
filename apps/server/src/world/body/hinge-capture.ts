/** Host binding. Hinge capture lives in `@sfab-bench/sim`. */
import {
  type HingeCaptureEntry,
  type HingeCaptureInput,
  writeHingeSnapshot as simWriteHingeSnapshot,
} from "@sfab-bench/sim/hinge-capture";

import { nodeCaptureEnv } from "../../capture-host";

export type { HingeCaptureEntry, HingeCaptureInput };

export function writeHingeSnapshot(input: HingeCaptureInput): Promise<void> {
  return simWriteHingeSnapshot(input, nodeCaptureEnv);
}
