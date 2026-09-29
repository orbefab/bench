import { ok as expect } from "node:assert/strict";
import {
  findPendingGetViewer,
  getViewerFillReady,
  latestShownArtifact,
  shownFromPart,
  viewerIsReady,
} from "./get-viewer";

const shownTool = shownFromPart(
  {
    type: "tool-show_artifact",
    toolName: "show_artifact",
    toolCallId: "show-1",
    state: "output-available",
    output: { shown: "STEP/m8_nut.step" },
  },
  0,
  "msg-1"
);
expect(shownTool?.file === "STEP/m8_nut.step", "show_artifact shown path");

const shownData = shownFromPart(
  { type: "data-viewer", data: { file: "STEP/m8_nut.step" } },
  1,
  "msg-1"
);
expect(shownData?.file === "STEP/m8_nut.step", "data-viewer shown path");
expect(
  shownFromPart(
    { type: "tool-show_artifact", state: "input-available" },
    0,
    "msg-1"
  ) === null,
  "pending show is not shown"
);

const latest = latestShownArtifact([
  {
    id: "a",
    parts: [{ type: "data-viewer", data: { file: "old.step" } }],
  },
  {
    id: "b",
    parts: [
      {
        type: "tool-show_artifact",
        toolCallId: "s2",
        state: "output-available",
        output: { shown: "STEP/m8_nut.step" },
      },
    ],
  },
]);
expect(latest === "STEP/m8_nut.step", `latest shown, got ${latest}`);

const pending = findPendingGetViewer([
  {
    role: "assistant",
    parts: [
      {
        type: "tool-get_viewer",
        toolCallId: "gv-1",
        state: "input-available",
        input: {},
      },
    ],
  },
]);
expect(pending?.toolCallId === "gv-1", "finds pending get_viewer");
expect(
  getViewerFillReady({ pending: true, streaming: true }) === false,
  "a get_viewer continuation waits until the stream releases the folder lock"
);
expect(
  getViewerFillReady({ pending: true, streaming: false }) === true,
  "the continuation may post once the turn is no longer streaming"
);
expect(
  getViewerFillReady({ pending: false, streaming: false }) === false,
  "nothing pending does not post a continuation"
);

expect(
  findPendingGetViewer([
    {
      role: "assistant",
      parts: [
        {
          type: "tool-get_viewer",
          toolCallId: "gv-1",
          state: "output-available",
          output: { empty: true },
        },
      ],
    },
  ]) === null,
  "answered get_viewer is not pending"
);

expect(
  viewerIsReady({ url: "", progress: null }, null) === true,
  "empty idle is ready"
);
expect(
  viewerIsReady({ url: "", progress: 0 }, null) === false,
  "loading is not ready"
);
expect(
  viewerIsReady({ url: "old.step", progress: null }, "STEP/m8_nut.step") ===
    false,
  "wrong file is not ready"
);
expect(
  viewerIsReady(
    { url: "STEP/m8_nut.step", progress: 40 },
    "STEP/m8_nut.step"
  ) === false,
  "target still loading"
);
expect(
  viewerIsReady(
    { url: "STEP/m8_nut.step", progress: null },
    "STEP/m8_nut.step"
  ) === true,
  "target settled"
);

console.log("get-viewer.selfcheck ok");
