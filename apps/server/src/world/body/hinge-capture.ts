/** Host binding. Hinge capture lives in `@sfab-bench/sim`. */
import { installCaptureHost } from "../../capture-host";

installCaptureHost();

export {
  type HingeCaptureEntry,
  type HingeCaptureInput,
  writeHingeSnapshot,
} from "@sfab-bench/sim/hinge-capture";
