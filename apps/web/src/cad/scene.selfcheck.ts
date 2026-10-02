import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StepAssemblyNode, StepPackage } from "@sfab-bench/contract";
import { buildStepPackage } from "@sfab-bench/server/occt";
import * as THREE from "three";

import { type ComponentMesh, decodeTess } from "@/cad/decodeTess";
import { pickAlongRay } from "@/cad/highlights";
import { buildScene } from "@/cad/loadStepPackage";
import type { CadReview } from "@/cad/review";
import { viewerSnapshot } from "@/cad/viewer-snapshot";
import { viewerStore } from "@/state/viewer";

/**
 * Tier 4a — the scene, not the package.
 *
 * `occt.corpus.selfcheck.ts` proves the triangles match the surfaces they came
 * from. Everything after that is `buildScene`: millimetres become metres, CAD
 * Z-up becomes three Y-up, and a ray becomes an `#o1.2.f7` an assistant is handed
 * and then acts on. None of that is covered by a check on the package, and all of
 * it is plain arithmetic on objects — no GPU, no canvas, no jsdom.
 *
 * Every fixture is built here rather than read from a committed package, so this
 * never asserts against a golden that could rot into agreement with a bug.
 */

const fixtures = fileURLToPath(
  new URL("../../../server/fixtures/", import.meta.url)
);
const failures: string[] = [];
const note = (why: string) => {
  failures.push(why);
  console.error(`  ✗ ${why}`);
};
const near = (got: number, want: number, eps: number) =>
  Math.abs(got - want) <= eps;

type Loaded = {
  review: CadReview;
  assembly: StepPackage;
  /** `root` under the floor offset, exactly as `scene/CadModel.tsx` mounts it. */
  world: THREE.Group;
};

