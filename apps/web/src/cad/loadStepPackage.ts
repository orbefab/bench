import type { StepAssemblyNode, StepPackage } from "@sfab-bench/contract";
import * as THREE from "three";
import { buildBoundsTrees } from "@/cad/bvh";
import { type ComponentMesh, decodeTess } from "@/cad/decodeTess";
import {
  type CadPart,
  type CadReview,
  cssColor,
  makeReview,
} from "@/cad/review";
import { apiFetch } from "@/lib/api";

function cadMatrix(values: number[]): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  if (values.length !== 16) return m;
  m.set(
    values[0]!,
    values[1]!,
    values[2]!,
    values[3]!,
    values[4]!,
    values[5]!,
    values[6]!,
    values[7]!,
    values[8]!,
    values[9]!,
    values[10]!,
    values[11]!,
    values[12]!,
    values[13]!,
    values[14]!,
    values[15]!
  );
  return m;
}

function rgba(values: number[] | undefined): {
  color: THREE.Color;
  opacity: number;
} {
  const r = values?.[0] ?? 0.61;
  const g = values?.[1] ?? 0.64;
  const b = values?.[2] ?? 0.69;
  const a = values?.[3] ?? 1;
  return { color: new THREE.Color(r, g, b), opacity: a };
}

function geometryFromMesh(mesh: ComponentMesh): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry();
  // mesh.positions/normals/indices are already private copies (decodeTess slices the
  // source bytes per-section), so no further .slice() is needed here.
  geom.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
  geom.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
  geom.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  geom.userData.faceRanges = mesh.faceRanges;
  if (mesh.normals.length !== mesh.positions.length) {
    // Defensive: the .tess file is expected to carry normals, but fall back if not.
    geom.computeVertexNormals();
  }
  return geom;
}

/** Runs `items` through `worker` with at most `concurrency` in flight at once. */
async function mapPooled<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const runWorker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]!, index);
    }
  };
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => runWorker()
  );
  await Promise.all(workers);
  return results;
}

async function fetchPkg(pkgRoot: URL, rel: string): Promise<Response> {
  const url = new URL(rel, pkgRoot);
  const res = await apiFetch(url, { cache: "no-store" });
  if (res.ok) return res;
  const text = await res.text();
  try {
    const body = JSON.parse(text) as { error?: string };
    if (typeof body.error === "string" && body.error)
      throw new Error(body.error);
  } catch (err) {
    if (err instanceof SyntaxError) {
      /* body was not JSON */
    } else {
      throw err;
    }
  }
  throw new Error(text || `${res.status} ${url.pathname}`);
}

/**
 * Assemble a decoded package into the scene the viewer renders.
 *
 * Split out from `loadStepPackage` so it can be checked without a browser: this
 * half is pure, and everything the viewer's geometry claims — metres, up-axis,
 * `sitHeight`, and the `#o1.2.f7` refs an agent is handed — is decided here.
 */
export function buildScene(
  assembly: StepPackage,
  meshes: Map<string, ComponentMesh>
): CadReview {
  const occById = new Map(assembly.occurrences.map((occ) => [occ.id, occ]));
  const geoms = new Map<string, THREE.BufferGeometry>();
  for (const [cid, mesh] of meshes) geoms.set(cid, geometryFromMesh(mesh));

  const root = new THREE.Group();
  root.name = assembly.label || "model";
  root.userData.stepPackage = true;
  // The package is CAD millimetres, Z-up; the scene is metres, Y-up.
  root.scale.setScalar(0.001);
  root.rotation.x = -Math.PI / 2;

  const parts: CadPart[] = [];
  const build = (
    node: StepAssemblyNode,
    parent: THREE.Object3D,
    listed: boolean
  ) => {
    const group = new THREE.Group();
    group.name = node.name || node.id;
    group.userData.cadRef = `#${node.id}`;
    const occ = occById.get(node.id);
    let partColor = "#9ca3af";
    if (occ) {
      group.applyMatrix4(cadMatrix(occ.transform));
      const geom = geoms.get(occ.component);
      if (geom) {
        const { color, opacity } = rgba(occ.color);
        partColor = cssColor(color);
        const mesh = new THREE.Mesh(
          geom,
          new THREE.MeshStandardMaterial({
            color,
            metalness: 0.15,
            roughness: 0.55,
            side: THREE.DoubleSide,
            transparent: opacity < 0.999,
            opacity,
            depthWrite: opacity >= 0.999,
          })
        );
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        group.add(mesh);
      }
    }
    parent.add(group);
    if (listed) {
      parts.push({
        id: parts.length,
        name: node.name || node.id,
        color: partColor,
        object: group,
        cadRef: `#${node.id}`,
      });
    }
    for (const child of node.children) build(child, group, true);
  };

  if (assembly.assembly?.root) {
    const doc = assembly.assembly.root;
    build(doc, root, doc.children.length === 0);
  } else {
    for (const occ of assembly.occurrences) {
      build(
        {
          id: occ.id,
          name: occ.name,
          nodeType: "part",
          children: [],
          leafPartIds: [occ.id],
        },
        root,
        true
      );
    }
  }

  // Geometries are shared across occurrences; buildBoundsTrees skips ones already built.
  buildBoundsTrees(root);

  return makeReview({
    root,
    parts,
    bounds: new THREE.Box3().setFromObject(root),
  });
}

export async function loadStepPackage(
  baseUrl: string,
  onProgress?: (loaded: number, total: number) => void
): Promise<CadReview> {
  const pkgRoot = new URL(
    baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
    window.location.origin
  );
  const assembly = (await (
    await fetchPkg(pkgRoot, "assembly.json")
  ).json()) as StepPackage;
  const unique = [...new Set(assembly.occurrences.map((occ) => occ.component))];
  const meshes = new Map<string, ComponentMesh>();
  let done = 0;
  await mapPooled(unique, 8, async (cid) => {
    const buf = await (
      await fetchPkg(pkgRoot, `components/${cid}.tess`)
    ).arrayBuffer();
    meshes.set(cid, decodeTess(new Uint8Array(buf)));
    done += 1;
    onProgress?.(done, unique.length);
  });
  return buildScene(assembly, meshes);
}
