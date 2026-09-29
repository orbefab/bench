import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, join } from "node:path";

import type {
  StepAssemblyNode,
  StepOccurrence,
  StepPackage,
} from "@sfab-bench/contract";

import {
  childLabels,
  componentMatrix,
  labelColor,
  labelEntry,
  labelName,
  readStep,
  referredLabel,
} from "./document";
import { tessellate } from "./mesh";
import { encodeTess } from "./tess";
import type { Label, OpenCascade, Shape } from "./types";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Row-major 4x4 multiply: `parent` applied to `child`. */
function multiply(parent: number[], child: number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1)
        sum += parent[row * 4 + k]! * child[k * 4 + col]!;
      out[row * 4 + col] = sum;
    }
  }
  return out;
}

type LeafDefinition = { shape: Shape };

/**
 * Occurrences carry their world transform, not their parent-relative one, and only
 * leaves get an entry: the viewer builds groups from the tree and looks up an
 * occurrence per node, so a flattened leaf transform draws the same scene with
 * fewer entries.
 */
type Walk = {
  occurrences: (StepOccurrence & { definition: string })[];
  definitions: Map<string, LeafDefinition>;
};

function walkLabel(
  oc: OpenCascade,
  colorTool: Parameters<typeof labelColor>[1],
  walk: Walk,
  definition: Label,
  id: string,
  name: string,
  world: number[],
  /** Already resolved for this node: see the call sites below. */
  color: number[] | null
): StepAssemblyNode {
  const shapeTool = oc.XCAFDoc_ShapeTool;
  const isAssembly = shapeTool.IsAssembly(definition);
  const node: StepAssemblyNode = {
    id,
    name,
    nodeType: isAssembly ? "assembly" : "part",
    children: [],
    leafPartIds: [],
  };

  if (isAssembly) {
    const components = childLabels(oc, definition, (child) =>
      shapeTool.IsComponent(child)
    );
    components.forEach((component, index) => {
      const referred = referredLabel(oc, component);
      if (!referred) return;
      const childId = `${id}.${index + 1}`;
      const child = walkLabel(
        oc,
        colorTool,
        walk,
        referred,
        childId,
        labelName(oc, component) ?? labelName(oc, referred) ?? childId,
        multiply(world, componentMatrix(oc, component)),
        // The nearest assignment along the occurrence path wins: this instance
        // first, then the product it points at, then the enclosing assembly.
        // A definition painted grey that is placed as a red instance is red.
        labelColor(oc, colorTool, component) ??
          labelColor(oc, colorTool, referred) ??
          color
      );
      node.children.push(child);
      node.leafPartIds.push(...child.leafPartIds);
    });
    return node;
  }

  const entry = labelEntry(oc, definition);
  if (!walk.definitions.has(entry)) {
    walk.definitions.set(entry, { shape: shapeTool.GetShape_2(definition) });
  }
  node.leafPartIds.push(id);
  walk.occurrences.push({
    id,
    name,
    component: "",
    definition: entry,
    transform: world,
    ...(color ? { color } : {}),
  });
  return node;
}

/**
 * Drop tree nodes with nothing to draw anywhere beneath them.
 *
 * A STEP product can carry no surfaces at all — a datum axis, a centreline, a
 * branch of pure annotation — and real files are full of them: 22 of the 35 NIST
 * conformance models have at least one. Whether a definition has any faces is only
 * known after it has been tessellated, which is long after the tree was walked, so
 * this runs at the end and takes the ids that actually produced geometry.
 *
 * The node used to be left in place, which put a row in the model tree that could
 * not be picked, could not be coloured, and answered to a `#o1.2` an assistant
 * could be handed and then act on, resolving to nothing. A tree of geometry should
 * only contain geometry.
 */
function prune(
  node: StepAssemblyNode,
  drawn: Set<string>
): StepAssemblyNode | null {
  if (!node.children.length) {
    return drawn.has(node.id) ? { ...node, leafPartIds: [node.id] } : null;
  }
  const children = node.children
    .map((child) => prune(child, drawn))
    .filter((child): child is StepAssemblyNode => child !== null);
  // An assembly of nothing but annotation goes the same way its children did.
  if (!children.length) return null;
  return {
    ...node,
    children,
    leafPartIds: children.flatMap((child) => child.leafPartIds),
  };
}

function worldBounds(
  occurrences: StepOccurrence[],
  bounds: Map<string, { min: number[]; max: number[] }>
): StepPackage["bbox"] {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const occurrence of occurrences) {
    const box = bounds.get(occurrence.component);
    if (!box || !Number.isFinite(box.min[0])) continue;
    const m = occurrence.transform;
    for (let corner = 0; corner < 8; corner += 1) {
      const point = [
        corner & 1 ? box.max[0]! : box.min[0]!,
        corner & 2 ? box.max[1]! : box.min[1]!,
        corner & 4 ? box.max[2]! : box.min[2]!,
      ];
      for (let row = 0; row < 3; row += 1) {
        const value =
          m[row * 4]! * point[0]! +
          m[row * 4 + 1]! * point[1]! +
          m[row * 4 + 2]! * point[2]! +
          m[row * 4 + 3]!;
        if (value < min[row]!) min[row] = value;
        if (value > max[row]!) max[row] = value;
      }
    }
  }
  return Number.isFinite(min[0]) ? { min, max } : undefined;
}

