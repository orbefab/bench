import { ok as expect } from "node:assert/strict";
import * as THREE from "three";

import {
  DRAG_START_PX,
  dragStarted,
  isClick,
  objectFromPose,
  pointerOnPlane,
  poseDelta,
  poseFromObject,
  rayOnPlane,
  rayPlaneZ,
  slidePose,
} from "./world-drag";
import { WORLD_TO_SCENE_X, worldPointInScene } from "./world-pose";

const near = (got: number, want: number, label: string, eps = 1e-6) => {
  if (!(Math.abs(got - want) <= eps)) {
    throw new Error(`${label}: ${got} is not ${want}`);
  }
};

const identity = poseFromObject(
  { x: 0, y: 0, z: 0 },
  { x: 0, y: 0, z: 0, w: 1 }
);
expect(
  identity.rotation.join() === "1,0,0,0" &&
    identity.position.join() === "0,0,0",
  "identity pose"
);

// 90° about Z: three (0, 0, sin, cos) is scalar-first [cos, 0, 0, sin].
const half = Math.PI / 4;
const turned = poseFromObject(
  { x: 0.1, y: -0.02, z: 0.006 },
  { x: 0, y: 0, z: Math.sin(half), w: Math.cos(half) }
);
near(turned.rotation[0], Math.cos(half), "w");
near(turned.rotation[1], 0, "x");
near(turned.rotation[2], 0, "y");
near(turned.rotation[3], Math.sin(half), "z");
expect(
  turned.position.join() === "0.1,-0.02,0.006",
  `position is kept ${turned.position.join()}`
);
const swung = new THREE.Vector3(1, 0, 0).applyQuaternion(
  objectFromPose(turned).quaternion
);
near(swung.x, 0, "swung x");
near(swung.y, 1, "swung y");

// Round trip: pose → object → pose.
const unit = new THREE.Quaternion(
  0.2705980501,
  0.1,
  0,
  0.9238795325
).normalize();
const start = {
  position: [0.1234, -0.0567, 0.006] as [number, number, number],
  rotation: [unit.w, unit.x, unit.y, unit.z] as [
    number,
    number,
    number,
    number,
  ],
};
const object = objectFromPose(start);
const back = poseFromObject(object.position, object.quaternion);
expect(back.position.join() === start.position.join(), "position round trip");
for (let i = 0; i < 4; i += 1) {
  near(back.rotation[i] ?? 0, start.rotation[i] ?? 0, `quat ${i}`, 1e-8);
}

// q and −q are one turn: the scalar stays non-negative.
const flipped = poseFromObject(
  { x: 0, y: 0, z: 0 },
  { x: 0, y: 0, z: -Math.sin(half), w: -Math.cos(half) }
);
expect(flipped.rotation[0] > 0, "the scalar is non-negative");
near(flipped.rotation[3], Math.sin(half), "flipped z");
expect(
  Object.is(
    poseFromObject({ x: -0, y: 0, z: 0 }, { x: -0, y: 0, z: 0, w: 1 })
      .position[0],
    0
  ),
  "no negative zero in a file"
);

// The stored position is in the document frame: it lands in the scene where
// the content group's Z-up turn puts it.
const content = new THREE.Group();
content.rotation.x = WORLD_TO_SCENE_X;
const child = new THREE.Group();
const placed = objectFromPose(turned);
child.position.copy(placed.position);
child.quaternion.copy(placed.quaternion);
content.add(child);
content.updateMatrixWorld(true);
const inScene = new THREE.Vector3().setFromMatrixPosition(child.matrixWorld);
const expected = worldPointInScene(turned.position);
near(inScene.x, expected.x, "scene x");
near(inScene.y, expected.y, "scene y");
near(inScene.z, expected.z, "scene z");

// A handle drag writes the proxy's local transform, and that reads back
// as the document pose whatever turn the content group has.
const proxy = new THREE.Group();
content.add(proxy);
proxy.position.set(0.02, 0.03, 0.04);
proxy.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
const read = poseFromObject(proxy.position, proxy.quaternion);
expect(read.position.join() === "0.02,0.03,0.04", "proxy position");
near(read.rotation[0], Math.cos(half), "proxy w");
near(read.rotation[3], Math.sin(half), "proxy z");

