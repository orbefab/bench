/**
 * The card's numeric pose fields. A pose is stored in SI: metres and a
 * scalar-first quaternion. The card shows millimetres and degrees. The
 * three angles are turns about the fixed x, y and z axes, applied x then
 * y then z (`R = Rz · Ry · Rx`, the same order as a URDF rpy).
 */

import type { Pose } from "@sfab-bench/contract";
import * as THREE from "three";

import { poseFromObject } from "@/lib/world-drag";
import { worldQuatToThree } from "@/lib/world-pose";

export type PoseFieldKey = "x" | "y" | "z" | "rx" | "ry" | "rz";

export const POSE_FIELD_KEYS: readonly PoseFieldKey[] = [
  "x",
  "y",
  "z",
  "rx",
  "ry",
  "rz",
];

export type PoseFields = Record<PoseFieldKey, number>;

const MM = 1000;
const DEG = 180 / Math.PI;
/** Shown to a thousandth of a millimetre or degree. */
const SHOWN = 1000;

function shown(n: number): number {
  const r = Math.round(n * SHOWN) / SHOWN;
  return Object.is(r, -0) ? 0 : r;
}

export function poseToFields(pose: Pose): PoseFields {
  const euler = new THREE.Euler().setFromQuaternion(
    worldQuatToThree(pose.rotation),
    "ZYX"
  );
  return {
    x: shown(pose.position[0] * MM),
    y: shown(pose.position[1] * MM),
    z: shown(pose.position[2] * MM),
    rx: shown(euler.x * DEG),
    ry: shown(euler.y * DEG),
    rz: shown(euler.z * DEG),
  };
}

export function fieldsToPose(fields: PoseFields): Pose {
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(fields.rx / DEG, fields.ry / DEG, fields.rz / DEG, "ZYX")
  );
  return poseFromObject(
    { x: fields.x / MM, y: fields.y / MM, z: fields.z / MM },
    q
  );
}

/**
 * The pose after one field is typed. Null when the text is not a number
 * or is what the card already shows. Only that field changes: a position
 * keeps the stored quaternion exactly, and a rotation keeps the position.
 */
export function editPoseField(
  pose: Pose,
  key: PoseFieldKey,
  raw: string
): Pose | null {
  const text = raw.trim();
  if (text === "") return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  const fields = poseToFields(pose);
  if (shown(value) === fields[key]) return null;
  if (key === "x" || key === "y" || key === "z") {
    const index = key === "x" ? 0 : key === "y" ? 1 : 2;
    const position: Pose["position"] = [...pose.position];
    position[index] = Number((value / MM).toFixed(6));
    return { position, rotation: [...pose.rotation] };
  }
  const next = fieldsToPose({ ...fields, [key]: value });
  return { position: [...pose.position], rotation: next.rotation };
}
