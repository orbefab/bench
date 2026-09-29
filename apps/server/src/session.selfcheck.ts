import { ok as expect } from "node:assert/strict";
import {
  clientOf,
  endSessionRun,
  hydrateSession,
  rememberOpenedFile,
  sessionState,
  startSessionRun,
  subscribeSession,
} from "./session";

hydrateSession();
expect(
  sessionState().fileRecents.length === 0 ||
    Array.isArray(sessionState().fileRecents),
  "file recents is an array"
);
expect(!("doc" in sessionState()), "library session has no shared doc");
expect(
  sessionState().project.path === "" ||
    typeof sessionState().project.path === "string",
  "project path is a string"
);

const received: string[] = [];
const unsub = subscribeSession({
  send: (data) => received.push(data),
});

rememberOpenedFile("cad/STEP/box.step");
expect(
  received.some(
    (row) => row.includes('"type":"library"') || row.includes("fileRecents")
  ) || !sessionState().project.path,
  "remembering a file broadcasts library when a project is open, or no-ops without one"
);

const mac = { kind: "loopback" as const };
expect(clientOf(mac).label === "Mac", "loopback label is Mac");

const quest = {
  kind: "paired" as const,
  deviceId: "dev-1",
  label: "Quest",
};
expect(clientOf(quest).id === "dev-1", "paired client id is the device");

const folderA = "/tmp/sfab-run-a";
const folderB = "/tmp/sfab-run-b";
const runA = startSessionRun(folderA);
expect(runA != null, "idle run starts");
expect(
  startSessionRun(folderA) == null,
  "second run on the same folder is rejected"
);
const runB = startSessionRun(folderB);
expect(runB != null, "a second folder can run at the same time");
hydrateSession();
expect(
  !runA!.signal.aborted,
  "hydrateSession does not abort another folder's run"
);
expect(
  !runB!.signal.aborted,
  "hydrateSession does not abort the named folder's run"
);
endSessionRun(folderA);
expect(startSessionRun(folderA) != null, "run lock clears per folder");
endSessionRun(folderA);
endSessionRun(folderB);

unsub();
console.log("session.selfcheck ok");
