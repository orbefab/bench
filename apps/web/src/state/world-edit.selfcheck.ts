import { ok } from "node:assert/strict";

import {
  removeInstanceOp,
  renameInstanceOp,
  setParamOp,
} from "@/lib/world-ops";
import { worldStore } from "./world";
import {
  commitEdit,
  stayPendingEdit,
  stopPendingEdit,
  worldEditStore,
} from "./world-edit";

// No narrowing: the checks below compare the same values again after they change.
const expect: (cond: unknown, label: string) => void = ok;

const target = { document: "parts/sfab/arm@1.0.0.json", id: "servo" };
const card = setParamOp(target, "angle", "30", 10);
const tree = removeInstanceOp(target);
const rename = renameInstanceOp(target, "servo", "wrist");
if (!card || !rename) throw new Error("the builders gave no operation");

const pending = () => worldEditStore.getState().pending;

// Playing: a card edit and a tree edit both ask, and nothing is sent yet.
worldStore.getState().setRun(true, 1.5);
expect(
  commitEdit([card], { part: "sfab/arm@1.0.0" }) === "asked",
  "a card edit while playing asks"
);
expect(
  pending()?.ops[0] === card && pending()?.part === "sfab/arm@1.0.0",
  "the ask holds the card edit"
);
expect(commitEdit([tree]) === "asked", "a tree edit while playing asks");
expect(pending()?.ops[0] === tree, "the ask holds the tree edit");
expect(
  commitEdit([rename]) === "asked" && pending()?.ops[0] === rename,
  "a rename from the tree asks"
);

// Stay drops the edit and counts, so a card field drops what was typed.
const stays = worldEditStore.getState().stays;
worldStore.getState().setEditError("an earlier refusal");
stayPendingEdit();
expect(pending() === null, "Stay drops the edit");
expect(
  worldStore.getState().editError === "an earlier refusal",
  "Stay sends nothing"
);
expect(worldEditStore.getState().stays === stays + 1, "Stay is counted");

// Stop and continue pauses and sends. `sendWorldEdit` clears the edit line
// before it writes to the socket, so a stale line going away shows the send.
expect(commitEdit([card]) === "asked", "asks again after Stay");
worldStore.getState().setEditError("an earlier refusal");
expect(
  worldStore.getState().editError === "an earlier refusal",
  "the earlier refusal waits while the edit is asked about"
);
stopPendingEdit();
expect(pending() === null, "Stop clears the ask");
expect(worldStore.getState().editError === null, "Stop sends the edit");
expect(worldEditStore.getState().stays === stays + 1, "Stop is not a Stay");

// A confirmed edit was already asked about, so it goes out at once.
expect(
  commitEdit([tree], { confirm: "break" }) === "sent" && pending() === null,
  "a confirmed edit does not ask again"
);

// Paused (time on the clock, not playing) and stopped: applied at once.
worldStore.getState().setRun(false, 1.5);
expect(commitEdit([card]) === "sent", "a card edit while paused applies");
expect(commitEdit([tree]) === "sent", "a tree edit while paused applies");
expect(pending() === null, "nothing waits while paused");
worldStore.getState().setRun(false, 0);
expect(commitEdit([card]) === "sent", "a card edit while stopped applies");
expect(commitEdit([tree]) === "sent", "a tree edit while stopped applies");
expect(pending() === null, "nothing waits while stopped");

console.log("world-edit.selfcheck ok");
