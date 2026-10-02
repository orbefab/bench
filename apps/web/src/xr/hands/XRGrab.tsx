import { useFrame, useThree } from "@react-three/fiber";
import {
  useXRInputSourceEvent,
  useXRInputSourceState,
  XRSpace,
} from "@react-three/xr";
import { useRef } from "react";
import * as THREE from "three";

import { sceneStore } from "@/state/scene";
import { xrUiStore } from "@/state/xr";
import { wristObject } from "@/xr/hands/HandRig";
import {
  type CardReg,
  cardContains,
  hitChrome,
  NEAR_LEAVE,
  nearestCard,
} from "@/xr/ui/chrome";

// Ready = both angles below. Grab starts on a close while orange.
// Raise a value to arm more easily; lower it to arm less.
const CURL_ON = 0.12;
const CURL_OFF = 0.155;
const deg = Math.PI / 180;
// World up (gravity Y): 0 = palm toward the other hand, + = toward your face.
const YAW_DEG = 35;
const YAW_BACK_DEG = 8; // slack past inward, toward the outside
// Around the forearm: 0 = palm vertical, + = toward floor or ceiling.
const ROLL_DEG = 20;
const HOLD_DEG = 10; // extra degrees before orange drops
const YAW_MIN_ON = -YAW_BACK_DEG * deg;
const YAW_MAX_ON = YAW_DEG * deg;
const YAW_MIN_OFF = -(YAW_BACK_DEG + HOLD_DEG) * deg;
const YAW_MAX_OFF = (YAW_DEG + HOLD_DEG) * deg;
const ROLL_ON = ROLL_DEG * deg;
const ROLL_OFF = (ROLL_DEG + HOLD_DEG) * deg;
const vA = new THREE.Vector3();
const vB = new THREE.Vector3();
const vC = new THREE.Vector3();
const vH = new THREE.Vector3();
const vRight = new THREE.Vector3();
const vForward = new THREE.Vector3();
const fistB = new THREE.Vector3();
const fistC = new THREE.Vector3();
const fistPts: THREE.Vector3[] = [];
const UP = new THREE.Vector3(0, 1, 0);
const SCALE_MIN = 0.15;
const SCALE_MAX = 8;
const pairA = new THREE.Vector3();
const pairB = new THREE.Vector3();
const pairMid = new THREE.Vector3();
const pairArm = new THREE.Vector3();
const pairRot = new THREE.Quaternion();

/** Midpoint, floor-plane yaw and distance of two grip spaces. */
type PairPose = { mid: THREE.Vector3; yaw: number; dist: number };

/**
 * Two-hand hold. Move follows the midpoint between the hands, turn follows the
 * hand-to-hand direction around world up (yaw only, so the model stays level),
 * and scale follows the hand distance, pivoting about the midpoint so the
 * model stays between the hands.
 */
type TwoHand = {
  startMid: THREE.Vector3;
  startYaw: number;
  startDist: number;
  startScale: number;
  startPos: THREE.Vector3;
  startQuat: THREE.Quaternion;
};

/** Pose of one hand joint, or null. Module level so the frame loop allocates nothing. */
function jointPose(
  frame: XRFrame,
  refSpace: XRSpace,
  hand: XRHand,
  name: XRHandJoint
): XRPose | null {
  const joint = hand.get(name);
  if (!joint) return null;
  return frame.getPose(joint, refSpace) ?? null;
}