/**
 * Compile a STEP into the view package at `dest`, on the thread that calls this.
 *
 * Reading and tessellating are both long synchronous runs inside wasm, so calling
 * this on a thread that has anything else to do stops that thing for the duration
 * — a 26MB assembly is 25 seconds. `occt/build.ts` is the entry point that gets
 * that off the server's event loop; this is what it ends up running.
 */
export async function buildPackageHere(
  stepAbs: string,
  dest: string
): Promise<void> {
  const started = Date.now();
  const document = await readStep(stepAbs);
  const { oc, shapeTool, colorTool } = document;
  try {
    const stem = basename(stepAbs).replace(/\.(step|stp)$/i, "");
    const walk: Walk = { occurrences: [], definitions: new Map() };
    const frees = childLabels(oc, shapeTool.BaseLabel(), (label) =>
      oc.XCAFDoc_ShapeTool.IsFree(label)
    );
    if (!frees.length) throw new Error("STEP has no shapes");

    let root: StepAssemblyNode;
    if (frees.length === 1) {
      const free = frees[0]!;
      root = walkLabel(
        oc,
        colorTool,
        walk,
        free,
        "o1",
        stem,
        IDENTITY,
        labelColor(oc, colorTool, free)
      );
      root.name = stem;
    } else {
      root = {
        id: "o1",
        name: stem,
        nodeType: "assembly",
        children: [],
        leafPartIds: [],
      };
      frees.forEach((free, index) => {
        const child = walkLabel(
          oc,
          colorTool,
          walk,
          free,
          `o1.${index + 1}`,
          labelName(oc, free) ?? `${stem}_${index + 1}`,
          IDENTITY,
          labelColor(oc, colorTool, free)
        );
        root.children.push(child);
        root.leafPartIds.push(...child.leafPartIds);
      });
    }

    await rm(dest, { recursive: true, force: true });
    mkdirSync(join(dest, "components"), { recursive: true });

    // Distinct definitions often tessellate to identical meshes (the same bolt placed
    // 40 times arrives as 40 STEP products). Key components by mesh content so the
    // viewer downloads and uploads one geometry.
    const components: StepPackage["components"] = {};
    const bounds = new Map<string, { min: number[]; max: number[] }>();
    const componentOf = new Map<string, string>();
    let triangles = 0;
    for (const [entry, definition] of walk.definitions) {
      const mesh = tessellate(oc, definition.shape);
      definition.shape.delete();
      if (!mesh.indices.length) continue;
      const hash = createHash("sha256");
      for (const array of [mesh.positions, mesh.indices, mesh.faceOrds]) {
        hash.update(
          Buffer.from(array.buffer, array.byteOffset, array.byteLength)
        );
      }
      const id = hash.digest("hex").slice(0, 16);
      componentOf.set(entry, id);
      if (components[id]) continue;
      components[id] = { contentHash: id };
      bounds.set(id, mesh.bounds);
      triangles += mesh.indices.length / 3;
      writeFileSync(join(dest, "components", `${id}.tess`), encodeTess(mesh));
    }

    const occurrences: StepOccurrence[] = [];
    for (const occurrence of walk.occurrences) {
      const component = componentOf.get(occurrence.definition);
      if (!component) continue; // no faces to draw: `prune` takes the tree node too
      const { definition: _definition, ...rest } = occurrence;
      occurrences.push({ ...rest, component });
    }

    const shown = prune(
      root,
      new Set(occurrences.map((occurrence) => occurrence.id))
    );
    if (!shown) throw new Error(`${basename(stepAbs)} has no surfaces to draw`);

    const pkg: StepPackage = {
      // One leaf is a part even when STEP wrapped it in a product structure.
      entryKind: shown.leafPartIds.length > 1 ? "assembly" : "part",
      units: "mm",
      label: stem,
      bbox: worldBounds(occurrences, bounds),
      assembly: { root: shown },
      occurrences,
      components,
    };
    writeFileSync(join(dest, "assembly.json"), JSON.stringify(pkg));
    const ms =
      process.env.BENCH_TIMINGS === "1" ? `, ${Date.now() - started}ms` : "";
    console.log(
      `[occt] ${basename(stepAbs)}: ${occurrences.length} occurrences, ` +
        `${Object.keys(components).length} components, ${triangles} triangles${ms}`
    );
  } finally {
    document.close();
  }
}
