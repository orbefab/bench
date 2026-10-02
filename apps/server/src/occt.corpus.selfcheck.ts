import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { StepPackage } from "@sfab-bench/contract";
import { buildStepPackage } from "./occt/build";
import { childLabels, labelEntry, readStep } from "./occt/document";
import { checkPackage, placedMesh } from "./occt/invariants";
import { tessellate } from "./occt/mesh";
import { meshProps, solidProps } from "./occt/solid";
import type { Label, OpenCascade, Shape } from "./occt/types";

/**
 * The whole fixture corpus, through the loader, checked two ways:
 *
 *  1. the package it wrote has to be self-consistent (`checkPackage`)
 *  2. every solid's triangles have to enclose the same volume, cover the same area
 *     and sit in the same box as the exact surfaces they came from
 *
 * Neither needs a golden file, so adding a STEP to `fixtures/` adds a test.
 */

const fixtures = fileURLToPath(new URL("../fixtures/", import.meta.url));
const failures: string[] = [];
const note = (why: string) => {
  failures.push(why);
  console.error(`  ✗ ${why}`);
};

/**
 * Tessellation is a chord approximation, so a mesh always sits slightly inside a
 * convex surface and the numbers never match exactly. These are the bands that
 * separate "approximated" from "wrong": a dropped face or a reversed winding
 * misses by tens of percent, never by tenths.
 */
const VOLUME_TOLERANCE = 0.02; // 2% — a sphere at this deflection loses about 0.1%
const AREA_TOLERANCE = 0.02;
const BBOX_TOLERANCE = 0.05; // mm, absolute: the chord gap on a curved extreme

/**
 * Fixtures whose real-world size we know, in millimetres. This is the only place
 * the corpus asserts an absolute number rather than a relation, and it exists for
 * one reason: `inch_block` declares its length unit as inches, and OCCT's reader
 * converts to millimetres on the way in. The viewer scales by a hardcoded 0.001
 * and never reads the package's `units`, so that conversion is load-bearing — if
 * it ever stopped happening, every inch-authored STEP would draw 25.4x too small.
 */
const EXPECTED_SIZE_MM: Record<string, [number, number, number]> = {
  inch_block: [50.8, 25.4, 12.7],
};

const relative = (got: number, want: number) =>
  Math.abs(want) < 1e-9 ? Math.abs(got) : Math.abs(got - want) / Math.abs(want);

/** Every leaf definition in the document, keyed by XCAF entry so each is measured once. */
function leafShapes(
  oc: OpenCascade,
  root: Label,
  into: Map<string, Shape>
): void {
  const shapeTool = oc.XCAFDoc_ShapeTool;
  if (!shapeTool.IsAssembly(root)) {
    const entry = labelEntry(oc, root);
    if (!into.has(entry)) into.set(entry, shapeTool.GetShape_2(root));
    return;
  }
  for (const component of childLabels(oc, root, (child) =>
    shapeTool.IsComponent(child)
  )) {
    const referred = new oc.TDF_Label();
    if (oc.XCAFDoc_ShapeTool.GetReferredShape(component, referred))
      leafShapes(oc, referred, into);
  }
}

