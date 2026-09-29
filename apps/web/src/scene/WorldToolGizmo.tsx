import { TransformControls } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import type { Pose } from "@sfab-bench/contract";
import {
  type ComponentRef,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import type * as THREE from "three";

import { useXrSession } from "@/hooks/useXrSession";
import { objectFromPose, poseFromObject } from "@/lib/world-drag";
import { moveTarget, poseCommit } from "@/lib/world-move";
import { isPoseTool } from "@/lib/world-tool";
import { previewPose, registerPreview } from "@/scene/world-preview";
import { useWorld } from "@/state/world";
import {
  beginToolGesture,
  commitToolEdit,
  endToolGesture,
  useWorldTool,
} from "@/state/world-tool";

function place(proxy: THREE.Object3D, pose: Pose) {
  const object = objectFromPose(pose);
  proxy.position.copy(object.position);
  proxy.quaternion.copy(object.quaternion);
  proxy.updateMatrixWorld(true);
}

/**
 * The Move and Rotate handles. The proxy sits inside the world content
 * group, so its local transform is the document frame and `poseFromObject`
 * reads it as is. The handles render outside that group so the Z-up turn
 * does not turn the gizmo. While dragging, the stage previews through the
 * preview registry; release sends one `set-pose`.
 */
export function WorldToolGizmo({
  proxyRef,
}: {
  proxyRef: RefObject<THREE.Group | null>;
}) {
  const mode = useWorldTool((s) => s.mode);
  const tree = useWorld((s) => s.tree);
  const path = useWorld((s) => s.selection?.path ?? null);
  const session = useXrSession();
  const invalidate = useThree((s) => s.invalidate);
  const orbit = useThree((s) => s.controls) as { enabled?: boolean } | null;
  const controlsRef = useRef<ComponentRef<typeof TransformControls>>(null);
  const orbitWas = useRef<boolean | undefined>(undefined);
  const openDocument = useWorld((s) => s.path);
  const move = moveTarget(tree, path, openDocument);

  // The installed three-stdlib never dispatches `dragging-changed`, so drei
  // does not stop the orbit under a handle drag. Do it on the press.
  const pauseOrbit = () => {
    if (!orbit || orbitWas.current !== undefined) return;
    orbitWas.current = orbit.enabled;
    orbit.enabled = false;
  };
  const resumeOrbit = () => {
    if (orbit && orbitWas.current !== undefined) {
      orbit.enabled = orbitWas.current;
    }
    orbitWas.current = undefined;
  };
  const pose = move.ok ? move.node.pose : null;
  const active = isPoseTool(mode) && move.ok && path !== null && !session;

  // The handles leaving mid-drag (tool, selection, unmount) give the orbit back.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resumeOrbit only reads the orbit and a ref
  useEffect(() => resumeOrbit, [active, orbit]);

  useLayoutEffect(() => {
    const proxy = proxyRef.current;
    if (!proxy || !pose) return;
    place(proxy, pose);
    invalidate();
  }, [pose, proxyRef, invalidate]);

  useEffect(() => {
    if (!path || !pose) return;
    return registerPreview(path, {
      set: (next) => {
        const proxy = proxyRef.current;
        if (!next && proxy) place(proxy, pose);
      },
    });
  }, [path, pose, proxyRef]);

  if (!active || !move.ok || !path) return null;

  const cancel = () => {
    // three-stdlib types these private; a cancel sets them to end the drag.
    const controls = controlsRef.current as unknown as {
      dragging: boolean;
      axis: string | null;
    } | null;
    if (controls) {
      controls.dragging = false;
      controls.axis = null;
    }
    resumeOrbit();
    const proxy = proxyRef.current;
    if (proxy) place(proxy, move.node.pose);
    previewPose(path, null);
  };
  const current = () => {
    const proxy = proxyRef.current;
    return proxy ? poseFromObject(proxy.position, proxy.quaternion) : null;
  };

  return (
    <group onClick={(event) => event.stopPropagation()}>
      <TransformControls
        ref={controlsRef}
        object={proxyRef as RefObject<THREE.Object3D>}
        mode={mode === "rotate" ? "rotate" : "translate"}
        space="local"
        size={0.8}
        onMouseDown={() => {
          pauseOrbit();
          beginToolGesture(cancel);
        }}
        onObjectChange={() => {
          const next = current();
          if (next) previewPose(path, next);
        }}
        onMouseUp={() => {
          endToolGesture();
          resumeOrbit();
          const next = current();
          const commit = next ? poseCommit(move, path, next) : null;
          if (commit) commitToolEdit(commit);
          else cancel();
        }}
      />
    </group>
  );
}
