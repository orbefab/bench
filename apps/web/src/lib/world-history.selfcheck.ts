import { ok as expect } from "node:assert/strict";
import {
  applyHistory,
  emptyHistory,
  historyButtons,
  refuseHistory,
  syncHistories,
} from "./world-history";

const scene = "sfab/nano-servo-scene@1.0.0";
const flags = new Map<string, { canUndo: boolean; canRedo: boolean }>();
let model = emptyHistory();

function answer(
  part: string | undefined,
  canUndo: boolean,
  canRedo: boolean,
  kind: "edit" | "undo" | "redo"
) {
  flags.set(part ?? "", { canUndo, canRedo });
  const histories = [...flags.entries()].map(([key, row]) => ({
    ...(key ? { part: key } : {}),
    canUndo: row.canUndo,
    canRedo: row.canRedo,
  }));
  model = applyHistory(model, { kind, part, canUndo, canRedo, histories });
}

answer(undefined, true, false, "edit");
answer(undefined, false, true, "undo");
answer(undefined, true, false, "redo");
answer(undefined, false, true, "undo");
answer(scene, true, false, "edit");
answer(scene, false, true, "undo");
answer(scene, true, false, "redo");
answer(scene, false, true, "undo");
answer(undefined, true, false, "redo");
answer(undefined, true, false, "edit");
answer(undefined, true, true, "undo");
answer(undefined, false, true, "undo");

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

let renamed = applyHistory(emptyHistory(), {
  part: scene,
  canUndo: true,
  canRedo: false,
  histories: [{ part: scene, canUndo: true, canRedo: false }],
});
renamed = applyHistory(renamed, {
  canUndo: true,
  canRedo: false,
  histories: [
    { canUndo: true, canRedo: false },
    { part: scene, canUndo: true, canRedo: false },
  ],
});
renamed = applyHistory(renamed, {
  canUndo: false,
  canRedo: true,
  histories: [
    { canUndo: false, canRedo: true },
    { part: scene, canUndo: true, canRedo: false },
  ],
});
const afterRootUndo = historyButtons(renamed);
expect(
  afterRootUndo.canUndo === true && afterRootUndo.undoPart === scene,
  "undo of a root rename leaves the nested rename"
);
const reconnected = historyButtons(
  syncHistories(renamed, [
    { canUndo: false, canRedo: true },
    { part: scene, canUndo: true, canRedo: false },
  ])
);
expect(
  reconnected.canUndo === true && reconnected.undoPart === scene,
  "a reconnect after the move keeps the nested rename"
);

// One user action is one undo: the capture (rail), Use it (the world), then a
// Break (rail again). Undoing the Break leaves the rail's older capture behind
// the world's Use it, so the presses go rail, world, rail: three, not four.
{
  const rail = "local/rail@1.0.0";
  const steps = new Map<string, { undo: number; redo: number }>();
  let live = emptyHistory();
  const stepsOf = (key: string) => {
    const row = steps.get(key) ?? { undo: 0, redo: 0 };
    steps.set(key, row);
    return row;
  };
  const histories = () =>
    [...steps.entries()].map(([key, row]) => ({
      ...(key ? { part: key } : {}),
      canUndo: row.undo > 0,
      canRedo: row.redo > 0,
    }));
  const edit = (part: string | undefined) => {
    const row = stepsOf(part ?? "");
    row.undo += 1;
    row.redo = 0;
    live = applyHistory(live, {
      kind: "edit",
      ...(part ? { part } : {}),
      canUndo: true,
      canRedo: false,
      histories: histories(),
    });
  };
  const press = (kind: "undo" | "redo"): string | undefined | null => {
    const buttons = historyButtons(live);
    const target = kind === "undo" ? buttons.undoPart : buttons.redoPart;
    if (kind === "undo" ? !buttons.canUndo : !buttons.canRedo) return null;
    const row = stepsOf(target ?? "");
    if (kind === "undo") {
      row.undo -= 1;
      row.redo += 1;
    } else {
      row.redo -= 1;
      row.undo += 1;
    }
    live = applyHistory(live, {
      kind,
      ...(target ? { part: target } : {}),
      canUndo: row.undo > 0,
      canRedo: row.redo > 0,
      histories: histories(),
    });
    return target;
  };
  edit(rail);
  edit(undefined);
  edit(rail);
  const undone: (string | undefined | null)[] = [];
  for (let i = 0; i < 5; i++) {
    const target = press("undo");
    if (target === null) break;
    undone.push(target);
  }
  expect(
    JSON.stringify(undone) === JSON.stringify([rail, undefined, rail]),
    `a Break is one undo: ${JSON.stringify(undone)}`
  );
  const redone: (string | undefined | null)[] = [];
  for (let i = 0; i < 5; i++) {
    const target = press("redo");
    if (target === null) break;
    redone.push(target);
  }
  expect(
    JSON.stringify(redone) === JSON.stringify([rail, undefined, rail]),
    `and its redo is three steps in order: ${JSON.stringify(redone)}`
  );
  // A fixed-ports Break on the open document is one step on it: one undo. A
  // Stay sends nothing, so there is no answer and no entry.
  steps.clear();
  live = emptyHistory();
  edit(undefined);
  expect(
    JSON.stringify([press("undo"), press("undo")]) ===
      JSON.stringify([undefined, null]),
    "a fixed-ports Break is one undo"
  );
  edit(rail);
  edit(undefined);
  edit(rail);
  for (const _ of [1, 2, 3]) press("undo");
  for (const _ of [1, 2, 3]) press("redo");
  // A refused undo records nothing and clears that part only.
  const refusedModel = refuseHistory(live, "undo", rail);
  expect(
    refusedModel.undoOrder.filter((key) => key === rail).length === 0 &&
      refusedModel.undoOrder.length === live.undoOrder.length - 2,
    "a refused undo drops that part's undo entries and nothing else"
  );
}

console.log("world-history.selfcheck ok");