/** Compare each solid's mesh against its own B-rep. */
async function compareToBrep(step: string, label: string): Promise<void> {
  const document = await readStep(step);
  const { oc, shapeTool } = document;
  try {
    const shapes = new Map<string, Shape>();
    for (const free of childLabels(oc, shapeTool.BaseLabel(), (l) =>
      oc.XCAFDoc_ShapeTool.IsFree(l)
    )) {
      leafShapes(oc, free, shapes);
    }
    if (!shapes.size) return note(`${label}: no leaf solids found`);

    for (const [entry, shape] of shapes) {
      const where = `${label} ${entry}`;
      const mesh = tessellate(oc, shape);
      // A product with no surfaces at all — a datum, a centreline, an annotation.
      // There is nothing here to compare against; that such a thing does not reach
      // the package at all is `checkPackage`'s business, not this loop's.
      if (!mesh.indices.length) {
        shape.delete();
        continue;
      }

      const exact = solidProps(oc, shape);
      const drawn = meshProps(mesh);

      // Negative means the triangles wind the other way: the solid is inside out,
      // which a DoubleSide material in the viewer would hide completely.
      if (drawn.volume < 0) {
        note(
          `${where}: mesh encloses ${drawn.volume.toFixed(2)}mm³ — winding is reversed`
        );
        continue;
      }
      // Zero is a different failure: triangles that enclose nothing, which is an
      // open shell rather than an inverted one.
      if (drawn.volume === 0) {
        note(
          `${where}: ${mesh.indices.length / 3} triangles enclose no volume — the surface is not closed`
        );
        continue;
      }
      if (relative(drawn.volume, exact.volume) > VOLUME_TOLERANCE) {
        note(
          `${where}: mesh volume ${drawn.volume.toFixed(2)}mm³ vs B-rep ${exact.volume.toFixed(2)}mm³ ` +
            `(${(relative(drawn.volume, exact.volume) * 100).toFixed(1)}% out)`
        );
      }
      if (relative(drawn.area, exact.area) > AREA_TOLERANCE) {
        note(
          `${where}: mesh area ${drawn.area.toFixed(2)}mm² vs B-rep ${exact.area.toFixed(2)}mm² ` +
            `(${(relative(drawn.area, exact.area) * 100).toFixed(1)}% out)`
        );
      }
      for (let axis = 0; axis < 3; axis += 1) {
        const gap = Math.max(
          exact.bbox!.min[axis]! - drawn.bbox!.min[axis]!,
          drawn.bbox!.max[axis]! - exact.bbox!.max[axis]!
        );
        // The mesh may sit inside the exact box; it must never stick out of it.
        if (gap > BBOX_TOLERANCE) {
          note(
            `${where}: mesh escapes the B-rep box on axis ${axis} by ${gap.toFixed(3)}mm`
          );
        }
      }
      const drift = Math.hypot(
        drawn.centroid[0] - exact.centroid[0],
        drawn.centroid[1] - exact.centroid[1],
        drawn.centroid[2] - exact.centroid[2]
      );
      const span = Math.hypot(
        exact.bbox!.max[0]! - exact.bbox!.min[0]!,
        exact.bbox!.max[1]! - exact.bbox!.min[1]!,
        exact.bbox!.max[2]! - exact.bbox!.min[2]!
      );
      if (drift > span * 0.01) {
        note(
          `${where}: mesh centre of mass is ${drift.toFixed(3)}mm from the B-rep's`
        );
      }
      shape.delete();
    }
  } finally {
    document.close();
  }
}

/**
 * The document as a whole, placed, against OCCT's own answer for it.
 *
 * `compareToBrep` measures each leaf solid in its own frame, and `checkPackage`
 * confirms the declared bbox holds the geometry — but that bbox is computed by the
 * same code that did the placing, so it only ever agrees with itself. Nothing so
 * far compares the *assembled* result to anything outside the loader.
 *
 * Which is the gap this closes. A placement multiplied in the wrong order, applied
 * at the wrong level of the tree, or dropped entirely still produces a package that
 * passes every other check in this file. `deep_nest` and `many_instances` exist for
 * exactly that failure and until now were only ever checked against themselves.
 */
