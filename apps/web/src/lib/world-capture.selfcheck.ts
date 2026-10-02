import { deepStrictEqual, ok as expect } from "node:assert/strict";

import {
  beginCapture,
  CAPTURE_ABORTED,
  type CaptureState,
  captureDisabledReason,
  capturedLabel,
  captureEditTarget,
  captureFailure,
  captureProgress,
  IDLE_CAPTURE,
  levelDeletable,
  levelSourceWords,
  settleCapture,
  takeCaptureMessage,
} from "./world-capture";
import { removeCaptureOp } from "./world-ops";

const request = { nonce: "n1", path: "nano.power", axis: "behaviour" } as const;

const started = beginCapture(IDLE_CAPTURE, request);
expect(started.phase === "running", "Capture starts a run");
expect(
  beginCapture(started, { ...request, nonce: "n2" }) === started,
  "a second Capture while one runs changes nothing"
);

// progress, then captured
let state: CaptureState = takeCaptureMessage(started, {
  type: "capture-progress",
  nonce: "n1",
  done: 3,
  total: 12,
  label: "sweep 3 of 12",
});
deepStrictEqual(captureProgress(state), {
  label: "sweep 3 of 12",
  done: 3,
  total: 12,
  fraction: 0.25,
});
expect(
  captureProgress(started)?.fraction === 0 &&
    captureProgress(started)?.label === "Capturing",
  "before the first step there is a label and an empty bar"
);
state = takeCaptureMessage(state, {
  type: "captured",
  nonce: "n1",
  path: "nano.power",
  axis: "behaviour",
  level: 1,
  variant: "capture-2",
  ref: "sfab/nano-power-input-behaviour-2@1.0.0",
});
expect(state.phase === "landed", "captured lands");
if (state.phase === "landed") {
  expect(capturedLabel(state) === "power capture-2", "toast label");
}
expect(captureProgress(state) === null, "no bar once it landed");
expect(settleCapture(state).phase === "idle", "a landing settles to idle");

// progress, then failed
state = takeCaptureMessage(
  takeCaptureMessage(beginCapture(IDLE_CAPTURE, request), {
    type: "capture-progress",
    nonce: "n1",
    done: 1,
    total: 4,
    label: "fit",
  }),
  { type: "capture-failed", nonce: "n1", message: "fit did not converge" }
);
expect(
  state.phase === "failed" &&
    captureFailure(state, "nano.power") === "fit did not converge",
  "a failure shows on its card"
);
expect(
  captureFailure(state, "nano") === null,
  "another instance's card shows no block"
);
expect(
  settleCapture(state).phase === "idle" &&
    captureFailure(settleCapture(state), "nano.power") === null,
  "a selection change clears the block"
);

// aborted: no block
state = takeCaptureMessage(beginCapture(IDLE_CAPTURE, request), {
  type: "capture-failed",
  nonce: "n1",
  message: CAPTURE_ABORTED,
});
expect(
  state.phase === "failed" && captureFailure(state, "nano.power") === null,
  "an abort is not an error block"
);

// a stray nonce is ignored, and so is any message when nothing runs
const running = beginCapture(IDLE_CAPTURE, request);
for (const stray of [
  { type: "capture-progress", nonce: "other", done: 1, total: 2, label: "x" },
  { type: "capture-failed", nonce: "other", message: "boom" },
  {
    type: "captured",
    nonce: "other",
    path: "nano",
    axis: "behaviour",
    level: 1,
    variant: "capture-9",
    ref: "x",
  },
] as const) {
  expect(
    takeCaptureMessage(running, stray) === running,
    `a stray ${stray.type} is ignored`
  );
}
expect(
  takeCaptureMessage(IDLE_CAPTURE, {
    type: "capture-failed",
    nonce: "n1",
    message: "late",
  }) === IDLE_CAPTURE,
  "a message with no job running is ignored"
);
expect(
  settleCapture(running) === running,
  "a selection change leaves a running capture alone"
);

// the button's reason
expect(
  captureDisabledReason(IDLE_CAPTURE, { capture: { ready: true } }) === null,
  "ready and idle is enabled"
);
expect(
  captureDisabledReason(running, { capture: { ready: true } }) ===
    "a capture is running",
  "a running capture disables the others"
);
expect(
  captureDisabledReason(running, {
    capture: { ready: false, reason: "no capture recipe for mcu" },
  }) === "no capture recipe for mcu",
  "the server's reason comes first"
);
expect(
  captureDisabledReason(IDLE_CAPTURE, {}) !== null,
  "an axis with no capture field has no button"
);

// level sources, delete and where an edit goes
expect(
  levelSourceWords("overlay")?.word === "overlay" &&
    levelSourceWords(undefined) === null,
  "an option names its source, or none"
);
expect(
  levelDeletable({ deletable: true }) && !levelDeletable({}),
  "delete follows the view's flag, never the variant's name"
);
deepStrictEqual(
  captureEditTarget(
    { part: "sfab/nano-power-input@1.0.0", source: "library" },
    "parts/w.json"
  ),
  { document: "parts/w.json", part: "sfab/nano-power-input@1.0.0" }
);
deepStrictEqual(
  captureEditTarget(
    { part: "me/rig@1.0.0", source: "project" },
    "parts/w.json"
  ),
  { document: "me/rig@1.0.0", part: "me/rig@1.0.0", session: "me/rig@1.0.0" }
);
deepStrictEqual(
  removeCaptureOp(
    { document: "parts/w.json", part: "sfab/nano-power-input@1.0.0" },
    "behaviour",
    { class: 1, variant: "capture-1" }
  ),
  {
    kind: "remove-capture",
    document: "parts/w.json",
    part: "sfab/nano-power-input@1.0.0",
    axis: "behaviour",
    level: 1,
    variant: "capture-1",
  }
);

console.log("world-capture.selfcheck ok");
