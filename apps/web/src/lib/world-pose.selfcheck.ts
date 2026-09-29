import { ok as expect } from "node:assert/strict";
import * as THREE from "three";

import {
  urdfRpyQuaternion,
  WORLD_TO_SCENE_X,
  worldPointInScene,
  worldQuatToThree,
} from "./world-pose";

const near = (got: number, want: number, eps = 1e-6) => {
  if (!(Math.abs(got - want) <= eps)) {
    throw new Error(`${got} is not ${want}`);
  }
};

const identity = worldQuatToThree([1, 0, 0, 0]);
expect(
  identity.x === 0 && identity.y === 0 && identity.z === 0,
  "identity x y z"
);
expect(identity.w === 1, "identity scalar is three w");

// 90° about MuJoCo +Z: [w, x, y, z] = [cos(θ/2), 0, 0, sin(θ/2)].
const half = Math.PI / 4;
const aboutZ = worldQuatToThree([Math.cos(half), 0, 0, Math.sin(half)]);
const swung = new THREE.Vector3(1, 0, 0).applyQuaternion(aboutZ);
near(swung.x, 0);
near(swung.y, 1);
near(swung.z, 0);

// The content group turns Z-up into the CAD viewer's Y-up scene.
expect(WORLD_TO_SCENE_X === -Math.PI / 2, "same quarter-turn as a STEP root");

const up = worldPointInScene([0, 0, 1]);
near(up.x, 0);
near(up.y, 1);
near(up.z, 0);

const cadY = worldPointInScene([0, 1, 0]);
near(cadY.x, 0);
near(cadY.y, 0);
near(cadY.z, -1);

const group = new THREE.Group();
group.rotation.x = WORLD_TO_SCENE_X;
const link = new THREE.Object3D();
link.position.set(0, 0, 0.02);
link.quaternion.copy(aboutZ);
group.add(link);
group.updateMatrixWorld(true);
const scene = link.getWorldPosition(new THREE.Vector3());
near(scene.x, 0);
near(scene.y, 0.02, 1e-6);
near(scene.z, 0);

// The Z spin, after the same parent turn, stays in the floor plane:
// MuJoCo +Y is three −Z, so +X swings toward −Z.
const localX = new THREE.Vector3(1, 0, 0).applyQuaternion(
  link.getWorldQuaternion(new THREE.Quaternion())
);
near(localX.y, 0);
near(localX.z, -1);

// URDF fixed-axis rpy is Rz(yaw)·Ry(pitch)·Rx(roll), three's "ZYX".
// 0.3 0.5 0.7 is 23.94° away from Euler order "XYZ".
{
  const roll = 0.3;
  const pitch = 0.5;
  const yaw = 0.7;
  const got = urdfRpyQuaternion([roll, pitch, yaw]);
  const rx = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0),
    roll
  );
  const ry = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    pitch
  );
  const rz = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 0, 1),
    yaw
  );
  const composed = new THREE.Quaternion().copy(rz).multiply(ry).multiply(rx);
  const phi = roll / 2;
  const the = pitch / 2;
  const psi = yaw / 2;
  const urdfdom = new THREE.Quaternion(
    Math.sin(phi) * Math.cos(the) * Math.cos(psi) -
      Math.cos(phi) * Math.sin(the) * Math.sin(psi),
    Math.cos(phi) * Math.sin(the) * Math.cos(psi) +
      Math.sin(phi) * Math.cos(the) * Math.sin(psi),
    Math.cos(phi) * Math.cos(the) * Math.sin(psi) -
      Math.sin(phi) * Math.sin(the) * Math.cos(psi),
    Math.cos(phi) * Math.cos(the) * Math.cos(psi) +
      Math.sin(phi) * Math.sin(the) * Math.sin(psi)
  );
  const xyz = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(roll, pitch, yaw, "XYZ")
  );
  for (const [label, want] of [
    ["Rz·Ry·Rx", composed],
    ["urdfdom fromRPY", urdfdom],
  ] as const) {
    const angle =
      (2 * Math.acos(Math.min(1, Math.abs(got.dot(want)))) * 180) / Math.PI;
    if (angle > 1e-4) {
      throw new Error(`${label} is ${angle}° from the helper`);
    }
  }
  const xyzOff =
    (2 * Math.acos(Math.min(1, Math.abs(got.dot(xyz)))) * 180) / Math.PI;
  if (xyzOff < 20) {
    throw new Error(`XYZ should be far from fixed-axis rpy, got ${xyzOff}°`);
  }
}

console.log("world-pose.selfcheck ok");
