/** Capture recipe lookup: part-document recipe, catalog fallback, and the `into` level. */
import { deepStrictEqual, ok as expect } from "node:assert/strict";
import path from "node:path";

import type { CaptureRecipe, PartFile } from "@sfab-bench/contract";
import { PART_FORMAT } from "@sfab-bench/contract";
import { loadPartById } from "@sfab-bench/parts";
import {
  captureLevelFor,
  captureRecipeFor,
} from "@sfab-bench/sim/capture-recipe";

import { nodeStore } from "./world/node-store";
import { catalogRoot } from "./world/plan-host";

const source = {
  catalogDir: catalogRoot(),
  store: nodeStore,
  join: path.join,
};

function catalogPart(id: string): PartFile {
  const loaded = loadPartById(
    catalogRoot(),
    { catalogDir: catalogRoot(), store: nodeStore, assetRoot: catalogRoot() },
    id
  );
  expect("part" in loaded, `catalog part ${id}`);
  return (loaded as { part: PartFile }).part;
}

const nano = catalogPart("sfab/nano-power-input@1.0.0");
const catalogRecipe = captureRecipeFor(nano, "behaviour", source);
expect(catalogRecipe, "catalog-only part has a recipe");
deepStrictEqual(catalogRecipe?.variant, "netlist");
deepStrictEqual(catalogRecipe?.instance, "power");
deepStrictEqual(captureRecipeFor(nano, "body", source), null);

const sg90 = catalogPart("sfab/sg90@1.0.0");
const hinge = captureRecipeFor(sg90, "body", source);
expect(hinge, "the hinge entry is the body recipe of its part");
deepStrictEqual((hinge as { form?: string }).form, "hinge@1");
deepStrictEqual(captureRecipeFor(sg90, "behaviour", source), null);

const led = catalogPart("sfab/led-module-red@1.0.0");
expect(captureRecipeFor(led, "behaviour", source), "led module recipe");

const bare: PartFile = {
  format: PART_FORMAT,
  id: "sfab/no-recipe@1.0.0",
  type: "power-input",
};
deepStrictEqual(captureRecipeFor(bare, "behaviour", source), null);

const own: CaptureRecipe = {
  variant: "netlist",
  instance: "power",
  through: "VBUS",
  iSense: 1,
  fitV: 0.01,
  baseline: { level: "2", value: 0 },
  heldOut: "fixture",
  sweep: { fixture: "sfab/nano-power-input" },
  envelope: {},
};
const shadow: PartFile = { ...nano, capture: { behaviour: own } };
const winner = captureRecipeFor(shadow, "behaviour", source);
deepStrictEqual(winner?.fitV, 0.01);
deepStrictEqual(winner?.id, nano.id);
deepStrictEqual(winner?.part, nano.id);

const into = captureLevelFor(nano, "behaviour", {});
deepStrictEqual(into, { level: "1" });
deepStrictEqual(captureLevelFor(nano, "behaviour", { into: "2" }), {
  level: "2",
});
const missingSlot = captureLevelFor(nano, "behaviour", { into: "3" });
expect("error" in missingSlot, "into names a level the part lacks");
const none = captureLevelFor(bare, "behaviour", {});
expect("error" in none && /into/.test(none.error), "no snapshot level refuses");

console.log(
  `capture recipe: catalog ${catalogRecipe?.id}, hinge ${hinge?.id}, part document wins, into ${JSON.stringify(into)}, no snapshot level refused`
);
