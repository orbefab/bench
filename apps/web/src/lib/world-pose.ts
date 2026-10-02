import type { WorldQuat, WorldVec3 } from "@sfab-bench/contract";
import * as THREE from "three";

/**
 * Worlds and STEP packages are Z-up. The viewer scene is Y-up.
 * A STEP root uses `rotation.x = -π/2` (`loadStepPackage`). A world
 * content group uses this same turn, and link positions stay in the
 * MuJoCo frame inside it: CAD +Z is three +Y, CAD +Y is three −Z.
 */
export const WORLD_TO_SCENE_X = -Math.PI / 2;

/** MuJoCo scalar-first `[w, x, y, z]` → three `Quaternion(x, y, z, w)`. */
export function worldQuatToThree(q: WorldQuat): THREE.Quaternion {
  return new THREE.Quaternion(q[1], q[2], q[3], q[0]);
}

/**
 * URDF fixed-axis rpy: `R = Rz(yaw) · Ry(pitch) · Rx(roll)`.
 * That is three Euler order `ZYX`, not the default `XYZ`.
 */
export function urdfRpyQuaternion(
  rpy: readonly [number, number, number]
): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(
    new THREE.Euler(rpy[0], rpy[1], rpy[2], "ZYX")
  );
}

/** A Z-up point written into the scene the way the world content group does. */
export function worldPointInScene(p: WorldVec3): THREE.Vector3 {
  return new THREE.Vector3(p[0], p[1], p[2]).applyAxisAngle(
    new THREE.Vector3(1, 0, 0),
    WORLD_TO_SCENE_X
  );
}
