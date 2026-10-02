import { Container } from "@react-three/uikit";
import { MousePointer2 } from "@react-three/uikit-lucide";
import { useXRInputSourceState } from "@react-three/xr";
import type { ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";

import { useViewer } from "@/state/viewer";
import { useXrUi } from "@/state/xr";
import { PalmDownGate } from "@/xr/PalmDownGate";
import { TOOLS } from "@/xr/tools";
import { FeedbackContext, ToolBtn, useFeedback } from "@/xr/ui/ToolBtn";
import { useXrTheme } from "@/xr/ui/theme";

/** Side of the right wrist: +Z out the face, +Y up the back of the hand. */
function RightWristFace({ children }: { children: ReactNode }) {
  return (
    <group position={[-0.015, 0, 0.03]} rotation={[0, -Math.PI / 2, 0]}>
      {children}
    </group>
  );
}

function ToolWatch() {
  const tool = useViewer((s) => s.tool);
  const { toolsOpen, setToolsOpen } = useXrUi(
    useShallow((s) => ({
      toolsOpen: s.toolsOpen,
      setToolsOpen: s.setToolsOpen,
    }))
  );
  const Icon = TOOLS.find((t) => t.id === tool)?.Icon ?? MousePointer2;
  const theme = useXrTheme();
  return (
    <>
      <mesh
        onClick={(ev) => {
          ev.stopPropagation();
          setToolsOpen((open) => !open);
        }}
      >
        <circleGeometry args={[0.02, 28]} />
        <meshBasicMaterial color={toolsOpen ? theme.active : theme.card} />
      </mesh>
      <group position={[0, 0, 0.001]} raycast={() => {}}>
        <Container pixelSize={0.0007} pointerEvents="none">
          <Icon width={28} height={28} color={theme.text} />
        </Container>
      </group>
    </>
  );
}

function HandToolRig({ hidden }: { hidden: boolean }) {
  const { tool, setTool } = useViewer(
    useShallow((s) => ({
      tool: s.tool,
      setTool: s.setTool,
    }))
  );
  const setToolsOpen = useXrUi((s) => s.setToolsOpen);
  // The left hand points at this strip. Hands have no actuator, so this is
  // a no-op today and starts working if a controller ever drives it.
  const leftHand = useXRInputSourceState("hand", "left");
  const feedback = useFeedback(leftHand?.inputSource);
  const theme = useXrTheme();
  return (
    <FeedbackContext.Provider value={feedback}>
      <PalmDownGate
        hand="right"
        position={[0, 0.08, 0]}
        rotation={[0, 0, 0]}
        hidden={hidden}
      >
        <Container
          flexDirection="row"
          gap={8}
          padding={8}
          borderRadius={12}
          backgroundColor={theme.card}
          pixelSize={0.001}
        >
          {TOOLS.map((item) => (
            <ToolBtn
              key={item.id}
              id={`hand-tool-${item.id}`}
              icon={item.Icon}
              active={tool === item.id}
              grow={false}
              onClick={() => {
                setTool(item.id);
                setToolsOpen(false);
              }}
            />
          ))}
        </Container>
      </PalmDownGate>
    </FeedbackContext.Provider>
  );
}

/** Renders inside the right `HandRig`, so the wrist transform is already applied. */
export function HandTools() {
  const right = useXRInputSourceState("controller", "right");
  const toolsOpen = useXrUi((s) => s.toolsOpen);
  const moving = useXrUi((s) => s.worldGrabbing);
  if (right) return null;
  return (
    <RightWristFace>
      <ToolWatch />
      {toolsOpen ? <HandToolRig hidden={moving} /> : null}
    </RightWristFace>
  );
}
