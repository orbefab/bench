import { useFrame, useThree } from "@react-three/fiber";
import { useXRInputSourceState } from "@react-three/xr";
import { useEffect, useMemo } from "react";
import * as THREE from "three";

import { xrUiStore } from "@/state/xr";

const JOINTS: XRHandJoint[] = [
  "wrist",
  "thumb-metacarpal",
  "thumb-phalanx-proximal",
  "thumb-phalanx-distal",
  "thumb-tip",
  "index-finger-metacarpal",
  "index-finger-phalanx-proximal",
  "index-finger-phalanx-intermediate",
  "index-finger-phalanx-distal",
  "index-finger-tip",
  "middle-finger-metacarpal",
  "middle-finger-phalanx-proximal",
  "middle-finger-phalanx-intermediate",
  "middle-finger-phalanx-distal",
  "middle-finger-tip",
  "ring-finger-metacarpal",
  "ring-finger-phalanx-proximal",
  "ring-finger-phalanx-intermediate",
  "ring-finger-phalanx-distal",
  "ring-finger-tip",
  "pinky-finger-metacarpal",
  "pinky-finger-phalanx-proximal",
  "pinky-finger-phalanx-intermediate",
  "pinky-finger-phalanx-distal",
  "pinky-finger-tip",
];

const BONES: [XRHandJoint, XRHandJoint][] = [
  ["wrist", "thumb-metacarpal"],
  ["thumb-metacarpal", "thumb-phalanx-proximal"],
  ["thumb-phalanx-proximal", "thumb-phalanx-distal"],
  ["thumb-phalanx-distal", "thumb-tip"],
  ["wrist", "index-finger-metacarpal"],
  ["index-finger-metacarpal", "index-finger-phalanx-proximal"],
  ["index-finger-phalanx-proximal", "index-finger-phalanx-intermediate"],
  ["index-finger-phalanx-intermediate", "index-finger-phalanx-distal"],
  ["index-finger-phalanx-distal", "index-finger-tip"],
  ["wrist", "middle-finger-metacarpal"],
  ["middle-finger-metacarpal", "middle-finger-phalanx-proximal"],
  ["middle-finger-phalanx-proximal", "middle-finger-phalanx-intermediate"],
  ["middle-finger-phalanx-intermediate", "middle-finger-phalanx-distal"],
  ["middle-finger-phalanx-distal", "middle-finger-tip"],
  ["wrist", "ring-finger-metacarpal"],
  ["ring-finger-metacarpal", "ring-finger-phalanx-proximal"],
  ["ring-finger-phalanx-proximal", "ring-finger-phalanx-intermediate"],
  ["ring-finger-phalanx-intermediate", "ring-finger-phalanx-distal"],
  ["ring-finger-phalanx-distal", "ring-finger-tip"],
  ["wrist", "pinky-finger-metacarpal"],
  ["pinky-finger-metacarpal", "pinky-finger-phalanx-proximal"],
  ["pinky-finger-phalanx-proximal", "pinky-finger-phalanx-intermediate"],
  ["pinky-finger-phalanx-intermediate", "pinky-finger-phalanx-distal"],
  ["pinky-finger-phalanx-distal", "pinky-finger-tip"],
];

const JOINT_COUNT = JOINTS.length;
const JOINT_INDEX = new Map(JOINTS.map((name, i) => [name, i]));
/** Flat `[jointIndex, jointIndex, …]` — one pair per bone, 48 line vertices. */
const BONE_INDEX = new Uint8Array(BONES.length * 2);
BONES.forEach(([from, to], i) => {
  BONE_INDEX[i * 2] = JOINT_INDEX.get(from)!;
  BONE_INDEX[i * 2 + 1] = JOINT_INDEX.get(to)!;
});

const IDLE_COLOR = "#a1a1aa";
const READY_COLOR = "#f97316";
const HOLD_COLOR = "#22d3ee";

const tmpA = new THREE.Vector3();
const tmpRight = new THREE.Vector3();
const tmpMatrix = new THREE.Matrix4();
const ZERO_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);

/** `XRFrame.fillPoses` is not in `@types/webxr`; it is optional at runtime. */
type PoseFillingFrame = XRFrame & {
  fillPoses?: (
    spaces: Iterable<XRSpace>,
    baseSpace: XRSpace,
    transforms: Float32Array
  ) => boolean;
};

