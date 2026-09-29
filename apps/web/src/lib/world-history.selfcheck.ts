import {
  applyHistory,
  emptyHistory,
  historyButtons,
  refuseHistory,
  syncHistories,
} from "./world-history";

function expect(cond: boolean, label: string) {
  if (!cond) throw new Error(label);
}

const scene = "sfab/nano-servo-scene@1.0.0";
const flags = new Map<string, { canUndo: boolean; canRedo: boolean }>();
let model = emptyHistory();

function answer(part: string | undefined, canUndo: boolean, canRedo: boolean) {
  flags.set(part ?? "", { canUndo, canRedo });
  const histories = [...flags.entries()].map(([key, row]) => ({
    ...(key ? { part: key } : {}),
    canUndo: row.canUndo,
    canRedo: row.canRedo,
  }));
  model = applyHistory(model, { part, canUndo, canRedo, histories });
}

answer(undefined, true, false);
answer(undefined, false, true);
answer(undefined, true, false);
answer(undefined, false, true);
answer(scene, true, false);
answer(scene, false, true);
answer(scene, true, false);
answer(scene, false, true);
answer(undefined, true, false);
answer(undefined, true, false);
answer(undefined, true, true);
answer(undefined, false, true);

const done = historyButtons(model);
expect(done.canUndo === false, "undo ends disabled");
expect(
  done.canRedo === true && done.redoPart === undefined,
  "redo is the open document"
);

let drifted = applyHistory(emptyHistory(), {
  canUndo: true,
  canRedo: false,
});
drifted = applyHistory(drifted, {
  canUndo: false,
  canRedo: true,
  histories: [{ canUndo: false, canRedo: true }],
});
expect(
  historyButtons(drifted).canUndo === false,
  "a false canUndo trims the stack"
);

const refused = refuseHistory(
  applyHistory(emptyHistory(), { part: scene, canUndo: true, canRedo: false }),
  "undo",
  scene
);
expect(
  historyButtons(refused).canUndo === false,
  "a refused undo disables the button"
);

const remote = applyHistory(emptyHistory(), {
  part: scene,
  canUndo: true,
  canRedo: false,
  histories: [
    { canUndo: false, canRedo: false },
    { part: scene, canUndo: true, canRedo: false },
  ],
});
expect(
  historyButtons(remote).canUndo === true &&
    historyButtons(remote).undoPart === scene,
  "another tab's edit enables undo on that part"
);

const synced = syncHistories(remote, [
  { canUndo: true, canRedo: false },
  { part: scene, canUndo: false, canRedo: true },
]);
const syncedButtons = historyButtons(synced);
expect(
  syncedButtons.canUndo === true && syncedButtons.undoPart === undefined,
  "a histories reply follows the server for this document"
);
expect(
  syncedButtons.canRedo === true && syncedButtons.redoPart === scene,
  "a histories reply keeps a part the server can still redo"
);

console.log("world-history.selfcheck ok");
