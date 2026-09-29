import type { RootState, ThreeEvent } from "@react-three/fiber";
import type { Pose, WorldVec3 } from "@sfab-bench/contract";
import * as THREE from "three";

import { dragStarted, rayPlaneZ, slidePose } from "@/lib/world-drag";
import { type MoveTarget, poseCommit } from "@/lib/world-move";
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
}) {
  const { event, three, content, move, path } = input;
  const base: Pose = move.node.pose;
  const inverse = content.matrixWorld.clone().invert();
  const hit = (ray: THREE.Ray): WorldVec3 | null => {
    const local = ray.clone().applyMatrix4(inverse);
    return rayPlaneZ(
      [local.origin.x, local.origin.y, local.origin.z],
      [local.direction.x, local.direction.y, local.direction.z],
      base.position[2]
    );
  };
  const origin = hit(event.ray);
  if (!origin) return;

  const controls = three.controls as { enabled?: boolean } | null;
  const orbitWas = controls?.enabled;
  if (controls) controls.enabled = false;
  const raycaster = new THREE.Raycaster();
  const down = { x: event.clientX, y: event.clientY };
  let started = false;
  let latest: Pose | null = null;

  const cleanup = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    if (controls && orbitWas !== undefined) controls.enabled = orbitWas;
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
    const rect = three.gl.domElement.getBoundingClientRect();
    raycaster.setFromCamera(
      new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      ),
      three.camera
    );
    const now = hit(raycaster.ray);
    if (!now) return;
    latest = slidePose(base, origin as WorldVec3, now);
    previewPose(path, latest);
  }
  function onUp(e: PointerEvent) {
    if (e.pointerId !== event.pointerId) return;
    cleanup();
    if (!started) return;
    started = false;
    endToolGesture();
    const commit = latest ? poseCommit(move, path, latest) : null;
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