async function compareAssembly(
  step: string,
  dir: string,
  label: string
): Promise<void> {
  const pkg = JSON.parse(
    readFileSync(join(dir, "assembly.json"), "utf8")
  ) as StepPackage;
  const document = await readStep(step);
  const { oc, shapeTool } = document;
  try {
    // A free label's shape carries its components' locations, so this is the whole
    // document already placed — the thing the package claims to be a copy of.
    const roots = [
      ...childLabels(oc, shapeTool.BaseLabel(), (l) =>
        oc.XCAFDoc_ShapeTool.IsFree(l)
      ),
    ];
    if (roots.length !== 1) return; // nothing in the corpus has two, and the maths below assumes one
    const shape = oc.XCAFDoc_ShapeTool.GetShape_2(roots[0]!);
    const exact = solidProps(oc, shape);
    shape.delete();

    const drawn = meshProps(placedMesh(dir, pkg));
    if (!exact.bbox || !drawn.bbox)
      return note(`${label}: the assembled document has no bounding box`);

    if (relative(drawn.volume, exact.volume) > VOLUME_TOLERANCE) {
      note(
        `${label} assembled: ${drawn.volume.toFixed(2)}mm³ across ${pkg.occurrences.length} ` +
          `occurrence(s) vs B-rep ${exact.volume.toFixed(2)}mm³ ` +
          `(${(relative(drawn.volume, exact.volume) * 100).toFixed(1)}% out)`
      );
    }
    for (let axis = 0; axis < 3; axis += 1) {
      const gap = Math.max(
        exact.bbox.min[axis]! - drawn.bbox.min[axis]!,
        drawn.bbox.max[axis]! - exact.bbox.max[axis]!
      );
      if (gap > BBOX_TOLERANCE) {
        note(
          `${label} assembled: geometry escapes the B-rep box on axis ${axis} by ${gap.toFixed(3)}mm`
        );
      }
    }
    // The sensitive one. A single instance in the wrong place barely changes a
    // bounding box and does not change the volume at all, but it always moves this.
    const drift = Math.hypot(
      drawn.centroid[0] - exact.centroid[0],
      drawn.centroid[1] - exact.centroid[1],
      drawn.centroid[2] - exact.centroid[2]
    );
    const span = Math.hypot(
      exact.bbox.max[0]! - exact.bbox.min[0]!,
      exact.bbox.max[1]! - exact.bbox.min[1]!,
      exact.bbox.max[2]! - exact.bbox.min[2]!
    );
    if (drift > span * 0.01) {
      note(
        `${label} assembled: centre of mass is ${drift.toFixed(3)}mm from the B-rep's`
      );
    }
  } finally {
    document.close();
  }
}

const steps = readdirSync(fixtures)
  .filter((f) => /\.(step|stp)$/i.test(f))
  .sort();
if (!steps.length) throw new Error(`no fixtures in ${fixtures}`);

for (const file of steps) {
  const label = file.replace(/\.step$/i, "");
  const dest = mkdtempSync(join(tmpdir(), "sfab-corpus-"));
  try {
    await buildStepPackage(join(fixtures, file), dest);
    for (const why of checkPackage(dest)) note(`${label}: ${why}`);
    await compareToBrep(join(fixtures, file), label);
    await compareAssembly(join(fixtures, file), dest, label);

    const expected = EXPECTED_SIZE_MM[label];
    if (expected) {
      const box = (
        JSON.parse(
          readFileSync(join(dest, "assembly.json"), "utf8")
        ) as StepPackage
      ).bbox;
      if (!box) note(`${label}: no bbox to measure`);
      else {
        const size = box.max.map((hi, axis) => hi - box.min[axis]!);
        for (let axis = 0; axis < 3; axis += 1) {
          if (Math.abs(size[axis]! - expected[axis]!) > 0.05) {
            note(
              `${label}: axis ${axis} is ${size[axis]!.toFixed(3)}mm, expected ${expected[axis]}mm`
            );
          }
        }
      }
    }
  } catch (err) {
    note(`${label}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
}

// Every failure is already on stderr. The runner reports this throw as the
// file's failure with its message and stack only; an uncaught throw outside
// the runner would print the current source frame, which with the wasm glue
// loaded through `new Function` is 330KB of minified emscripten.
if (failures.length) {
  throw new Error(
    `${failures.length} corpus failure(s) across ${steps.length} fixtures`
  );
}
console.log(`occt.corpus.selfcheck ok (${steps.length} fixtures)`);