function iconTexture(kind: "move" | "zoom", fill: string, stroke: string) {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const g = c.getContext("2d")!;
  g.beginPath();
  g.arc(64, 64, 58, 0, Math.PI * 2);
  g.fillStyle = fill;
  g.fill();
  g.strokeStyle = stroke;
  g.lineWidth = 7;
  g.lineCap = "round";
  g.lineJoin = "round";
  const head = (x: number, y: number, dx: number, dy: number) => {
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    g.beginPath();
    g.moveTo(x - dx * 11 + -dy * 8, y - dy * 11 + dx * 8);
    g.lineTo(x, y);
    g.lineTo(x - dx * 11 - -dy * 8, y - dy * 11 - dx * 8);
    g.stroke();
  };
  if (kind === "move") {
    g.beginPath();
    g.moveTo(64, 26);
    g.lineTo(64, 102);
    g.moveTo(26, 64);
    g.lineTo(102, 64);
    g.stroke();
    head(64, 26, 0, -1);
    head(64, 102, 0, 1);
    head(26, 64, -1, 0);
    head(102, 64, 1, 0);
  } else {
    g.beginPath();
    g.moveTo(38, 90);
    g.lineTo(90, 38);
    g.stroke();
    head(90, 38, 1, -1);
    head(38, 90, -1, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const badgeMaterial = (kind: "move" | "zoom", fill: string) =>
  new THREE.SpriteMaterial({
    map: iconTexture(kind, fill, "#18181b"),
    transparent: true,
    depthTest: false,
  });

// Four shared sprite materials: move/zoom × ready/hold.
const moveReadyMat = badgeMaterial("move", "#fafafa");
const zoomReadyMat = badgeMaterial("zoom", "#fafafa");
const moveHoldMat = badgeMaterial("move", "#a1a1aa");
const zoomHoldMat = badgeMaterial("zoom", "#a1a1aa");

type Rig = {
  group: THREE.Group;
  joints: THREE.InstancedMesh;
  jointGeometry: THREE.SphereGeometry;
  jointMaterial: THREE.MeshBasicMaterial;
  bones: THREE.LineSegments;
  boneGeometry: THREE.BufferGeometry;
  boneMaterial: THREE.LineBasicMaterial;
  badge: THREE.Sprite;
  /** World position per joint, kept between frames so an untracked joint keeps its last bone. */
  positions: Float32Array;
  tracked: Uint8Array;
  /** `fillPoses` scratch: 16 floats per joint. */
  matrices: Float32Array;
  hand: XRHand | null;
  spaces: XRSpace[] | null;
  color: string;
};

function createRig(): Rig {
  const jointGeometry = new THREE.SphereGeometry(0.006, 8, 8);
  const jointMaterial = new THREE.MeshBasicMaterial({ color: IDLE_COLOR });
  const joints = new THREE.InstancedMesh(
    jointGeometry,
    jointMaterial,
    JOINT_COUNT
  );
  joints.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  joints.frustumCulled = false;
  joints.raycast = () => {};
  // Nothing is drawn until the first pose arrives.
  for (let i = 0; i < JOINT_COUNT; i++) joints.setMatrixAt(i, ZERO_MATRIX);

  const boneGeometry = new THREE.BufferGeometry();
  boneGeometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(BONE_INDEX.length * 3), 3)
  );
  const boneMaterial = new THREE.LineBasicMaterial({ color: IDLE_COLOR });
  const bones = new THREE.LineSegments(boneGeometry, boneMaterial);
  bones.frustumCulled = false;
  bones.raycast = () => {};

  const badge = new THREE.Sprite(moveReadyMat);
  badge.scale.set(0.036, 0.036, 1);
  badge.renderOrder = 20;
  badge.frustumCulled = false;
  badge.raycast = () => {};
  badge.visible = false;

  // World space: the group stays at the origin and joint poses are written raw.
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  group.add(joints, bones, badge);

  return {
    group,
    joints,
    jointGeometry,
    jointMaterial,
    bones,
    boneGeometry,
    boneMaterial,
    badge,
    positions: new Float32Array(JOINT_COUNT * 3),
    tracked: new Uint8Array(JOINT_COUNT),
    matrices: new Float32Array(JOINT_COUNT * 16),
    hand: null,
    spaces: null,
    color: IDLE_COLOR,
  };
}

function disposeRig(rig: Rig) {
  rig.group.clear();
  rig.jointGeometry.dispose();
  rig.jointMaterial.dispose();
  rig.boneGeometry.dispose();
  rig.boneMaterial.dispose();
  rig.joints.dispose();
}

/** Joint spaces in `JOINTS` order, cached per hand. `null` while any is missing. */
function jointSpaces(rig: Rig, hand: XRHand) {
  if (rig.hand === hand) return rig.spaces;
  rig.hand = hand;
  const spaces: XRSpace[] = [];
  for (const name of JOINTS) {
    const space = hand.get(name);
    if (!space) {
      rig.spaces = null;
      return null;
    }
    spaces.push(space);
  }
  rig.spaces = spaces;
  return spaces;
}

/** Fills `rig.positions` / `rig.tracked`; returns true if any joint was posed. */
function readPoses(
  frame: XRFrame,
  refSpace: XRSpace,
  spaces: XRSpace[],
  rig: Rig
) {
  const { positions, tracked, matrices } = rig;
  const fillPoses = (frame as PoseFillingFrame).fillPoses;
  if (fillPoses && fillPoses.call(frame, spaces, refSpace, matrices)) {
    for (let i = 0; i < JOINT_COUNT; i++) {
      positions[i * 3] = matrices[i * 16 + 12]!;
      positions[i * 3 + 1] = matrices[i * 16 + 13]!;
      positions[i * 3 + 2] = matrices[i * 16 + 14]!;
      tracked[i] = 1;
    }
    return true;
  }
  let any = false;
  for (let i = 0; i < JOINT_COUNT; i++) {
    // `getPose` is the fallback the old per-joint XRSpace used.
    const pose =
      frame.getJointPose?.(spaces[i] as XRJointSpace, refSpace) ??
      frame.getPose(spaces[i]!, refSpace);
    if (!pose) {
      tracked[i] = 0;
      continue;
    }
    const p = pose.transform.position;
    positions[i * 3] = p.x;
    positions[i * 3 + 1] = p.y;
    positions[i * 3 + 2] = p.z;
    tracked[i] = 1;
    any = true;
  }
  return any;
}

function OneHand({ handedness }: { handedness: "left" | "right" }) {
  const state = useXRInputSourceState("hand", handedness);
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const rig = useMemo(createRig, []);
  useEffect(() => () => disposeRig(rig), [rig]);

  useFrame(() => {
    const hand = state?.inputSource.hand;
    if (!hand) return;
    const frame = gl.xr.getFrame?.();
    const refSpace = gl.xr.getReferenceSpace?.();
    if (!frame || !refSpace) return;
    const spaces = jointSpaces(rig, hand);
    if (!spaces) return;
    readPoses(frame, refSpace, spaces, rig);

    const { positions, tracked } = rig;
    for (let i = 0; i < JOINT_COUNT; i++) {
      if (tracked[i]) {
        tmpMatrix.makeTranslation(
          positions[i * 3]!,
          positions[i * 3 + 1]!,
          positions[i * 3 + 2]!
        );
        rig.joints.setMatrixAt(i, tmpMatrix);
      } else {
        // Same as an XRSpace without a pose: the joint stops being drawn.
        rig.joints.setMatrixAt(i, ZERO_MATRIX);
      }
    }
    rig.joints.instanceMatrix.needsUpdate = true;

    const line = rig.boneGeometry.getAttribute("position");
    const arr = line.array as Float32Array;
    for (let v = 0; v < BONE_INDEX.length; v++) {
      const j = BONE_INDEX[v]! * 3;
      arr[v * 3] = positions[j]!;
      arr[v * 3 + 1] = positions[j + 1]!;
      arr[v * 3 + 2] = positions[j + 2]!;
    }
    line.needsUpdate = true;

    // Grab state is read, never subscribed to: this runs in the frame loop.
    const s = xrUiStore.getState();
    const hold = handedness === "left" ? s.leftHold : s.rightHold;
    const ready = handedness === "left" ? s.left : s.right;
    const color = hold ? HOLD_COLOR : ready ? READY_COLOR : IDLE_COLOR;
    if (rig.color !== color) {
      rig.color = color;
      rig.jointMaterial.color.set(color);
      rig.boneMaterial.color.set(color);
    }

    const badge = rig.badge;
    badge.visible = ready || hold;
    if (badge.visible) {
      const zoom = s.leftHold && s.rightHold;
      const material = hold
        ? zoom
          ? zoomHoldMat
          : moveHoldMat
        : zoom
          ? zoomReadyMat
          : moveReadyMat;
      if (badge.material !== material) badge.material = material;
      tmpA.set(positions[0]!, positions[1]!, positions[2]!);
      tmpA.y += 0.055;
      tmpRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
      tmpA.addScaledVector(tmpRight, handedness === "left" ? 0.03 : -0.03);
      badge.position.copy(tmpA);
    }
  });

  if (!state?.inputSource.hand) return null;
  // `dispose={null}`: the rig outlives a hand dropping out of tracking.
  return <primitive object={rig.group} dispose={null} />;
}

export function HandSkeletons() {
  return (
    <>
      <OneHand handedness="left" />
      <OneHand handedness="right" />
    </>
  );
}
