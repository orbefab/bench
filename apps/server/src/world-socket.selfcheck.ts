/**
 * What the world socket says back, one line per case: the message type and
 * its text. Raw client text goes through the same parse and reply the
 * socket uses. Copies only.
 */
import { ok as expect } from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { WorldServerMessage } from "@sfab-bench/contract";

import { closeRootWatches } from "./projects";
import { handleLiveEdit } from "./world/edit";
import { attachWorld, stopWorld } from "./world/host";
import { parseFailureReply, parseWorldClient } from "./world/live-message";

const SCENE = "parts/sfab/nano-servo-scene@1.0.0.json";
const BROKEN = "parts/sfab/broken@1.0.0.json";
const nanoDir = fileURLToPath(
  new URL("../../../examples/nano/", import.meta.url)
);

const project = mkdtempSync(join(tmpdir(), "sfab-world-socket-"));
cpSync(nanoDir, project, { recursive: true });
writeFileSync(join(project, BROKEN), "this is not a part");

/** The reply the socket sends for one raw edit, undo, or redo message. */
async function reply(raw: string): Promise<WorldServerMessage> {
  const parsed = parseWorldClient(raw);
  if ("error" in parsed) return parseFailureReply(parsed);
  if (
    parsed.type !== "edit" &&
    parsed.type !== "undo" &&
    parsed.type !== "redo"
  ) {
    throw new Error(`not an edit: ${parsed.type}`);
  }
  return handleLiveEdit(project, SCENE, parsed);
}

function line(name: string, event: WorldServerMessage): string {
  if (event.type !== "edit-refused" && event.type !== "error") {
    throw new Error(`${name}: ${JSON.stringify(event)}`);
  }
  const said =
    event.type === "error"
      ? (event.message ?? event.errors.map((error) => error.message).join("; "))
      : event.message;
  const text = `${event.type}: ${said}`;
  console.log(`socket ${name}: ${text}`);
  return text;
}

const wire = (a: string, b: string) =>
  JSON.stringify({
    type: "edit",
    label: `Wire ${a} to ${b}`,
    ops: [{ kind: "wire", document: SCENE, a, b }],
  });

const wired = line("wire refused", await reply(wire("nano.D9", "nano.D9")));
expect(
  wired.startsWith("edit-refused: ") &&
    wired.includes("nano.D9 cannot be wired to itself"),
  wired
);

const unknown = line(
  "unknown op",
  await reply(
    JSON.stringify({ type: "edit", ops: [{ kind: "spin", document: SCENE }] })
  )
);
expect(unknown.startsWith("edit-refused: "), unknown);

const undo = line("nothing to undo", await reply('{"type":"undo"}'));
expect(undo.startsWith("edit-refused: nothing to undo"), undo);
const redo = line("nothing to redo", await reply('{"type":"redo"}'));
expect(redo.startsWith("edit-refused: nothing to redo"), redo);

const events: WorldServerMessage[] = [];
const attached = await attachWorld(project, BROKEN, {
  sender: { kind: "loopback", label: "Mac" },
  onEvent: (event) => events.push(event),
});
if ("error" in attached) {
  events.push({ type: "error", errors: [], message: attached.error });
} else attached.detach();
const problem = events.find((event) => event.type === "error");
expect(problem !== undefined, JSON.stringify(events));
if (problem) line("document that cannot run", problem);
expect(
  events.every((event) => event.type !== "edit-refused"),
  "a run problem came as an edit refusal"
);

await stopWorld(project, SCENE);
await stopWorld(project, BROKEN);
closeRootWatches();
rmSync(project, { recursive: true, force: true });
console.log("world-socket.selfcheck ok");
