/** Host binding. The capture runner lives in `@sfab-bench/sim`. */
import { installCaptureHost } from "./capture-host";

installCaptureHost();

export {
  type CaptureCase,
  type CaptureEntry,
  type CaptureFile,
  type CaptureFreeRun,
  type CaptureRun,
  type CaptureStats,
  captureCatalog,
  captureFromConfig,
  type FreeCase,
  type FreeRunSpec,
  runClassScenes,
} from "@sfab-bench/sim/capture";
