import type { Pose, WorldVec3 } from "@sfab-bench/contract";
import * as THREE from "three";

import { worldQuatToThree } from "@/lib/world-pose";

/**
 * A dragged object's pose as the document stores it.
 *
 * The world content group carries the Z-up → Y-up turn (`WORLD_TO_SCENE_X`).
 * An object inside it has a local transform that is already in the
 * document frame, and TransformControls writes that local transform
 * whatever the parent turn is. So the conversion here is only the
 * quaternion order: three is `(x, y, z, w)`, a pose is scalar-first
 * `[w, x, y, z]`. Reading a scene-frame transform instead would put the
 * turn in twice.
 */

/** 0.01 mm. A drag ends on a float; a file should not keep one. */
const POSITION_STEP = 1e-5;
const QUAT_DIGITS = 1e9;

function clean(n: number): number {
  return Object.is(n, -0) ? 0 : n;
}

export function poseFromObject(
  position: { x: number; y: number; z: number },
  quaternion: { x: number; y: number; z: number; w: number }
): Pose {
  const q = new THREE.Quaternion(
    quaternion.x,
    quaternion.y,
    quaternion.z,
    quaternion.w
  ).normalize();
  // q and −q are one turn. Keep the scalar non-negative so a file is stable.
  const sign = q.w < 0 ? -1 : 1;
  const round = (n: number) =>
    clean(Math.round(sign * n * QUAT_DIGITS) / QUAT_DIGITS);
  const step = (n: number) =>
    clean(Math.round(n / POSITION_STEP) * POSITION_STEP);
  return {
    position: [
      Number(step(position.x).toFixed(5)),
      Number(step(position.y).toFixed(5)),
      Number(step(position.z).toFixed(5)),
    ],
    rotation: [round(q.w), round(q.x), round(q.y), round(q.z)],
  };
}

export function objectFromPose(pose: Pose): {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
} {
  return {
    position: new THREE.Vector3(...pose.position),
    quaternion: worldQuatToThree(pose.rotation),
  };
}

/** Where a ray meets the horizontal plane `z` of the document, or null. */
export function rayPlaneZ(
  origin: WorldVec3,
  direction: WorldVec3,
  z: number
): WorldVec3 | null {
  if (Math.abs(direction[2]) < 0.05) return null;
  const t = (z - origin[2]) / direction[2];
  if (t < 0) return null;
  return [origin[0] + direction[0] * t, origin[1] + direction[1] * t, z];
}

/** A plain drag slides the part along the plane. It never turns it. */
export function slidePose(pose: Pose, from: WorldVec3, to: WorldVec3): Pose {
  const step = (n: number) =>
    clean(Number((Math.round(n / POSITION_STEP) * POSITION_STEP).toFixed(5)));
  return {
    position: [
      step(pose.position[0] + (to[0] - from[0])),
      step(pose.position[1] + (to[1] - from[1])),
      pose.position[2],
    ],
    rotation: pose.rotation,
  };
}

/**
 * The transform that takes a robot's base from `from` to `to`. A robot's
 * link poses come from the run in the document frame, so a preview moves
 * the whole robot by this delta instead of editing any link.
 */
export function poseDelta(
  from: Pose,
  to: Pose
): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
  const a = objectFromPose(from);
  const b = objectFromPose(to);
  const quaternion = b.quaternion
    .clone()
    .multiply(a.quaternion.clone().invert());
  const position = b.position
    .clone()
    .sub(a.position.clone().applyQuaternion(quaternion));
  return { position, quaternion };
}

/** A slide under this many pixels is a click. */
export const DRAG_START_PX = 4;

export function dragStarted(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) >= DRAG_START_PX;
}
