import { useFrame, useThree } from "@react-three/fiber";
import { Container } from "@react-three/uikit";
import {
  useXR,
  useXRControllerButtonEvent,
  useXRInputSourceState,
  XRSpace,
} from "@react-three/xr";
import { useRef, useState } from "react";
import * as THREE from "three";
import { useShallow } from "zustand/react/shallow";

import { useViewer } from "@/state/viewer";
import { pulse } from "@/xr/haptics";
import { TOOLS } from "@/xr/tools";
import { useXrTheme } from "@/xr/ui/theme";

const SLOT = 0.04;
const quat = new THREE.Quaternion();
const scratch = new THREE.Vector3();

export function DrawerStrip({ highlight }: { highlight: number }) {
  const theme = useXrTheme();
  return (
    <Container
      flexDirection="row"
      gap={8}
      padding={8}
      borderRadius={12}
      backgroundColor={theme.card}
      pixelSize={0.001}
      pointerEvents="none"
    >
      {TOOLS.map((item, i) => (
        <Container
          key={item.id}
          width={36}
          height={36}
          alignItems="center"
          justifyContent="center"
          borderRadius={8}
          backgroundColor={highlight === i ? theme.active : theme.muted}
        >
          <item.Icon width={20} height={20} color={theme.text} />
        </Container>
      ))}
    </Container>
  );
}

export function ToolDrawer() {
  const right = useXRInputSourceState("controller", "right");
  const session = useXR((s) => s.session);
  const camera = useThree((s) => s.camera);
  const { tool, setTool } = useViewer(
    useShallow((s) => ({ tool: s.tool, setTool: s.setTool }))
  );
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const openRef = useRef(false);
  const highlightRef = useRef(0);
  const origin = useRef(new THREE.Vector3());
  const startIndex = useRef(0);
  const rightDir = useRef(new THREE.Vector3());
  const grip = useRef<THREE.Object3D>(null);

  useXRControllerButtonEvent(right, "b-button", (state) => {
    if (!right) return;
    if (state === "pressed") {
      const i = Math.max(
        0,
        TOOLS.findIndex((t) => t.id === tool)
      );
      startIndex.current = i;
      highlightRef.current = i;
      setHighlight(i);
      grip.current?.getWorldPosition(origin.current);
      openRef.current = true;
      setOpen(true);
      pulse(right.inputSource);
      return;
    }
    if (openRef.current) {
      const next = TOOLS[highlightRef.current]?.id;
      if (next) setTool(next);
      openRef.current = false;
      setOpen(false);
    }
  });

  useFrame(() => {
    if (!openRef.current || !grip.current) return;
    grip.current.getWorldPosition(scratch);
    camera.getWorldQuaternion(quat);
    rightDir.current.set(1, 0, 0).applyQuaternion(quat);
    rightDir.current.y = 0;
    if (rightDir.current.lengthSq() < 1e-6) rightDir.current.set(1, 0, 0);
    rightDir.current.normalize();
    const dx = scratch.sub(origin.current).dot(rightDir.current);
    const next = Math.min(
      TOOLS.length - 1,
      Math.max(0, startIndex.current + Math.round(dx / SLOT))
    );
    if (next !== highlightRef.current) {
      highlightRef.current = next;
      setHighlight(next);
      pulse(right?.inputSource);
    }
  });

  const space = right?.inputSource.targetRaySpace;
  if (!session || !right || !space) return null;
  return (
    <XRSpace space={space}>
      <group ref={grip} />
      {open ? (
        <group position={[0, 0.05, -0.14]} rotation={[-0.25, 0, 0]}>
          <DrawerStrip highlight={highlight} />
        </group>
      ) : null}
    </XRSpace>
  );
}