/** Build a fixture and assemble it the way the viewer does. */
async function load(name: string): Promise<Loaded> {
  const dest = mkdtempSync(join(tmpdir(), "sfab-scene-"));
  try {
    await buildStepPackage(join(fixtures, `${name}.step`), dest);
    const assembly = JSON.parse(
      readFileSync(join(dest, "assembly.json"), "utf8")
    ) as StepPackage;
    const meshes = new Map<string, ComponentMesh>();
    for (const cid of new Set(
      assembly.occurrences.map((occ) => occ.component)
    )) {
      const bytes = readFileSync(join(dest, "components", `${cid}.tess`));
      meshes.set(cid, decodeTess(new Uint8Array(bytes)));
    }
    const review = buildScene(assembly, meshes);
    const world = new THREE.Group();
    world.position.y = review.sitHeight;
    world.add(review.root);
    world.updateMatrixWorld(true);
    return { review, assembly, world };
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
}

/** A ray aimed at `target` from `dir` away, far enough out to start outside anything. */
function rayFrom(target: THREE.Vector3, dir: THREE.Vector3): THREE.Ray {
  const from = target.clone().addScaledVector(dir, 1);
  return new THREE.Ray(from, dir.clone().negate());
}

/**
 * Aim points: the middle of each part that has geometry, at most this many, so
 * `many_instances` costs six rays a part rather than 720.
 */
function targets(review: CadReview): { ref: string; at: THREE.Vector3 }[] {
  const out: { ref: string; at: THREE.Vector3 }[] = [];
  for (const part of review.parts) {
    if (out.length >= 8) break;
    let meshy = false;
    part.object.traverse((child) => {
      if (child instanceof THREE.Mesh) meshy = true;
    });
    if (!meshy) continue;
    const at = new THREE.Box3()
      .setFromObject(part.object)
      .getCenter(new THREE.Vector3());
    out.push({ ref: part.cadRef ?? part.name, at });
  }
  return out;
}

const AXES: [string, THREE.Vector3][] = [
  ["+x", new THREE.Vector3(1, 0, 0)],
  ["-x", new THREE.Vector3(-1, 0, 0)],
  ["+y", new THREE.Vector3(0, 1, 0)],
  ["-y", new THREE.Vector3(0, -1, 0)],
  ["+z", new THREE.Vector3(0, 0, 1)],
  ["-z", new THREE.Vector3(0, 0, -1)],
];

// ---------------------------------------------------------------------------
// Units and up-axis
// ---------------------------------------------------------------------------

/**
 * `inch_block` is 2 x 1 x 0.5 inches, which OCCT converts to 50.8 x 25.4 x 12.7 mm
 * on the way in. In the scene that must come out as metres with CAD Z as three Y:
 * the 12.7mm thickness is the model's *height*. Get the rotation wrong and the
 * numbers are all still there, just on the wrong axes — which on a monitor reads
 * as "the model is lying down", and in VR as a wall.
 */
{
  const { review } = await load("inch_block");
  const size = review.bounds.getSize(new THREE.Vector3());
  const want: [string, number, number][] = [
    ["x (CAD X, 50.8mm)", size.x, 0.0508],
    ["y (CAD Z, 12.7mm)", size.y, 0.0127],
    ["z (CAD Y, 25.4mm)", size.z, 0.0254],
  ];
  for (const [label, got, expected] of want) {
    if (!near(got, expected, 1e-5)) {
      note(
        `inch_block: world size ${label} is ${got.toFixed(5)}m, expected ${expected}m`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The floor, every ref, and picking, across the whole corpus
// ---------------------------------------------------------------------------

// Swept, not listed: adding a STEP to fixtures/ adds a scene test, the same way it
// adds a package test on the server side.
const names = readdirSync(fixtures)
  .filter((file) => /\.(step|stp)$/i.test(file))
  .map((file) => file.replace(/\.(step|stp)$/i, ""))
  .sort();
const scenes = new Map<string, Loaded>();
for (const name of names) scenes.set(name, await load(name));

for (const [name, { review, assembly, world }] of scenes) {
  const box = new THREE.Box3().setFromObject(world);

  /**
   * `sitHeight` lifts the model onto the floor. Sunk into it is the failure that
   * matters: in VR you cannot walk round the half that is under the ground.
   */
  if (box.min.y < -1e-6) {
    note(`${name}: sits ${(-box.min.y * 1000).toFixed(2)}mm below the floor`);
  }
  // A model already clear of the floor is left where the CAD put it.
  if (review.bounds.min.y < 0 && !near(box.min.y, 0, 1e-6)) {
    note(
      `${name}: floor offset left it ${(box.min.y * 1000).toFixed(2)}mm off the ground`
    );
  }
  if (review.bounds.min.y >= 0 && review.sitHeight !== 0) {
    note(
      `${name}: raised by ${review.sitHeight}m though it was already above the floor`
    );
  }

  /**
   * A `cadRef` is a name an assistant is given and then sends back. Two parts
   * answering to one ref means `show_artifact` can highlight the wrong thing, and
   * a ref naming nothing in the package means it can highlight nothing at all.
   */
  const known = new Set<string>(assembly.occurrences.map((occ) => occ.id));
  const walk = (node: StepAssemblyNode) => {
    known.add(node.id);
    for (const child of node.children) walk(child);
  };
  if (assembly.assembly?.root) walk(assembly.assembly.root);

  const seen = new Set<string>();
  for (const part of review.parts) {
    if (!part.cadRef) {
      note(`${name}: part "${part.name}" has no cadRef`);
      continue;
    }
    if (seen.has(part.cadRef))
      note(`${name}: ${part.cadRef} names more than one part`);
    seen.add(part.cadRef);
    if (!known.has(part.cadRef.slice(1))) {
      note(`${name}: ${part.cadRef} is not in the package`);
    }
  }

  /**
   * Six rays at each part from outside. Aimed at parts rather than at the model,
   * because the middle of a bounding box is not reliably inside anything — in
   * `many_instances` it is the gap between two of the 120 placements.
   *
   * Whatever a ray hits, the ref has to be one the package can explain and the
   * surface normal has to face the ray. That last one is worth stating plainly:
   * CAD materials ship as `DoubleSide`, so a part built inside out draws exactly
   * as if it were fine, and a normal turned away from the ray is the only sign.
   */
  for (const target of targets(review)) {
    let hits = 0;
    for (const [label, dir] of AXES) {
      const pick = pickAlongRay(review, rayFrom(target.at, dir));
      if (!pick) continue;
      hits += 1;
      const ref = pick.cadRef.replace(/\.f\d+$/, "");
      if (!known.has(ref.slice(1)))
        note(
          `${name}: pick from ${label} returned ${pick.cadRef}, not in the package`
        );
      // Strictly positive, not comfortably so: a ray down a cone's axis lands on
      // its flank, where the outward normal is nearly side-on. Reversed is the bug.
      if (pick.normal.dot(dir) <= 0.01) {
        note(
          `${name}: the face picked from ${label} points away from the ray ` +
            `(${pick.normal
              .toArray()
              .map((n) => n.toFixed(2))
              .join(",")})`
        );
      }
      if (!box.containsPoint(pick.point))
        note(`${name}: pick from ${label} landed outside the model's own box`);
    }
    // A torus loses the two rays down its hole; nothing loses all six.
    if (!hits)
      note(`${name}: ${target.ref} was not picked from any of the six axes`);
  }
}

// ---------------------------------------------------------------------------
// Face refs
// ---------------------------------------------------------------------------

/**
 * A box has six faces. This is the one place the corpus can state the whole right
 * answer for a `#o….fN`, so it states it: six rays, six *different* ordinals,
 * drawn from exactly 1..6 with nothing repeated and nothing missing.
 *
 * The ordinal is what `get_viewer` hands over and what the assistant then names
 * back. If two faces collapse onto one ordinal, an agent asked to act on the top
 * of a plate can silently act on its underside.
 */
{
  const { review, world } = scenes.get("inch_block")!;
  const box = new THREE.Box3().setFromObject(world);
  const centre = box.getCenter(new THREE.Vector3());
  const ords = new Map<string, number>();
  for (const [label, dir] of AXES) {
    const pick = pickAlongRay(review, rayFrom(centre, dir));
    const ord = Number(/\.f(\d+)$/.exec(pick?.cadRef ?? "")?.[1]);
    if (!pick || !Number.isFinite(ord)) {
      note(
        `inch_block: the face from ${label} came back as ${pick?.cadRef ?? "nothing"}, with no ordinal`
      );
      continue;
    }
    ords.set(label, ord);
  }
  const distinct = new Set(ords.values());
  if (distinct.size !== 6) {
    note(
      `inch_block: six faces picked, ${distinct.size} distinct ordinals — ${[...ords].map(([k, v]) => `${k}=f${v}`).join(" ")}`
    );
  }
  for (const ord of distinct) {
    if (ord < 1 || ord > 6)
      note(`inch_block: face ordinal f${ord} is outside the 1..6 a box has`);
  }

  /**
   * One flat face, four corners of it: the same physical surface must answer to
   * the same ordinal wherever it is touched, or a ref means only "where the mouse
   * happened to be" and cannot be handed to anything.
   */
  const top = box.max.y;
  const inset = 0.2;
  const corners: [number, number][] = [
    [inset, inset],
    [1 - inset, inset],
    [inset, 1 - inset],
    [1 - inset, 1 - inset],
  ];
  const onTop = new Set<string>();
  for (const [u, v] of corners) {
    const at = new THREE.Vector3(
      THREE.MathUtils.lerp(box.min.x, box.max.x, u),
      top,
      THREE.MathUtils.lerp(box.min.z, box.max.z, v)
    );
    const pick = pickAlongRay(review, rayFrom(at, new THREE.Vector3(0, 1, 0)));
    onTop.add(pick?.cadRef ?? "nothing");
  }
  if (onTop.size !== 1) {
    note(
      `inch_block: four points on the top face gave ${onTop.size} different refs — ${[...onTop].join(", ")}`
    );
  }
}

// ---------------------------------------------------------------------------
// Colour, opacity and name, on the materials themselves
// ---------------------------------------------------------------------------

/**
 * The package's colours are checked to be in 0..1 by `checkPackage`, and
 * `occt.selfcheck.ts` checks an instance's colour beats the product's — both on
 * the JSON. Nothing has ever checked either one survives into a material.
 *
 * A swapped channel, a dropped alpha, or the `#9ca3af` default quietly standing in
 * for a colour that was there all along would pass every check we have, and would
 * look entirely plausible on screen. Reading it back off the scene costs nothing
 * and needs no renderer.
 */
for (const [name, { review, assembly }] of scenes) {
  const nodeNames = new Map<string, string>();
  const walkNames = (node: StepAssemblyNode) => {
    nodeNames.set(node.id, node.name || node.id);
    for (const child of node.children) walkNames(child);
  };
  if (assembly.assembly?.root) walkNames(assembly.assembly.root);

  const byRef = new Map(review.parts.map((part) => [part.cadRef, part]));
  for (const occ of assembly.occurrences) {
    const part = byRef.get(`#${occ.id}`);
    if (!part) {
      note(`${name}: occurrence ${occ.id} has no part in the scene`);
      continue;
    }
    const mesh = part.object.children.find(
      (child): child is THREE.Mesh => child instanceof THREE.Mesh
    );
    if (!mesh) {
      note(`${name}: ${occ.id} has no mesh under it`);
      continue;
    }
    const material = mesh.material as THREE.MeshStandardMaterial;
    // The loader's own fallback, for a solid the STEP never painted.
    const want = occ.color ?? [0.61, 0.64, 0.69, 1];
    for (const [channel, index] of [
      ["r", 0],
      ["g", 1],
      ["b", 2],
    ] as const) {
      if (!near(material.color[channel], want[index]!, 1e-4)) {
        note(
          `${name}: ${occ.id} is ${channel}=${material.color[channel].toFixed(4)} ` +
            `but the package says ${want[index]}`
        );
      }
    }
    if (!near(material.opacity, want[3]!, 1e-4)) {
      note(
        `${name}: ${occ.id} has opacity ${material.opacity}, the package says ${want[3]}`
      );
    }
    // Opaque parts must not be drawn on the transparent pass: it disables depth
    // writes and the model starts sorting wrong against itself.
    if (material.transparent !== want[3]! < 0.999) {
      note(
        `${name}: ${occ.id} is ${material.transparent ? "" : "not "}transparent at opacity ${want[3]}`
      );
    }
    const expectedName = nodeNames.get(occ.id) ?? (occ.name || occ.id);
    if (part.name !== expectedName) {
      note(
        `${name}: ${occ.id} is called "${part.name}" in the scene and "${expectedName}" in the package`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// One geometry per component
// ---------------------------------------------------------------------------

/**
 * `many_instances` is 120 placements of one solid. All 120 have to share a single
 * `BufferGeometry` — clone it per occurrence and a real assembly runs the tab out
 * of memory, which nothing else here would notice until it happened.
 */
for (const [name, { review, assembly }] of scenes) {
  const geometries = new Set<THREE.BufferGeometry>();
  review.root.traverse((child) => {
    if (child instanceof THREE.Mesh) geometries.add(child.geometry);
  });
  const components = Object.keys(assembly.components).length;
  if (geometries.size !== components) {
    note(
      `${name}: ${geometries.size} geometries in the scene for ${components} component(s)`
    );
  }
}

// ---------------------------------------------------------------------------
// What get_viewer hands over
// ---------------------------------------------------------------------------

/**
 * `viewerSnapshot()` is the tool output: the names and refs an assistant is given
 * and then asked to reason about. It reaches them through `treeTops`, a different
 * walk from the one that fills `parts`, so a node dropped or regrouped there is
 * invisible to every check above — and shows up as an assistant confidently
 * discussing a part that is not in the file.
 */
for (const [name, { review, assembly }] of scenes) {
  viewerStore.setState({
    url: `/api/pkg/${name}/`,
    review,
    selectedId: null,
    pickedRef: null,
  });
  const snapshot = viewerSnapshot();

  if (snapshot.empty) note(`${name}: the snapshot says the viewer is empty`);
  if (snapshot.partCount !== review.parts.length) {
    note(
      `${name}: the snapshot counts ${snapshot.partCount} parts, the scene has ${review.parts.length}`
    );
  }

  // The tops are the assembly root's own children, or the part itself when the
  // document is a single part with nothing under it.
  const root = assembly.assembly?.root;
  const expected = root
    ? root.children.length
      ? root.children.map((child) => `#${child.id}`)
      : [`#${root.id}`]
    : assembly.occurrences.map((occ) => `#${occ.id}`);
  const got = snapshot.tree.map((item) => item.ref ?? "(no ref)");
  if (got.join(",") !== expected.join(",")) {
    note(
      `${name}: the tree reads ${got.join(",")} but the package's top level is ${expected.join(",")}`
    );
  }
  for (const item of snapshot.tree) {
    if (!item.ref)
      note(
        `${name}: tree row "${item.name}" has no ref, so nothing can be said about it`
      );
    if (!item.name) note(`${name}: tree row ${item.ref} has no name`);
  }

  // And a selection has to come back out as the ref it went in as.
  const part = review.parts[review.parts.length - 1]!;
  viewerStore.setState({ selectedId: part.id, pickedRef: part.cadRef ?? null });
  const selected = viewerSnapshot();
  if (selected.selected !== part.cadRef) {
    note(
      `${name}: selected ${part.cadRef} but the snapshot reports ${selected.selected}`
    );
  }
  if (selected.selectedName !== part.name) {
    note(
      `${name}: selected "${part.name}" but the snapshot reports "${selected.selectedName}"`
    );
  }
}

// ---------------------------------------------------------------------------
// A ref, handed over and handed back
// ---------------------------------------------------------------------------

/**
 * The loop closing. `get_viewer` gives an assistant a ref; the assistant names it
 * back; the viewer has to land on the thing the ray hit.
 *
 * Every ref the viewer produces is a *face* ref — `viewerSnapshot` returns
 * `pickedRef` first, and picking always yields `#o1.1.f6` rather than `#o1.1`. So
 * "can a ref be used" is entirely the question of whether a face ref selects, and
 * the part-only form is the easy case that was already working.
 */
for (const [name, { review, world }] of scenes) {
  const box = new THREE.Box3().setFromObject(world);
  for (const target of targets(review)) {
    for (const [label, dir] of AXES) {
      const pick = pickAlongRay(review, rayFrom(target.at, dir));
      if (!pick) continue;

      viewerStore.setState({
        review,
        url: `/api/pkg/${name}/`,
        selectedId: null,
        pickedRef: null,
      });
      viewerStore.getState().selectByRef(pick.cadRef);
      const after = viewerStore.getState();

      if (after.selectedId === null) {
        note(
          `${name}: ${pick.cadRef} came off a ray from ${label} and selects nothing`
        );
      } else if (
        review.parts[after.selectedId]?.cadRef !==
        pick.cadRef.replace(/\.f\d+$/, "")
      ) {
        note(
          `${name}: ${pick.cadRef} selected ${review.parts[after.selectedId]?.cadRef}, ` +
            `not ${pick.cadRef.replace(/\.f\d+$/, "")}`
        );
      }
      // The full ref is what the panel shows and what goes back out again, so the
      // face must survive the trip even though selection is per part.
      if (after.pickedRef !== pick.cadRef) {
        note(
          `${name}: selecting ${pick.cadRef} left pickedRef as ${after.pickedRef}`
        );
      }
      break; // one ray per part is enough; this is about the ref, not the geometry
    }
  }
  void box;
}

/** A ref for something that is not in this model must select nothing, quietly. */
{
  const { review } = scenes.get("bracket_assembly")!;
  viewerStore.setState({
    review,
    url: "/api/pkg/x/",
    selectedId: 0,
    pickedRef: "#o1.1",
  });
  viewerStore.getState().selectByRef("#o9.9.f1");
  if (viewerStore.getState().selectedId !== null) {
    note(
      `a ref for a part that does not exist selected part ${viewerStore.getState().selectedId}`
    );
  }
  viewerStore.getState().selectByRef(null);
  if (
    viewerStore.getState().selectedId !== null ||
    viewerStore.getState().pickedRef !== null
  ) {
    note("selectByRef(null) did not clear the selection");
  }
}

// ---------------------------------------------------------------------------
// The same file twice
// ---------------------------------------------------------------------------

/**
 * Determinism of the *package* is checked server-side. This is the other half:
 * the same file, built and assembled again, has to answer the same ray with the
 * same ref. A ref that drifts between two opens of one unchanged file is a
 * conversation where the assistant and the user are looking at different faces.
 */
for (const name of ["inch_block", "bracket_assembly", "cut_solid"]) {
  const first = scenes.get(name)!;
  const again = await load(name);
  const box = new THREE.Box3().setFromObject(first.world);
  const centre = box.getCenter(new THREE.Vector3());
  for (const [label, dir] of AXES) {
    const a =
      pickAlongRay(first.review, rayFrom(centre, dir))?.cadRef ?? "nothing";
    const b =
      pickAlongRay(again.review, rayFrom(centre, dir))?.cadRef ?? "nothing";
    if (a !== b)
      note(
        `${name}: rebuilding moved the ref from ${label} — ${a} became ${b}`
      );
  }
}

if (failures.length)
  throw new Error(
    `${failures.length} scene failure(s) across ${names.length} fixtures`
  );
console.log(`scene.selfcheck ok (${names.length} fixtures)`);
