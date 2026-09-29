import { ok as expect } from "node:assert/strict";
import {
  firstSetupCopy,
  inFlightHarness,
  lastUserPromptText,
  mapChatErrorMessage,
  NO_UNFINISHED_TURN_MESSAGE,
  providerSendBlockReason,
  shouldLatchFirstSetup,
  showFirstSetupHint,
  stripViewerStamp,
  userPromptText,
  WORKSPACE_BUSY_MESSAGE,
} from "./composer-recovery";

const user = (id: string, text: string) => ({
  id,
  role: "user" as const,
  parts: [{ type: "text" as const, text }],
});
const assistant = {
  id: "a",
  role: "assistant" as const,
  parts: [{ type: "text" as const, text: "ok" }],
};

const stamped = user("u1", "[viewer] file=bracket.step\nHow tall is #o1.2.1?");
expect(
  stripViewerStamp("[viewer] file=bracket.step\nHow tall is #o1.2.1?") ===
    "How tall is #o1.2.1?",
  "strip viewer stamp"
);
expect(
  userPromptText(stamped) === "How tall is #o1.2.1?",
  "user prompt strips stamp"
);
expect(
  lastUserPromptText([stamped, assistant]) === "How tall is #o1.2.1?",
  "last user prompt"
);
expect(lastUserPromptText([assistant]) === null, "no user");

expect(
  mapChatErrorMessage("QA blocked send") === "QA blocked send",
  "generic error stays"
);
expect(
  mapChatErrorMessage("a reply is already in progress") ===
    WORKSPACE_BUSY_MESSAGE,
  "server 409 body"
);
expect(
  mapChatErrorMessage(new Error("a reply is already in progress")) ===
    WORKSPACE_BUSY_MESSAGE,
  "SDK Error(body) 409"
);
expect(
  mapChatErrorMessage(new Error("Failed to fetch the chat response.")) ===
    "Failed to fetch the chat response.",
  "Failed to fetch is not a 409"
);
expect(mapChatErrorMessage(null) === null, "null error");
expect(
  mapChatErrorMessage("no unfinished turn") === NO_UNFINISHED_TURN_MESSAGE,
  "idle fill 409"
);
expect(
  mapChatErrorMessage(
    new Error("Harness session abc has no unfinished turn to continue.")
  ) === NO_UNFINISHED_TURN_MESSAGE,
  "harness idle continue maps the same"
);

expect(
  providerSendBlockReason({
    ready: true,
    label: "Codex",
    status: "needs-auth",
    detail: "Run `codex login`.",
  }) === "Codex isn't signed in — run `codex login`",
  "reuse provider status sentence"
);
expect(
  providerSendBlockReason({ ready: true, label: "Codex", status: "ready" }) ===
    null,
  "ready is not a block"
);
expect(
  providerSendBlockReason({
    ready: false,
    label: "Codex",
    status: "needs-auth",
  }) === null,
  "catalog not loaded yet"
);

expect(
  firstSetupCopy("Grok") ===
    "First-time setup for Grok. Takes a minute, then we skip this.",
  "first-time setup copy"
);
expect(
  showFirstSetupHint({
    status: "submitted",
    bridgeReady: false,
    latched: false,
  }),
  "submitted before the vendor dir exists"
);
expect(
  !showFirstSetupHint({
    status: "submitted",
    bridgeReady: true,
    latched: false,
  }),
  "already installed stays quiet"
);
expect(
  !showFirstSetupHint({
    status: "submitted",
    bridgeReady: undefined,
    latched: false,
  }),
  "unknown catalog is not a first-time claim"
);
expect(
  !showFirstSetupHint({
    status: "streaming",
    bridgeReady: false,
    latched: false,
  }),
  "stream started is past the wait"
);
expect(
  !showFirstSetupHint({
    status: "submitted",
    bridgeReady: false,
    latched: true,
  }),
  "stale false after a stream does not flash"
);

expect(
  inFlightHarness({
    status: "submitted",
    live: "grok-build",
    frozen: null,
  }).harness === "grok-build",
  "first submitted freezes the live picker"
);
expect(
  inFlightHarness({
    status: "submitted",
    live: "cursor",
    frozen: "grok-build",
  }).harness === "grok-build",
  "mid-wait picker change does not steal the line"
);
expect(
  inFlightHarness({
    status: "ready",
    live: "cursor",
    frozen: "grok-build",
  }).frozen === null &&
    inFlightHarness({
      status: "ready",
      live: "cursor",
      frozen: "grok-build",
    }).harness === "cursor",
  "idle follows the live picker again"
);
expect(
  shouldLatchFirstSetup({
    status: "streaming",
    harness: "grok-build",
    latched: new Set(),
  }),
  "first stream latches"
);
expect(
  !shouldLatchFirstSetup({
    status: "streaming",
    harness: "grok-build",
    latched: new Set(["grok-build"]),
  }),
  "already latched does not latch again"
);
expect(
  !shouldLatchFirstSetup({
    status: "submitted",
    harness: "grok-build",
    latched: new Set(),
  }),
  "wait is not a latch"
);

console.log("composer-recovery.selfcheck ok");
