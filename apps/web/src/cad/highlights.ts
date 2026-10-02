import * as THREE from "three";

import type { CadReview } from "@/cad/review";

type ColorMat =
  | THREE.MeshStandardMaterial
  | THREE.MeshPhysicalMaterial
  | THREE.MeshBasicMaterial
  | THREE.MeshPhongMaterial
  | THREE.MeshLambertMaterial;

const hasColor = (mat: THREE.Material): mat is ColorMat =>
  "color" in mat && (mat as ColorMat).color instanceof THREE.Color;

const hoverTint = new THREE.Color(0x7dd3fc);
const selectTint = new THREE.Color(0x2563eb);

type TintRec = { mat: ColorMat; orig: THREE.Color };
let tints: TintRec[] = [];

function tintMesh(mesh: THREE.Mesh, color: THREE.Color, amount: number) {
  const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const mat of list) {
    if (!hasColor(mat) || tints.some((rec) => rec.mat === mat)) continue;
    tints.push({ mat, orig: mat.color.clone() });
    mat.color.lerp(color, amount);
  }
}

export function clearHighlights() {
  for (const rec of tints) rec.mat.color.copy(rec.orig);
  tints = [];
}

function collectMeshes(root: THREE.Object3D | null): THREE.Mesh[] {
  if (!root) return [];
  const out: THREE.Mesh[] = [];
  root.traverse((child) => {
    if (child instanceof THREE.Mesh) out.push(child);
  });
  return out;
}

/**
 * Hover wins over selection, same amounts as the CAD part tint.
 * Each mesh needs its own material: the color is lerped in place.
 */
export function applyMeshHighlights(
  selected: THREE.Object3D | null,
  hovered: THREE.Object3D | null
) {
  clearHighlights();
  const hoverMeshes = new Set(collectMeshes(hovered));
  if (selected) {
    for (const mesh of collectMeshes(selected)) {
      if (!hoverMeshes.has(mesh)) tintMesh(mesh, selectTint, 0.55);
    }
  }
  for (const mesh of hoverMeshes) tintMesh(mesh, hoverTint, 0.45);
}

export function applyHighlights(
  review: CadReview,
  selectedId: number | null,
  hoveredId: number | null
) {
  const selected =
    selectedId !== null ? (review.parts[selectedId]?.object ?? null) : null;
  const hovered =
    hoveredId !== null ? (review.parts[hoveredId]?.object ?? null) : null;
  applyMeshHighlights(selected, hovered);
}

/** Nearest ancestor (or self) stamped with a `partId` by the loaders. */
function pickPartId(
  review: CadReview,
  obj: THREE.Object3D
): number | undefined {
  let cur: THREE.Object3D | null = obj;
  while (cur) {
    const id = cur.userData.partId as number | undefined;
    if (typeof id === "number" && review.parts[id]) return id;
    cur = cur.parent;
  }
}

function visibleChain(obj: THREE.Object3D): boolean {
  let cur: THREE.Object3D | null = obj;
  while (cur) {
    if (!cur.visible) return false;
    cur = cur.parent;
  }
  return true;
}

const pickRaycaster = new THREE.Raycaster();
// With BVH-accelerated raycasting we only ever use the closest hit.
pickRaycaster.firstHitOnly = true;

export type CadPick = {
  partId: number;
  cadRef: string;
  point: THREE.Vector3;
  normal: THREE.Vector3;
};

const hitNormal = new THREE.Vector3();

function faceRef(hit: THREE.Intersection, partRef: string): string {
  const mesh = hit.object;
  if (!(mesh instanceof THREE.Mesh) || hit.faceIndex == null) return partRef;
  const ranges = mesh.geometry.userData.faceRanges as
    | { ord: number; indexStart: number; indexCount: number }[]
    | undefined;
  if (!ranges?.length) return partRef;
  const tri = hit.faceIndex;
  for (const range of ranges) {
    const start = range.indexStart / 3;
    const end = (range.indexStart + range.indexCount) / 3;
    if (tri >= start && tri < end) return `${partRef}.f${range.ord}`;
  }
  return partRef;
}

function pickFromHits(
  review: CadReview,
  hits: THREE.Intersection[]
): CadPick | undefined {
  for (const hit of hits) {
    if (!visibleChain(hit.object)) continue;
    const id = pickPartId(review, hit.object);
    if (id === undefined) continue;
    const part = review.parts[id]!;
    const partRef = part.cadRef ?? part.name;
    if (hit.face) {
      hitNormal
        .copy(hit.face.normal)
        .transformDirection(hit.object.matrixWorld)
        .normalize();
    } else {
      hitNormal.set(0, 1, 0);
    }
    return {
      partId: id,
      cadRef: faceRef(hit, partRef),
      point: hit.point.clone(),
      normal: hitNormal.clone(),
    };
  }
}

/** First visible named part along the ray. Transparent meshes still count; hide them to pick through. */
export function pickAlongRay(
  review: CadReview,
  ray: THREE.Ray
): CadPick | undefined {
  pickRaycaster.ray.copy(ray);
  pickRaycaster.near = 0;
  pickRaycaster.far = 50;
  return pickFromHits(review, pickRaycaster.intersectObject(review.root, true));
}

export function pickFromIntersections(
  review: CadReview,
  hits: THREE.Intersection[]
): CadPick | undefined {
  return pickFromHits(review, hits);
}
