/**
 * Visual geometry on a URDF link: a mesh, or a box, cylinder, or sphere,
 * with its origin.
 *
 * Same constraints as the contract scanner: no DOM. Comments are dropped,
 * then tags are walked so an `<origin>` inside `<collision>` or `<inertial>`
 * is not the visual's. Paths are returned as written. Collision geometry
 * is ignored. A link that has both a mesh and a primitive returns both.
 */

import { attr } from "@sfab-bench/contract";

export type UrdfVec3 = [number, number, number];

type UrdfOrigin = {
  link: string;
  /** `<origin xyz>`. Metres. Missing origin is the identity. */
  xyz: UrdfVec3;
  /** `<origin rpy>` in radians: roll, pitch, yaw. Fixed axis R = Rz(yaw)·Ry(pitch)·Rx(roll). */
  rpy: UrdfVec3;
};

export type UrdfVisualMesh = UrdfOrigin & {
  kind: "mesh";
  /** Mesh filename as written, relative to the URDF. */
  filename: string;
  /** `<mesh scale>`. Missing scale is 1 1 1. */
  scale: UrdfVec3;
};

export type UrdfVisualBox = UrdfOrigin & {
  kind: "box";
  /** `<box size>`. Full edge lengths, metres. The box is centered on the origin. */
  size: UrdfVec3;
};

export type UrdfVisualCylinder = UrdfOrigin & {
  kind: "cylinder";
  /** `<cylinder radius>`. Metres. */
  radius: number;
  /** `<cylinder length>`. Metres, along the origin's +Z. */
  length: number;
};

export type UrdfVisualSphere = UrdfOrigin & {
  kind: "sphere";
  /** `<sphere radius>`. Metres. */
  radius: number;
};

export type UrdfVisual =
  | UrdfVisualMesh
  | UrdfVisualBox
  | UrdfVisualCylinder
  | UrdfVisualSphere;

const IDENTITY: UrdfVec3 = [0, 0, 0];
const UNIT: UrdfVec3 = [1, 1, 1];

function vec3(text: string | undefined, fallback: UrdfVec3): UrdfVec3 {
  if (!text) return fallback;
  const parts = text
    .trim()
    .split(/\s+/)
    .map((part) => Number(part));
  if (parts.length === 1 && Number.isFinite(parts[0])) {
    const n = parts[0] ?? 0;
    return [n, n, n];
  }
  if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  }
  return fallback;
}

function positive(text: string | undefined): number | null {
  if (!text) return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

type OpenPrimitive =
  | { shape: "box"; size: UrdfVec3 }
  | { shape: "cylinder"; radius: number; length: number }
  | { shape: "sphere"; radius: number };

type OpenVisual = {
  xyz: UrdfVec3;
  rpy: UrdfVec3;
  meshes: { filename: string; scale: UrdfVec3 }[];
  primitives: OpenPrimitive[];
};

/**
 * One entry per visual mesh or primitive. Collision geometry is ignored.
 */
export function parseUrdfVisuals(xml: string): UrdfVisual[] {
  const stripped = xml.replace(/<!--[\s\S]*?-->/g, "");
  const visuals: UrdfVisual[] = [];
  let link: string | null = null;
  let visual: OpenVisual | null = null;

  for (const tag of stripped.matchAll(
    /<(\/)?([A-Za-z][\w:.-]*)\b([^>]*?)(\/)?>/g
  )) {
    const closing = Boolean(tag[1]);
    const element = tag[2] ?? "";
    const attrs = tag[3] ?? "";
    const selfClosing = Boolean(tag[4]);

    if (closing) {
      if (element === "visual" && visual && link) {
        for (const mesh of visual.meshes) {
          visuals.push({
            kind: "mesh",
            link,
            filename: mesh.filename,
            xyz: visual.xyz,
            rpy: visual.rpy,
            scale: mesh.scale,
          });
        }
        for (const primitive of visual.primitives) {
          if (primitive.shape === "box") {
            visuals.push({
              kind: "box",
              link,
              xyz: visual.xyz,
              rpy: visual.rpy,
              size: primitive.size,
            });
          } else if (primitive.shape === "cylinder") {
            visuals.push({
              kind: "cylinder",
              link,
              xyz: visual.xyz,
              rpy: visual.rpy,
              radius: primitive.radius,
              length: primitive.length,
            });
          } else {
            visuals.push({
              kind: "sphere",
              link,
              xyz: visual.xyz,
              rpy: visual.rpy,
              radius: primitive.radius,
            });
          }
        }
      }
      if (element === "visual") visual = null;
      if (element === "link") link = null;
      continue;
    }

    if (element === "link") {
      link = attr(attrs, "name") ?? null;
    } else if (element === "visual" && link && !visual) {
      visual = { xyz: IDENTITY, rpy: IDENTITY, meshes: [], primitives: [] };
    } else if (element === "origin" && visual) {
      visual.xyz = vec3(attr(attrs, "xyz"), IDENTITY);
      visual.rpy = vec3(attr(attrs, "rpy"), IDENTITY);
    } else if (element === "mesh" && visual) {
      const filename = attr(attrs, "filename");
      if (filename) {
        visual.meshes.push({
          filename,
          scale: vec3(attr(attrs, "scale"), UNIT),
        });
      }
    } else if (element === "box" && visual) {
      const size = vec3(attr(attrs, "size"), IDENTITY);
      if (size.every((n) => n > 0)) {
        visual.primitives.push({ shape: "box", size });
      }
    } else if (element === "cylinder" && visual) {
      const radius = positive(attr(attrs, "radius"));
      const length = positive(attr(attrs, "length"));
      if (radius !== null && length !== null) {
        visual.primitives.push({ shape: "cylinder", radius, length });
      }
    } else if (element === "sphere" && visual) {
      const radius = positive(attr(attrs, "radius"));
      if (radius !== null) {
        visual.primitives.push({ shape: "sphere", radius });
      }
    }

    if (selfClosing && element === "visual") visual = null;
    if (selfClosing && element === "link") link = null;
  }

  return visuals;
}
