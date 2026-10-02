import * as THREE from "three";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { buildBoundsTrees } from "@/cad/bvh";
import { loadStepPackage } from "@/cad/loadStepPackage";
import {
  type CadPart,
  type CadReview,
  cssColor,
  makeReview,
} from "@/cad/review";
import { apiFetch } from "@/lib/api";
import { readOpenDocument } from "@/lib/document-query";
import { messageFromHttpBody } from "@/lib/load-copy";

function partColor(obj: THREE.Object3D): THREE.Color {
  let found = new THREE.Color(0x888888);
  obj.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      const mat = Array.isArray(child.material)
        ? child.material[0]
        : child.material;
      if (mat && "color" in mat && mat.color instanceof THREE.Color)
        found = mat.color;
    }
  });
  return found;
}

function cadPkgBase(rel: string): string {
  const path = rel
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter((s) => s && s !== ".")
    .map(encodeURIComponent)
    .join("/");
  return `/api/cad-pkg/${path}/`;
}

/** Project-relative STEP → on-demand tessellated package. */
export function repoCadPath(url: string): string | null {
  const path = url.split("?")[0]?.replace(/\\/g, "/") ?? "";
  if (/\.(step|stp)$/i.test(path)) {
    return path.replace(/^\/+/, "");
  }
  return null;
}

export function projectFileUrl(rel: string): string {
  const path = rel
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter((s) => s && s !== ".")
    .map(encodeURIComponent)
    .join("/");
  return `/api/files/${path}`;
}

export async function loadCadReview(
  url: string,
  onProgress?: (loaded: number, total: number) => void
): Promise<CadReview> {
  const repo = repoCadPath(url);
  if (repo) return loadStepPackage(cadPkgBase(repo), onProgress);
  const glbRel = url.replace(/^\/+/, "");
  if (!/\.(glb|gltf)$/i.test(glbRel)) {
    throw new Error("Not a STEP or GLB file");
  }
  const objectUrl = await (async () => {
    const res = await apiFetch(projectFileUrl(glbRel), { cache: "no-store" });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        messageFromHttpBody(text, res.statusText || "Could not load this file")
      );
    }
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  })();
  try {
    const gltf = await new Promise<
      Awaited<ReturnType<GLTFLoader["loadAsync"]>>
    >((resolve, reject) => {
      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      loader.load(
        objectUrl,
        resolve,
        (ev) => {
          if (ev.total) onProgress?.(ev.loaded, ev.total);
        },
        reject
      );
    });
    const root = new THREE.Group();
    root.name = "model";
    root.add(gltf.scene);

    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const maxSpan = Math.max(size.x, size.y, size.z);
    if (maxSpan > 2) {
      gltf.scene.scale.setScalar(0.001);
      box.setFromObject(root);
    }

    gltf.scene.updateWorldMatrix(true, true);
    gltf.scene.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.computeVertexNormals();
        // GLTFLoader shares one material object across many meshes, so tinting one
        // part would tint every part sharing it. Give each mesh its own copy.
        // Nothing is disposed: the originals stay owned by the loader cache.
        child.material = Array.isArray(child.material)
          ? child.material.map((mat) => mat.clone())
          : child.material.clone();
        const mats = Array.isArray(child.material)
          ? child.material
          : [child.material];
        for (const mat of mats) {
          // Winding was verified outward by signed volume on the raw export
          // (381/381 meshes positive, none near-zero or negative), so opaque
          // parts can safely cull back faces; only the transparent shell needs
          // both sides rendered.
          mat.side = mat.transparent ? THREE.DoubleSide : THREE.FrontSide;
          mat.needsUpdate = true;
        }
      }
    });
    buildBoundsTrees(root);

    const namedGroups: THREE.Object3D[] = [];
    root.traverse((obj) => {
      if (obj === root || !obj.name) return;
      if (obj.children.length > 0 || obj instanceof THREE.Mesh)
        namedGroups.push(obj);
    });
    const parts: CadPart[] = namedGroups
      .filter((obj) => {
        const parent = obj.parent;
        return !(
          parent &&
          parent !== root &&
          parent.children.length === 1 &&
          parent.name === obj.name
        );
      })
      .map((obj, id) => ({
        id,
        name: obj.name,
        color: cssColor(partColor(obj)),
        object: obj,
      }));

    return makeReview({ root, parts, bounds: box });
  } finally {
    if (objectUrl.startsWith("blob:")) URL.revokeObjectURL(objectUrl);
  }
}

export function fileLabel(url: string): string {
  const path = url.split("?")[0]?.replace(/\\/g, "/") ?? "";
  const name = path.split("/").filter(Boolean).pop();
  if (!name) return "No model";
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

export function modelUrl(): string {
  if (typeof window === "undefined") return "";
  const doc = readOpenDocument(window.location.search);
  return doc.kind === "file" ? doc.path : "";
}
