import { GizmoHelper, GizmoViewport } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import {
  useXR,
  useXRControllerButtonEvent,
  useXRInputSourceState,
  XRSpace,
} from "@react-three/xr";
import { useRef } from "react";
import * as THREE from "three";
import { useShallow } from "zustand/react/shallow";

import { usePrefs } from "@/state/prefs";
import { sceneStore } from "@/state/scene";
import { useXrTheme } from "@/xr/ui/theme";
import { WorldAxes } from "@/xr/WorldAxes";

const parentQ = new THREE.Quaternion();
const modelQ = new THREE.Quaternion();

function ModelAlignedAxes({ length }: { length: number }) {
  const inner = useRef<THREE.Group>(null);
  useFrame(() => {
    const g = inner.current;
    if (!g?.parent) return;
    g.parent.updateWorldMatrix(true, false);
    g.parent.getWorldQuaternion(parentQ);
    g.quaternion.copy(parentQ).invert();
    // Read `placed` per frame instead of subscribing: this runs in the frame loop.
    const target = sceneStore.getState().placed;
    if (target) {
      target.updateWorldMatrix(true, false);
      target.getWorldQuaternion(modelQ);
      g.quaternion.multiply(modelQ);
    }
  });
  return (
    <group ref={inner}>
      <WorldAxes length={length} />
    </group>
  );
}

export function CornerAxes() {
  const axesVisible = usePrefs((s) => s.axesVisible);
  const theme = useXrTheme();
  if (!axesVisible) return null;
  return (
    <GizmoHelper alignment="bottom-right" margin={[72, 72]}>
      <GizmoViewport
        axisColors={["#e11d48", "#16a34a", "#2563eb"]}
        labelColor={theme.text}
      />
    </GizmoHelper>
  );
}

export function RightAxes() {
  const session = useXR((s) => s.session);
  const right = useXRInputSourceState("controller", "right");
  const { axesVisible, setAxesVisible } = usePrefs(
    useShallow((s) => ({
      axesVisible: s.axesVisible,
      setAxesVisible: s.setAxesVisible,
    }))
  );

  useXRControllerButtonEvent(right, "a-button", (state) => {
    if (state === "pressed") setAxesVisible((open) => !open);
  });

  if (!session || !right) return null;

  const space = right.inputSource.gripSpace ?? right.inputSource.targetRaySpace;
  if (!space || !axesVisible) return null;
  return (
    <XRSpace space={space}>
      <group position={[0, 0.04, 0]}>
        <ModelAlignedAxes length={0.045} />
      </group>
    </XRSpace>
  );
}

/** Renders inside the right `HandRig`, so the wrist transform is already applied. */
export function RightHandAxes() {
  const session = useXR((s) => s.session);
  const right = useXRInputSourceState("controller", "right");
  const axesVisible = usePrefs((s) => s.axesVisible);
  if (!session || right || !axesVisible) return null;
  return (
    <group position={[0, 0.02, 0.09]}>
      <ModelAlignedAxes length={0.028} />
    </group>
  );
}
