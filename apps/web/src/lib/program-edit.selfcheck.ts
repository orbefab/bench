/**
 * The card's program and value-set gestures (run 7 unit 5a-1): each returns
 * the whole canonical next value, null when nothing changes or the result
 * would not parse; the card splits structured params out and lists the
 * declared-but-unset ones; one gesture is one `set-param`.
 */
import { deepEqual, equal, ok as expect } from "node:assert/strict";
import {
  type Program,
  parseProgram,
  type ValueSet,
  type WorldViewNode,
} from "@sfab-bench/contract";

import {
  addSegment,
  addValue,
  addVariant,
  defaultSegment,
  moveSegment,
  newProgram,
  newValueSet,
  previewOf,
  removeSegment,
  removeValue,
  removeVariant,
  renameVariant,
  selectValue,
  selectVariant,
  setSegmentField,
  setSegmentKind,
  setValue,
} from "./program-edit";
import { instanceCard } from "./world-card";
import { setStructuredOp } from "./world-ops";

function must<T>(value: T | null, what: string): T {
  expect(value !== null, `${what} returned null`);
  return value as T;
}

function canonical(value: Program) {
  const parsed = parseProgram(value);
  expect(parsed.ok, "a gesture result parses");
  if (parsed.ok)
    deepEqual(parsed.value, value, "a gesture result is canonical");
}

// Every default segment and the new program parse.
for (const kind of ["hold", "step", "ramp", "chirp", "prbs"] as const) {
  const program: Program = {
    kind: "program",
    use: "a",
    variants: [{ id: "a", segments: [defaultSegment(kind, 0.5)] }],
  };
  canonical(program);
}
const start = newProgram();
canonical(start);
equal(start.use, "a");

// Segments: add after, move, change kind keeping the duration, set a field.
const two = must(addSegment(start, "a", 0), "add");
equal(two.variants[0]?.segments.length, 2);
const ramped = must(setSegmentKind(two, "a", 1, "ramp"), "kind");
deepEqual(ramped.variants[0]?.segments[1], defaultSegment("ramp", 1));
equal(setSegmentKind(ramped, "a", 1, "ramp"), null, "same kind is no change");
const longer = must(setSegmentField(ramped, "a", 1, "dur", 2.5), "field");
equal(longer.variants[0]?.segments[1]?.dur, 2.5);
equal(
  setSegmentField(ramped, "a", 1, "level", 3),
  null,
  "a field the kind lacks"
);
equal(setSegmentField(ramped, "a", 1, "dur", 0), null, "zero duration fails");
equal(setSegmentField(ramped, "a", 1, "dur", -1), null, "negative fails");
equal(setSegmentField(ramped, "a", 1, "kind", 1), null, "kind is not a field");
const moved = must(moveSegment(longer, "a", 1, -1), "move up");
equal(moved.variants[0]?.segments[0]?.kind, "ramp");
equal(moveSegment(moved, "a", 0, -1), null, "the first cannot move up");
equal(moveSegment(moved, "a", 1, 1), null, "the last cannot move down");
const one = must(removeSegment(moved, "a", 0), "remove");
deepEqual(one, start);
equal(removeSegment(start, "a", 0), null, "a variant keeps one segment");
equal(addSegment(start, "zz", 0), null, "an unknown variant");
for (const value of [two, ramped, longer, moved, one]) canonical(value);

// Variants: add copies the used one and selects it; rename follows `use`.
const b = must(addVariant(longer), "add variant");
equal(b.use, "b");
deepEqual(b.variants[1]?.segments, longer.variants[0]?.segments);
const backToA = must(selectVariant(b, "a"), "select");
equal(backToA.use, "a");
equal(selectVariant(backToA, "a"), null, "selecting the used one");
equal(selectVariant(backToA, "zz"), null, "an unknown variant fails");
const renamed = must(renameVariant(b, "b", "slow"), "rename");
equal(renamed.use, "slow");
equal(renameVariant(b, "b", "a"), null, "a taken name");
equal(renameVariant(b, "b", "  "), null, "a blank name");
const dropped = must(removeVariant(renamed, "slow"), "remove variant");
equal(dropped.use, "a", "Play falls back to the first left");
equal(removeVariant(start, "a"), null, "a program keeps one variant");
const c = must(addVariant(b), "third");
equal(c.use, "c");
canonical(c);

// Value sets.
const set0 = newValueSet();
deepEqual(set0, { kind: "values", use: 0, values: [0] });
const set1 = must(addValue(set0), "add value");
deepEqual(set1.values, [0, 0]);
const set2 = must(setValue(set1, 1, 1e-6), "set value");
const set3 = must(selectValue(set2, 1), "select value");
equal(set3.use, 1);
equal(selectValue(set3, 1), null, "selecting the used one");
equal(selectValue(set3, 5), null, "out of range");
const set4 = must(removeValue(set3, 0), "remove before use");
deepEqual(set4, { kind: "values", use: 0, values: [1e-6] } satisfies ValueSet);
equal(removeValue(set4, 0), null, "a set keeps one value");
equal(setValue(set2, 0, Number.NaN), null, "not a number");

// The preview spans [0, total] and the range it samples.
const preview = previewOf(longer, "a", 7);
equal(preview.total, 3.5);
equal(preview.samples.length, 8);
equal(preview.samples[0]?.t, 0);
equal(preview.samples[7]?.t, 3.5);
equal(preview.min, 0);
equal(preview.max, 1);

// The card: structured values split out of params, declared-but-unset rows.
const node: WorldViewNode = {
  id: "rig.dyno",
  name: "dyno",
  part: "sfab/dyno@1.0.0",
  type: "dynamometer",
  role: "part",
  pose: { position: [0, 0, 0], rotation: [1, 0, 0, 0] },
  ports: [],
  params: { torque: longer, gain: 2 },
  structured: {
    torque: { kind: "program", quantity: "Torque" },
    inertia: { kind: "values", quantity: "Inertia" },
  },
  levels: [],
  children: [],
};
const card = instanceCard(node);
deepEqual(card.params, [{ name: "gain", value: 2 }]);
deepEqual(card.structured, [
  {
    name: "torque",
    decl: { kind: "program", quantity: "Torque" },
    value: longer,
  },
  {
    name: "inertia",
    decl: { kind: "values", quantity: "Inertia" },
    value: null,
  },
]);

// One gesture is one whole-value `set-param`; no change is no op.
const target = { document: "rig", id: "dyno" };
deepEqual(setStructuredOp(target, "torque", b, longer), {
  kind: "set-param",
  document: "rig",
  id: "dyno",
  name: "torque",
  value: b,
});
equal(setStructuredOp(target, "torque", null, longer), null);
equal(setStructuredOp(target, "torque", structuredClone(longer), longer), null);
deepEqual(setStructuredOp(target, "inertia", set0, null), {
  kind: "set-param",
  document: "rig",
  id: "dyno",
  name: "inertia",
  value: set0,
});

console.log("program-edit.selfcheck ok");
