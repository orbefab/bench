/**
 * The world store's document and history slices: reopening the same
 * document keeps what the user was doing, opening another clears it, and
 * an action that changes nothing does not notify subscribers.
 */

import { ok as expect } from "node:assert/strict";

import { worldStore } from "./world";

const arm = "examples/arm/parts/sfab/arm-bench@1.0.0.json";
const nano = "examples/nano/parts/sfab/nano-led@1.0.0.json";
const store = () => worldStore.getState();

let notified = 0;
const unsubscribe = worldStore.subscribe(() => {
  notified += 1;
});

try {
  // Reopening the same document: a no-op while it is connecting, a reload
  // that keeps the selection, the undo stack and the last edit's label when
  // forced, and a clean slate for another document.
  store().open(arm);
  const firstLoad = store().loadId;
  store().select({ kind: "instance", path: "arm" });
  store().applyHistory({ canUndo: true, canRedo: false }, "move arm");
  store().setEditError(
    "Not undone: the document changed outside this session."
  );
  store().open(arm);
  expect(
    store().loadId === firstLoad,
    "a second open of the same document waits"
  );
  store().open(arm, { force: true });
  expect(
    store().loadId === firstLoad + 1 &&
      store().connection === "connecting" &&
      store().selection?.path === "arm" &&
      store().history.undoOrder.length === 1 &&
      store().editLabel === "move arm" &&
      store().editError === null,
    "a forced reopen keeps the selection, history and label, and clears the error"
  );
  store().open(nano);
  expect(
    store().selection === null &&
      store().history.undoOrder.length === 0 &&
      store().editLabel === null,
    "another document starts clear"
  );

  // The same history answer and label twice: one notification. Replacing the
  // history (a reconnect) drops the label.
  store().applyHistory({ canUndo: true, canRedo: false }, "set play");
  const before = notified;
  store().applyHistory(
    { canUndo: true, canRedo: false, kind: "state" },
    "set play"
  );
  expect(notified === before, "an unchanged history answer does not notify");
  store().replaceHistory(store().history);
  expect(
    store().editLabel === "set play",
    "replacing with the same history changes nothing"
  );
  store().replaceHistory({
    ...store().history,
    undoOrder: [],
    parts: [{ canUndo: false, canRedo: false }],
  });
  expect(
    store().editLabel === null && store().history.undoOrder.length === 0,
    "a replaced history drops the last edit's label"
  );

  // A run problem stops play; a blank message is no message, and clearing an
  // empty problem does not notify.
  store().setRun(true, 1.5);
  store().setRunProblem([], "  ");
  expect(
    !store().playing &&
      store().connection === "live" &&
      store().runMessage === null,
    "a run problem stops play and drops a blank message"
  );
  const quiet = notified;
  store().clearRunProblem();
  expect(notified === quiet, "clearing no problem does not notify");

  store().close();
  expect(
    store().path === "" &&
      store().connection === "idle" &&
      store().history.undoOrder.length === 0,
    "close returns to idle with no history"
  );
  const closed = notified;
  store().close();
  expect(notified === closed, "a second close does not notify");
} finally {
  // The checks share one process: leave the store closed.
  store().close();
  unsubscribe();
}

console.log(
  "world-store: same-document reopen waits or keeps state, another document clears, unchanged actions do not notify"
);
console.log("world-store.selfcheck ok");
