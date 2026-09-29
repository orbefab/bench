import { ok as expect } from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { StepPackage } from "@sfab-bench/contract";
import { buildStepPackage } from "./occt/build";
import { checkPackage } from "./occt/invariants";

/**
 * What `bracket_assembly.step` in particular has to come back as.
 *
 * The invariants that hold for *any* STEP live in `occt/invariants.ts` and run over
 * the whole corpus in `occt.corpus.selfcheck.ts`. What is left here is the part that
 * needs a file whose right answer we know: the tree we built, the names we wrote,
 * the colours we assigned and where we placed things.
 */

const fixture = fileURLToPath(
  new URL("../fixtures/bracket_assembly.step", import.meta.url)
);
const dest = mkdtempSync(join(tmpdir(), "sfab-occt-"));

// Twice, into the same directory, through the same worker: the kernel behind it is
// a long-lived wasm instance shared by every open, so a build that corrupts or
// half-frees its document shows up as the second one differing from the first — or
// as a hang, or as the thread dying.
await buildStepPackage(fixture, dest);
const first = readFileSync(join(dest, "assembly.json"), "utf8");
await buildStepPackage(fixture, dest);
const second = readFileSync(join(dest, "assembly.json"), "utf8");
expect(
  first === second,
  "a second build in the same process gives the same package"
);

const problems = checkPackage(dest);
expect(!problems.length, `package invariants: ${problems.join("; ")}`);

const pkg = JSON.parse(second) as StepPackage;
expect(pkg.label === "bracket_assembly", "label comes from the file stem");

const root = pkg.assembly?.root;
expect(root, "package has an assembly root");
expect(
  root!.children.length === 2,
  "root has the plate and the post sub-assembly"
);
expect(root!.leafPartIds.length === 3, "root lists every leaf part below it");

const pair = root!.children.find((child) => child.name === "posts");
expect(pair, "the sub-assembly survives as its own node");
expect(pair!.nodeType === "assembly", "a node with components is an assembly");
expect(
  pair!.children
    .map((child) => child.name)
    .sort()
    .join(",") === "post_left,post_right",
  "component names survive the round trip"
);
const plateNode = root!.children.find((child) => child.name === "plate_1");
expect(
  plateNode?.nodeType === "part",
  "a node with geometry and no components is a part"
);

expect(pkg.occurrences.length === 3, "one occurrence per leaf");
for (const occ of pkg.occurrences)
  expect(occ.color?.length === 4, `${occ.id} kept its colour`);

// The two posts are the same solid placed twice: one component, two occurrences.
expect(
  Object.keys(pkg.components).length === 2,
  "identical geometry collapses to one component"
);
const posts = pkg.occurrences.filter((occ) => occ.name.startsWith("post_"));
expect(
  posts.length === 2 && posts[0]!.component === posts[1]!.component,
  "both posts share geometry"
);

const left = posts.find((occ) => occ.name === "post_left")!;
const right = posts.find((occ) => occ.name === "post_right")!;
// Placed at (0,0,0) and (36,16,0) inside a sub-assembly that sits at (12,12,6).
expect(
  Math.abs(left.transform[3]! - 12) < 1e-3,
  "a leaf transform is flattened to world"
);
expect(Math.abs(right.transform[3]! - 48) < 1e-3, "and so is its sibling");
expect(
  Math.abs(left.transform[11]! - 6) < 1e-3,
  "the sub-assembly's own lift is included"
);

// post_left is painted on the instance, post_right inherits the product's orange.
expect(
  Math.abs(left.color![1]! - 0.7) < 0.02,
  "an instance colour beats the product's own"
);
expect(
  Math.abs(right.color![0]! - 0.85) < 0.02,
  "an unpainted instance keeps the product colour"
);

const plate = pkg.occurrences.find((occ) => occ.name === "plate_1");
expect(
  plate && plate.component !== posts[0]!.component,
  "plate is its own component"
);

const bbox = pkg.bbox;
expect(bbox, "package has a bounding box");
expect(
  Math.abs(bbox!.min[0]) < 0.1 && Math.abs(bbox!.max[0] - 60) < 0.5,
  "bbox spans the 60mm plate"
);

expect(
  readdirSync(join(dest, "components")).filter((f) => f.endsWith(".tess"))
    .length === 2,
  "one .tess per component"
);

rmSync(dest, { recursive: true, force: true });
console.log("occt.selfcheck ok");