/** Distance from `origin` to one hand joint, or null when the joint is not posed. */
function jointDist(
  frame: XRFrame,
  refSpace: XRSpace,
  hand: XRHand,
  name: XRHandJoint,
  origin: XRPose
): number | null {
  const pose = jointPose(frame, refSpace, hand, name);
  if (!pose) return null;
  const a = origin.transform.position;
  const b = pose.transform.position;
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function XRGrab() {
  // Actions are stable; the grabbed group is read per call so the frame loop
  // never subscribes to the store.
  const { setHandGrab, setHandHold, setWorldGrabbing } = xrUiStore.getState();
  const { setModelScale } = sceneStore.getState();
  const left = useXRInputSourceState("controller", "left");
  const right = useXRInputSourceState("controller", "right");
  const leftHand = useXRInputSourceState("hand", "left");
  const rightHand = useXRInputSourceState("hand", "right");
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const ready = useRef({ left: false, right: false });
  const grabbing = useRef({ left: false, right: false });
  const wasCurled = useRef({ left: false, right: false });
  const nearHold = useRef({ left: false, right: false });
  const nearZone = useRef<{ left: CardReg | null; right: CardReg | null }>({
    left: null,
    right: null,
  });
  const nearHover = useRef<{ left: CardReg | null; right: CardReg | null }>({
    left: null,
    right: null,
  });
  const nearJoint = useRef<{
    left: "middle" | "index" | null;
    right: "middle" | "index" | null;
  }>({
    left: null,
    right: null,
  });
  const leftGrip = useRef<THREE.Object3D>(null);
  const rightGrip = useRef<THREE.Object3D>(null);
  const squeezing = useRef(new Set<XRInputSource>());
  const grab = useRef<{ source: XRInputSource; offset: THREE.Matrix4 } | null>(
    null
  );
  const twoHand = useRef<TwoHand | null>(null);
  const inv = useRef(new THREE.Matrix4());
  const tmp = useRef(new THREE.Matrix4());
  const pos = useRef(new THREE.Vector3());
  const quat = useRef(new THREE.Quaternion());
  const scl = useRef(new THREE.Vector3());
  const heldScale = useRef(1);

  const spaceFor = (source: XRInputSource) => {
    // Hands share the one wrist space mounted by HandRig.
    if (source.hand) {
      return wristObject(source.handedness === "left" ? "left" : "right");
    }
    return source.handedness === "left" ? leftGrip.current : rightGrip.current;
  };

  /** Pose of the two holding grips, or null unless exactly two are holding. */
  const pairPose = (out: PairPose): PairPose | null => {
    if (squeezing.current.size !== 2) return null;
    let first: XRInputSource | undefined;
    let second: XRInputSource | undefined;
    for (const source of squeezing.current) {
      if (!first) first = source;
      else {
        second = source;
        break;
      }
    }
    const a = first ? spaceFor(first) : null;
    const b = second ? spaceFor(second) : null;
    if (!a || !b) return null;
    a.getWorldPosition(pairA);
    b.getWorldPosition(pairB);
    out.mid.copy(pairA).add(pairB).multiplyScalar(0.5);
    out.yaw = Math.atan2(pairA.x - pairB.x, pairA.z - pairB.z);
    out.dist = Math.max(0.02, pairA.distanceTo(pairB));
    return out;
  };
  const pairScratch = useRef<PairPose>({
    mid: new THREE.Vector3(),
    yaw: 0,
    dist: 0,
  });

  const startHold = (source: XRInputSource) => {
    const obj = sceneStore.getState().placed;
    if (
      !obj ||
      squeezing.current.has(source) ||
      xrUiStore.getState().cardDragging
    )
      return;
    const space = spaceFor(source);
    if (!space) return;
    squeezing.current.add(source);
    setWorldGrabbing(true);
    if (squeezing.current.size === 2) {
      grab.current = null;
      const pair = pairPose(pairScratch.current);
      twoHand.current = pair
        ? {
            startMid: pair.mid.clone(),
            startYaw: pair.yaw,
            startDist: pair.dist,
            startScale: obj.scale.x,
            startPos: obj.position.clone(),
            startQuat: obj.quaternion.clone(),
          }
        : null;
      return;
    }
    obj.updateMatrixWorld();
    heldScale.current = obj.scale.x;
    inv.current.copy(space.matrixWorld).invert();
    grab.current = {
      source,
      offset: new THREE.Matrix4().multiplyMatrices(
        inv.current,
        obj.matrixWorld
      ),
    };
  };

  const endHold = (source: XRInputSource) => {
    squeezing.current.delete(source);
    setWorldGrabbing(squeezing.current.size > 0);
    twoHand.current = squeezing.current.size === 2 ? twoHand.current : null;
    if (grab.current?.source === source) grab.current = null;
    const held = sceneStore.getState().placed;
    if (held) setModelScale(held.scale.x);
    if (squeezing.current.size === 1 && held) {
      const remaining = squeezing.current.values().next().value;
      const space = remaining ? spaceFor(remaining) : undefined;
      if (remaining && space) {
        held.updateMatrixWorld();
        inv.current.copy(space.matrixWorld).invert();
        grab.current = {
          source: remaining,
          offset: new THREE.Matrix4().multiplyMatrices(
            inv.current,
            held.matrixWorld
          ),
        };
      }
    }
  };

  /** `Set` iteration tolerates the deletes `endHold` makes. */
  const endHoldsFor = (handedness: XRHandedness) => {
    for (const source of squeezing.current) {
      if (source.handedness === handedness) endHold(source);
    }
  };

  useXRInputSourceEvent(
    "all",
    "squeezestart",
    (event) => {
      if (event.inputSource.hand || xrUiStore.getState().cardDragging) return;
      startHold(event.inputSource);
    },
    []
  );

  useXRInputSourceEvent(
    "all",
    "squeezeend",
    (event) => {
      if (event.inputSource.hand) return;
      endHold(event.inputSource);
    },
    []
  );

  const clearSide = (side: "left" | "right") => {
    ready.current[side] = false;
    grabbing.current[side] = false;
    wasCurled.current[side] = false;
    if (nearHold.current[side]) {
      nearZone.current[side]?.end();
      nearHold.current[side] = false;
      nearZone.current[side] = null;
      nearJoint.current[side] = null;
    }
    nearHover.current[side]?.hover(false);
    nearHover.current[side] = null;
    setHandGrab(side, false);
    setHandHold(side, false);
    endHoldsFor(side);
  };

  useFrame(() => {
    const frame = gl.xr.getFrame?.();
    const refSpace = gl.xr.getReferenceSpace?.();
    const cardDrag = xrUiStore.getState().cardDragging;
    const worldGrab = xrUiStore.getState().worldGrabbing;
    if (cardDrag && !nearHold.current.left && !nearHold.current.right) {
      if (ready.current.left || grabbing.current.left) clearSide("left");
      if (ready.current.right || grabbing.current.right) clearSide("right");
      for (const source of [...squeezing.current]) endHold(source);
    }
    if (frame && refSpace) {
      if (
        !leftHand &&
        (ready.current.left || grabbing.current.left || nearHold.current.left)
      ) {
        ready.current.left = false;
        grabbing.current.left = false;
        wasCurled.current.left = false;
        setHandGrab("left", false);
        setHandHold("left", false);
        endHoldsFor("left");
      }
      if (
        !rightHand &&
        (ready.current.right ||
          grabbing.current.right ||
          nearHold.current.right)
      ) {
        ready.current.right = false;
        grabbing.current.right = false;
        wasCurled.current.right = false;
        setHandGrab("right", false);
        setHandHold("right", false);
        endHoldsFor("right");
      }
      vRight.setFromMatrixColumn(camera.matrixWorld, 0);
      vRight.y = 0;
      if (vRight.lengthSq() > 1e-6) vRight.normalize();
      vForward.setFromMatrixColumn(camera.matrixWorld, 2).negate();
      vForward.y = 0;
      if (vForward.lengthSq() > 1e-6) vForward.normalize();
      for (const state of [leftHand, rightHand]) {
        const source = state?.inputSource;
        const hand = source?.hand;
        if (!source || !hand) continue;
        const side = source.handedness === "left" ? "left" : "right";
        const wrist = hand.get("wrist");
        if (!wrist) continue;
        const origin = frame.getPose(wrist, refSpace);
        if (!origin) continue;
        const index = jointDist(
          frame,
          refSpace,
          hand,
          "index-finger-tip",
          origin
        );
        const middle = jointDist(
          frame,
          refSpace,
          hand,
          "middle-finger-tip",
          origin
        );
        const ring = jointDist(
          frame,
          refSpace,
          hand,
          "ring-finger-tip",
          origin
        );
        if (index == null || middle == null || ring == null) continue;
        const holding = grabbing.current[side];
        const curled = holding
          ? index < CURL_OFF && middle < CURL_OFF && ring < CURL_OFF
          : index < CURL_ON && middle < CURL_ON && ring < CURL_ON;
        const closedNow = curled && !wasCurled.current[side];
        const other = side === "left" ? "right" : "left";
        fistPts.length = 0;
        const midKn = jointPose(
          frame,
          refSpace,
          hand,
          "middle-finger-phalanx-proximal"
        );
        if (midKn) {
          fistB.set(
            midKn.transform.position.x,
            midKn.transform.position.y,
            midKn.transform.position.z
          );
          fistPts.push(fistB);
        }
        const idxKn = jointPose(
          frame,
          refSpace,
          hand,
          "index-finger-phalanx-proximal"
        );
        if (idxKn) {
          fistC.set(
            idxKn.transform.position.x,
            idxKn.transform.position.y,
            idxKn.transform.position.z
          );
          fistPts.push(fistC);
        }
        const follow =
          nearJoint.current[side] === "index" && idxKn
            ? fistC
            : midKn
              ? fistB
              : fistC;
        const inChrome = fistPts.some((p) => hitChrome(p));
        if (inChrome) {
          ready.current[side] = false;
          setHandGrab(side, false);
        }
        if (
          fistPts.length &&
          !holding &&
          !worldGrab &&
          !nearHold.current[other]
        ) {
          if (nearHold.current[side]) {
            ready.current[side] = false;
            setHandGrab(side, false);
            if (!curled) {
              nearZone.current[side]?.end();
              nearHold.current[side] = false;
              nearZone.current[side] = null;
              nearJoint.current[side] = null;
            } else {
              nearZone.current[side]?.update(follow);
            }
            wasCurled.current[side] = curled;
            continue;
          }
          const hovered = nearHover.current[side];
          let hit = nearestCard(fistPts, 1);
          if (!hit && hovered) {
            for (const p of fistPts) {
              if (cardContains(hovered, p, NEAR_LEAVE)) {
                hit = { card: hovered, point: p };
                break;
              }
            }
          }
          if (hit) {
            ready.current[side] = false;
            setHandGrab(side, false);
            if (hovered && hovered !== hit.card) hovered.hover(false);
            hit.card.hover(true, hit.point);
            nearHover.current[side] = hit.card;
            if (closedNow) {
              hit.card.begin(hit.point);
              nearHold.current[side] = true;
              nearZone.current[side] = hit.card;
              nearJoint.current[side] =
                hit.point === fistC ? "index" : "middle";
            }
            wasCurled.current[side] = curled;
            continue;
          }
        }
        if (nearHold.current[side]) {
          if (!curled) {
            nearZone.current[side]?.end();
            nearHold.current[side] = false;
            nearZone.current[side] = null;
            nearJoint.current[side] = null;
          } else {
            nearZone.current[side]?.update(follow);
          }
          ready.current[side] = false;
          setHandGrab(side, false);
          wasCurled.current[side] = curled;
          continue;
        }
        if (nearHover.current[side]) {
          nearHover.current[side]?.hover(false);
          nearHover.current[side] = null;
        }
        if (cardDrag || inChrome) {
          wasCurled.current[side] = curled;
          continue;
        }
        const midMeta = jointPose(
          frame,
          refSpace,
          hand,
          "middle-finger-metacarpal"
        );
        const idxMeta = jointPose(
          frame,
          refSpace,
          hand,
          "index-finger-metacarpal"
        );
        const pnkMeta = jointPose(
          frame,
          refSpace,
          hand,
          "pinky-finger-metacarpal"
        );
        let inward = false;
        if (midMeta && idxMeta && pnkMeta) {
          const w = origin.transform.position;
          vA.set(
            midMeta.transform.position.x - w.x,
            midMeta.transform.position.y - w.y,
            midMeta.transform.position.z - w.z
          );
          vB.set(
            idxMeta.transform.position.x - pnkMeta.transform.position.x,
            idxMeta.transform.position.y - pnkMeta.transform.position.y,
            idxMeta.transform.position.z - pnkMeta.transform.position.z
          );
          vC.copy(vB).cross(vA).normalize();
          if (side === "left") vC.negate();
          const wide = ready.current[side] || grabbing.current[side];
          const roll = Math.atan2(Math.abs(vC.y), Math.hypot(vC.x, vC.z));
          vH.set(vC.x, 0, vC.z);
          if (vH.lengthSq() > 1e-6) {
            vH.normalize();
            const inAmt = side === "left" ? vH.dot(vRight) : -vH.dot(vRight);
            const toward = -vH.dot(vForward);
            const yaw = Math.atan2(toward, inAmt);
            const yawOk = wide
              ? yaw > YAW_MIN_OFF && yaw < YAW_MAX_OFF
              : yaw > YAW_MIN_ON && yaw < YAW_MAX_ON;
            const rollOk = wide ? roll < ROLL_OFF : roll < ROLL_ON;
            inward = yawOk && rollOk;
          }
        }
        const armed = ready.current[side];
        const canArm = inward && !curled;
        if (holding) {
          setHandHold(side, true);
          if (!curled) {
            grabbing.current[side] = false;
            endHold(source);
            setHandHold(side, false);
            ready.current[side] = canArm;
            setHandGrab(side, canArm);
          } else if (!squeezing.current.has(source)) {
            startHold(source);
          }
        } else {
          setHandHold(side, false);
          ready.current[side] = canArm;
          setHandGrab(side, canArm);
          if (armed && inward && closedNow) {
            grabbing.current[side] = true;
            setHandHold(side, true);
            setHandGrab(side, false);
            startHold(source);
          }
        }
        wasCurled.current[side] = curled;
      }
    }

    const obj = sceneStore.getState().placed;
    if (!obj) return;
    const two = twoHand.current;
    if (two && squeezing.current.size === 2) {
      const pair = pairPose(pairScratch.current);
      if (!pair) return;
      const next = two.startScale * (pair.dist / two.startDist);
      heldScale.current = Math.max(SCALE_MIN, Math.min(SCALE_MAX, next));
      const ratio = heldScale.current / two.startScale;
      pairRot.setFromAxisAngle(UP, pair.yaw - two.startYaw);
      // Where the model origin sat relative to the first midpoint, turned and
      // stretched with the hands, then re-attached to the current midpoint.
      pairArm
        .copy(two.startPos)
        .sub(two.startMid)
        .multiplyScalar(ratio)
        .applyQuaternion(pairRot);
      obj.position.copy(pair.mid).add(pairArm);
      obj.quaternion.copy(pairRot).multiply(two.startQuat);
      obj.scale.setScalar(heldScale.current);
      return;
    }
    if (!grab.current) return;
    const space = spaceFor(grab.current.source);
    if (!space) return;
    tmp.current.copy(space.matrixWorld).multiply(grab.current.offset);
    tmp.current.decompose(pos.current, quat.current, scl.current);
    obj.position.copy(pos.current);
    obj.quaternion.copy(quat.current);
    obj.scale.setScalar(heldScale.current);
  });

  return (
    <>
      {left?.inputSource.gripSpace && (
        <XRSpace ref={leftGrip} space={left.inputSource.gripSpace} />
      )}
      {right?.inputSource.gripSpace && (
        <XRSpace ref={rightGrip} space={right.inputSource.gripSpace} />
      )}
    </>
  );
}
