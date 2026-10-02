import type { RootState, ThreeEvent } from "@react-three/fiber";
import type { Pose, WorldVec3 } from "@sfab-bench/contract";
import * as THREE from "three";

import {
  dragStarted,
  pointerOnPlane,
  rayOnPlane,
  slidePose,
} from "@/lib/world-drag";
import { type MoveTarget, poseCommit } from "@/lib/world-move";
import type { useOrbitPause } from "@/scene/use-orbit-pause";
import { previewPose } from "@/scene/world-preview";
import {
  beginToolGesture,
  commitToolEdit,
  endToolGesture,
} from "@/state/world-tool";

/**
 * Select mode: a press on the selected board or box, then a drag, slides
 * it on the plane through its origin. A press that does not move is a
 * click and only selects. Orbit stays off for the press so the camera does
 * not turn under the drag.
 */
export function startBodyDrag(input: {
  event: ThreeEvent<PointerEvent>;
  three: RootState;
  content: THREE.Object3D;
  move: Extract<MoveTarget, { ok: true }>;
  path: string;
  orbit: ReturnType<typeof useOrbitPause>;
}) {
  const { event, three, content, move, path, orbit } = input;
  const base: Pose = move.node.pose;
  const inverse = content.matrixWorld.clone().invert();
  const grabbed = rayOnPlane(event.ray, inverse, base.position[2]);
  if (!grabbed) return;
  const origin: WorldVec3 = grabbed;

  orbit.pause();
  const raycaster = new THREE.Raycaster();
  const down = { x: event.clientX, y: event.clientY };
  let started = false;
  let latest: Pose | null = null;

  const cleanup = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    orbit.resume();
  };
  const restore = () => {
    latest = null;
    previewPose(path, null);
  };
  const cancel = () => {
    cleanup();
    started = false;
    restore();
  };
  function onMove(e: PointerEvent) {
    if (e.pointerId !== event.pointerId) return;
    if (!started) {
      if (!dragStarted(e.clientX - down.x, e.clientY - down.y)) return;
      started = true;
      beginToolGesture(cancel);
    }
    const now = pointerOnPlane(
      e,
      three.gl.domElement.getBoundingClientRect(),
      three.camera,
      inverse,
      base.position[2],
      raycaster
    );
    if (!now) return;
    latest = slidePose(base, origin, now);
    previewPose(path, latest);
  }
  function onUp(e: PointerEvent) {
    if (e.pointerId !== event.pointerId) return;
    cleanup();
    if (!started) return;
    started = false;
    endToolGesture();
    const commit = latest ? poseCommit(move, path, latest, "Move") : null;
    if (commit) commitToolEdit(commit);
    else restore();
  }
  function onCancel(e: PointerEvent) {
    if (e.pointerId !== event.pointerId) return;
    if (started) endToolGesture();
    cancel();
  }
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
}