// The plain drag slides on the plane through the part.
const hit = rayPlaneZ([0, 0, 1], [0.6, 0, -0.8], 0.006);
expect(hit !== null, "a ray from above meets the plane");
if (hit) {
  near(hit[0], (0.994 / 0.8) * 0.6, "hit x");
  near(hit[2], 0.006, "hit z");
}
expect(rayPlaneZ([0, 0, 1], [1, 0, 0], 0) === null, "a level ray misses");
expect(
  rayPlaneZ([0, 0, 1], [0, 0, 1], -2) === null,
  "a plane behind is missed"
);
const slid = slidePose(
  { position: [0.1, 0, 0.006], rotation: [1, 0, 0, 0] },
  [0.1, 0, 0.006],
  [0.13, -0.02, 0.006]
);
near(slid.position[0], 0.13, "slide x");
near(slid.position[1], -0.02, "slide y");
near(slid.position[2], 0.006, "slide keeps z");
expect(slid.rotation.join() === "1,0,0,0", "a slide does not turn");
expect(!dragStarted(1, 1), "a small move is a click");
expect(dragStarted(4, 0), "four pixels is a drag");

// One threshold: under DRAG_START_PX is a click, at or over is a drag. No
// press is neither. A click test and a drag test agree at every distance.
expect(DRAG_START_PX === 4, "a drag starts at four pixels");
expect(isClick(3) && !dragStarted(3, 0), "three pixels is a click");
expect(!isClick(4) && dragStarted(4, 0), "four pixels is a drag, not a click");
expect(!isClick(5) && dragStarted(0, 5), "five pixels is a drag, not a click");
expect(isClick(0) && isClick(2), "a still press is a click");
for (const px of [0, 1, 2, 3, 3.9, 4, 4.1, 5, 12]) {
  expect(isClick(px) !== dragStarted(px, 0), `${px} px is a click or a drag`);
}

// The pointer on a plane of a frame: a camera 1 m above the origin looking
// down, in a 200 x 100 canvas. The centre is straight below the camera.
const camera = new THREE.PerspectiveCamera(90, 2, 0.01, 10);
camera.position.set(0, 0, 1);
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld(true);
const canvas = { left: 10, top: 20, width: 200, height: 100 };
const flat = new THREE.Matrix4();
const centre = pointerOnPlane(
  { clientX: 110, clientY: 70 },
  canvas,
  camera,
  flat,
  0
);
expect(centre !== null, "the pointer meets the floor");
near(centre?.[0] ?? 9, 0, "the centre is under the camera x");
near(centre?.[1] ?? 9, 0, "the centre is under the camera y");
near(centre?.[2] ?? 9, 0, "the hit is on the plane");
const right = pointerOnPlane(
  { clientX: 210, clientY: 70 },
  canvas,
  camera,
  flat,
  0
);
near(right?.[0] ?? 9, 2, "the right edge is one aspect times the height off");
const raised = pointerOnPlane(
  { clientX: 110, clientY: 70 },
  canvas,
  camera,
  flat,
  0.5
);
near(raised?.[2] ?? 9, 0.5, "a raised plane is hit at its height");
// A frame moved by (1, 2, 0): the hit is given in the frame, not the world.
const shifted = new THREE.Matrix4().makeTranslation(1, 2, 0).invert();
const inFrame = pointerOnPlane(
  { clientX: 110, clientY: 70 },
  canvas,
  camera,
  shifted,
  0
);
near(inFrame?.[0] ?? 9, -1, "the hit is in the frame: x");
near(inFrame?.[1] ?? 9, -2, "the hit is in the frame: y");
const away = pointerOnPlane(
  { clientX: 110, clientY: 70 },
  canvas,
  camera,
  flat,
  2
);
expect(away === null, "a plane behind the camera is not hit");
const ray = new THREE.Ray(
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(0, 0, -1)
);
expect(
  rayOnPlane(ray, flat, 0)?.[2] === 0,
  "a ray is projected the same way as the pointer"
);

// A robot preview moves the base from one pose to the other.
const delta = poseDelta(start, turned);
const base = objectFromPose(start);
const carried = base.position
  .clone()
  .applyQuaternion(delta.quaternion)
  .add(delta.position);
near(carried.x, turned.position[0], "delta x");
near(carried.y, turned.position[1], "delta y");
near(carried.z, turned.position[2], "delta z");
const still = poseDelta(start, start);
near(still.position.length(), 0, "no delta moves nothing");
near(still.quaternion.w, 1, "no delta turns nothing");

console.log("world-drag.selfcheck ok");
