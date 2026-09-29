import { ok as expect } from "node:assert/strict";
import type { Pose } from "@sfab-bench/contract";

import {
  editPoseField,
  fieldsToPose,
  POSE_FIELD_KEYS,
  poseToFields,
} from "./world-pose-fields";

const near = (got: number, want: number, label: string, eps = 1e-6) => {
  if (!(Math.abs(got - want) <= eps)) {
    throw new Error(`${label}: ${got} is not ${want}`);
  }
};

const uno: Pose = { position: [0.1, 0, 0.006], rotation: [1, 0, 0, 0] };
const shown = poseToFields(uno);
expect(
  shown.x === 100 && shown.y === 0 && shown.z === 6,
  "metres show as millimetres"
);
expect(
  shown.rx === 0 && shown.ry === 0 && shown.rz === 0,
  "identity shows as zero degrees"
);
expect(POSE_FIELD_KEYS.length === 6, "six fields");

// 90° about Z is a scalar-first quaternion, and reads back as 90°.
const half = Math.PI / 4;
const yawed: Pose = {
  position: [0, 0, 0],
  rotation: [Math.cos(half), 0, 0, Math.sin(half)],
};
const yawFields = poseToFields(yawed);
expect(yawFields.rz === 90 && yawFields.rx === 0, "90° about z");
const typed = editPoseField(uno, "rz", "90");
expect(typed !== null, "typing 90 changes the pose");
if (typed) {
  near(typed.rotation[0], Math.cos(half), "w");
  near(typed.rotation[3], Math.sin(half), "z");
  expect(
    typed.position.join() === uno.position.join(),
    "rotation keeps position"
  );
}

// Round trip: fields → pose → fields.
const fields = { x: 12.5, y: -30, z: 6, rx: 10, ry: -20, rz: 45 };
const round = poseToFields(fieldsToPose(fields));
for (const key of POSE_FIELD_KEYS) {
  near(round[key], fields[key], `round trip ${key}`, 1e-3);
}

// One field changes one thing.
const moved = editPoseField(uno, "x", "120");
expect(moved !== null, "typing a position changes the pose");
if (moved) {
  expect(
    moved.position.join() === "0.12,0,0.006",
    `x: ${moved.position.join()}`
  );
  expect(moved.rotation.join() === "1,0,0,0", "position keeps the quaternion");
}
const tilted: Pose = {
  position: [0, 0, 0],
  rotation: fieldsToPose({ x: 0, y: 0, z: 0, rx: 0, ry: 30, rz: 0 }).rotation,
};
const shifted = editPoseField(tilted, "z", "5");
expect(
  shifted?.rotation.join() === tilted.rotation.join(),
  "a position edit keeps a tilted quaternion byte for byte"
);

// Nothing to send.
expect(editPoseField(uno, "x", "100") === null, "the shown value is no edit");
expect(editPoseField(uno, "x", "abc") === null, "text is no edit");
expect(editPoseField(uno, "x", "") === null, "an empty field is no edit");
expect(editPoseField(uno, "rx", "0") === null, "zero degrees is no edit");
expect(editPoseField(uno, "x", "Infinity") === null, "Infinity is no edit");

console.log("world-pose-fields.selfcheck ok");
