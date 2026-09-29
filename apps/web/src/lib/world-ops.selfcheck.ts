import { ok as expect, deepStrictEqual as same } from "node:assert/strict";

import { DEFAULT_TIMESTEP_S, type WorldViewPlay } from "@sfab-bench/contract";

import {
  removeInstanceOp,
  renameInstanceOp,
  renamePartOp,
  setLevelOp,
  setParamOp,
  setPlayOp,
  unwireOp,
} from "./world-ops";

const target = { document: "parts/sfab/arm@1.0.0.json", id: "servo" };

// A card field: a number, a flag and a string each compare against what the
// card showed, and an unchanged or unreadable one is no edit.
same(setParamOp(target, "angle", "30", 10), {
  kind: "set-param",
  document: target.document,
  id: "servo",
  name: "angle",
  value: 30,
});
expect(setParamOp(target, "angle", "10", 10) === null, "same number");
expect(setParamOp(target, "angle", "ten", 10) === null, "not a number");
expect(setParamOp(target, "angle", "Infinity", 10) === null, "not finite");
same(setParamOp(target, "on", "true", false)?.kind, "set-param");
same(
  (setParamOp(target, "on", "true", false) as { value: unknown }).value,
  true
);
expect(setParamOp(target, "on", "true", true) === null, "same flag");
same((setParamOp(target, "name", "b", "a") as { value: unknown }).value, "b");
expect(setParamOp(target, "name", "a", "a") === null, "same string");

const level = { class: 2 as const, variant: "spec", runnable: true };
same(
  setLevelOp("w.json", "$root/servo", "behaviour", {
    ...level,
    chosen: false,
  }),
  {
    kind: "set-level",
    document: "w.json",
    scope: "path",
    key: "$root/servo",
    axis: "behaviour",
    class: 2,
    variant: "spec",
  }
);
expect(
  setLevelOp("w.json", "p", "behaviour", { ...level, chosen: true }) === null,
  "the chosen level"
);
expect(
  setLevelOp("w.json", "p", "behaviour", {
    ...level,
    runnable: false,
    chosen: false,
  }) === null,
  "a level that cannot run"
);

const play: WorldViewPlay = { gravity: [0, 0, -9.81], seed: 1 };
same(setPlayOp("w.json", play, { seed: 2 }), {
  kind: "set-play",
  document: "w.json",
  seed: 2,
});
expect(setPlayOp("w.json", play, { seed: 1 }) === null, "same seed");
expect(
  setPlayOp("w.json", play, { gravity: [0, 0, -9.81] }) === null,
  "same gravity"
);
expect(
  setPlayOp("w.json", play, { timestep: DEFAULT_TIMESTEP_S }) === null,
  "the default step is the step when none is named"
);
same(
  (setPlayOp("w.json", play, { timestep: 0.002 }) as { timestep: number })
    .timestep,
  0.002
);

same(renamePartOp("w.json", "arm", "  hand "), {
  kind: "rename-part",
  document: "w.json",
  to: "hand",
});
expect(renamePartOp("w.json", "arm", " arm ") === null, "same file name");
expect(renamePartOp("w.json", "arm", "   ") === null, "empty file name");

same(unwireOp({ document: "w.json", a: "uno.D9", b: "servo.signal" }), {
  kind: "unwire",
  document: "w.json",
  a: "uno.D9",
  b: "servo.signal",
});
same(removeInstanceOp(target), {
  kind: "remove-instance",
  document: target.document,
  id: "servo",
});
same(renameInstanceOp(target, "servo", " wrist "), {
  kind: "rename-instance",
  document: target.document,
  id: "servo",
  to: "wrist",
});
expect(renameInstanceOp(target, "servo", "servo") === null, "same name");
expect(renameInstanceOp(target, "servo", " ") === null, "empty name");

console.log("world-ops.selfcheck ok");
