import { ok as expect } from "node:assert/strict";
import {
  closeFolderNeedsConfirm,
  closeFolderTitle,
  orbitDampingEnabled,
  viewerFrameloop,
} from "./motion";

expect(orbitDampingEnabled(false), "damping on");
expect(orbitDampingEnabled(true) === false, "reduce disables damping");

expect(viewerFrameloop(false) === "demand", "desktop on demand");
expect(viewerFrameloop(true) === "always", "XR always");

expect(
  closeFolderNeedsConfirm({ hasModel: false, replyInProgress: false }) ===
    false,
  "empty tab closes"
);
expect(
  closeFolderNeedsConfirm({ hasModel: true, replyInProgress: false }),
  "loaded model confirms"
);
expect(
  closeFolderNeedsConfirm({ hasModel: false, replyInProgress: true }),
  "live reply confirms"
);
expect(
  closeFolderNeedsConfirm({ hasModel: true, replyInProgress: true }),
  "both confirm"
);

expect(closeFolderTitle("bracket") === "Close bracket?", "named folder");
expect(closeFolderTitle("  ") === "Close folder?", "blank falls back");

console.log("motion.selfcheck ok");
