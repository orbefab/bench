import { ok as expect } from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import {
  applyThreadSessionsSchema,
  isResumePayload,
  isUnusableResumeError,
  loadThreadSession,
  lostContext,
  nativeIdFromResume,
  parseStoredResume,
  resumeFromStored,
  saveThreadSession,
  shouldPersistPark,
  stripResumeCredentials,
} from "./thread-sessions";

const withCreds = {
  type: "resume-session" as const,
  specificationVersion: "harness-v1" as const,
  harnessId: "codex",
  data: {
    threadId: "t1",
    sandboxCredentialEnvironment: { OPENAI_API_KEY: "aisdkhc_secret" },
    bridge: { port: 1, token: "x", lastSeenEventId: 0 },
  },
};
const stripped = stripResumeCredentials(withCreds);
expect(
  !("sandboxCredentialEnvironment" in (stripped.data as object)),
  "strip sandboxCredentialEnvironment"
);
expect(
  (withCreds.data as { sandboxCredentialEnvironment?: unknown })
    .sandboxCredentialEnvironment != null,
  "strip does not mutate the original"
);
expect(
  (stripped.data as { threadId: string }).threadId === "t1",
  "strip keeps the rest of data"
);

expect(
  nativeIdFromResume("codex", { data: { threadId: "codex-1" } }) === "codex-1",
  "codex native id"
);
expect(
  nativeIdFromResume("opencode", { data: { openCodeSessionId: "oc-1" } }) ===
    "oc-1",
  "opencode native id"
);
expect(
  nativeIdFromResume("cursor", { data: { acpSessionId: "acp-1" } }) === "acp-1",
  "cursor native id"
);
expect(
  nativeIdFromResume("grok-build", { data: { acpSessionId: "acp-2" } }) ===
    "acp-2",
  "grok native id"
);
expect(
  nativeIdFromResume("codex", { data: {} }) === null,
  "missing native id is null"
);

expect(
  !lostContext(null, "first"),
  "first persist with null native_id is not lost context"
);
expect(!lostContext(undefined, "first"), "undefined prev is not lost context");
expect(!lostContext("same", "same"), "unchanged native id is not lost context");
expect(lostContext("old", "new"), "changed native id is lost context");

expect(
  !("resumeFrom" in resumeFromStored(null)),
  "no stored state → no resumeFrom"
);
expect(
  !("resumeFrom" in resumeFromStored(undefined)),
  "missing stored state → no resumeFrom"
);
const stored = { type: "resume-session", data: { threadId: "t1" } };
expect(
  resumeFromStored(stored).resumeFrom === stored,
  "stored → resumeFrom passed"
);

expect(
  !shouldPersistPark({
    unfinished: true,
    aborted: false,
    continueFrom: { type: "continue-turn" },
  }),
  "unfinished turn → do not persist continueFrom"
);
expect(
  shouldPersistPark({ unfinished: false, aborted: false }),
  "idle payload is persisted"
);
expect(
  !shouldPersistPark({ unfinished: false, aborted: true }),
  "aborted turn is not persisted"
);
expect(
  !shouldPersistPark({
    unfinished: false,
    aborted: false,
    continueFrom: { type: "continue-turn" },
  }),
  "continueFrom on an idle-looking payload is still refused"
);

expect(parseStoredResume("{") === null, "corrupt JSON is not a resume payload");
expect(
  !isResumePayload({
    type: "continue-turn",
    specificationVersion: "harness-v1",
    harnessId: "codex",
  }),
  "continue-turn is not resume"
);
expect(
  isResumePayload({
    type: "resume-session",
    specificationVersion: "harness-v1",
    harnessId: "codex",
    data: {},
  }),
  "resume-session shape is accepted"
);
expect(
  isUnusableResumeError(
    new Error(
      "ACP lifecycle state is incompatible with the configured implementation."
    )
  ),
  "ACP identity mismatch is unusable"
);
const schemaErr = new Error("Lifecycle state failed schema validation");
schemaErr.name = "AI_HarnessError";
expect(isUnusableResumeError(schemaErr), "schema failure is unusable");
const unsupported = new Error("sandbox provider does not support resume");
unsupported.name = "AI_HarnessCapabilityUnsupportedError";
expect(isUnusableResumeError(unsupported), "missing resumeSession is unusable");
const transient = new Error("rate limited");
transient.name = "AI_HarnessError";
expect(
  !isUnusableResumeError(transient),
  "a generic harness error keeps the stored payload"
);
expect(
  !isUnusableResumeError(new Error("ECONNREFUSED")),
  "a transport error keeps the stored payload"
);

const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, workspace TEXT NOT NULL)");
applyThreadSessionsSchema(db);

expect(
  !saveThreadSession(db, {
    threadId: "ghost",
    workspace: "/tmp/ws",
    harness: "codex",
    state: stripped,
    nativeId: "t1",
  }),
  "refuse save when the thread id is not in threads"
);
expect(
  loadThreadSession(db, "ghost", "codex") === null,
  "ghost save does not write a row"
);

db.prepare("INSERT INTO threads (id, workspace) VALUES (?, ?)").run(
  "thr-1",
  "/tmp/ws"
);
expect(
  saveThreadSession(db, {
    threadId: "thr-1",
    workspace: "/tmp/ws",
    harness: "codex",
    state: stripped,
    nativeId: "t1",
  }),
  "known thread can persist"
);
const row = db
  .prepare(
    "SELECT state, native_id FROM thread_sessions WHERE thread_id = ? AND harness = ?"
  )
  .get("thr-1", "codex") as { state: string; native_id: string };
expect(row.native_id === "t1", "native_id written in the same row as state");
expect(
  JSON.parse(row.state).data.threadId === "t1",
  "state written in the same row as native_id"
);
expect(
  !("sandboxCredentialEnvironment" in JSON.parse(row.state).data),
  "persisted state has credentials stripped"
);

const loaded = loadThreadSession(db, "thr-1", "codex");
expect(loaded?.native_id === "t1", "load returns native_id");
expect(isResumePayload(loaded?.state), "load returns resume state");

console.log("thread-sessions.selfcheck ok");
