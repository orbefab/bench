import { useFrame, useThree } from "@react-three/fiber";
import { useXR } from "@react-three/xr";
import { useCallback, useEffect, useRef, useState } from "react";
import type * as THREE from "three";

import { placeAtGaze } from "@/scene/SpawnInFront";
import { useXrUi } from "@/state/xr";
import { ChatOrbHud } from "@/xr/ui/ChatOrbHud";
import { ChatPanels } from "@/xr/ui/ChatPanels";
import { type CardSize, cardMeters } from "@/xr/ui/chrome";
import { ORB_RADIUS, SpeakingOrb } from "@/xr/ui/SpeakingOrb";
import { WorldCard } from "@/xr/ui/WorldCard";
import { XrChatRuntimeProvider } from "@/xr/ui/XrChatRuntime";

const CHAT_CARD = {
  w: 340,
  h: 520,
  minW: 280,
  minH: 400,
  maxW: 800,
  maxH: 720,
};
const ORB_LIFT = 0.08;

export function ChatDock() {
  const session = useXR((s) => s.session);
  const camera = useThree((s) => s.camera);
  const xrChatOpen = useXrUi((s) => s.xrChatOpen);
  const setXrChatOpen = useXrUi((s) => s.setXrChatOpen);
  const setBringChat = useXrUi((s) => s.setBringChat);
  const [size, setSize] = useState<CardSize>({
    w: CHAT_CARD.w,
    h: CHAT_CARD.h,
  });
  const meters = cardMeters(size);
  const orbTop = meters.h / 2 + ORB_LIFT;
  const orbLift = useRef(0);
  const orbSlot = useRef<THREE.Group>(null);
  const dragging = useRef(false);
  const anchor = useRef<THREE.Group>(null);
  const placed = useRef(false);

  const bringHere = useCallback(() => {
    const a = anchor.current;
    if (!a) return;
    placeAtGaze(a, camera, {
      distance: 0.55,
      drop: 0.1,
      side: 0.22,
      face: true,
    });
    placed.current = true;
  }, [camera]);

  useEffect(() => {
    if (session && !placed.current) bringHere();
  }, [session, bringHere]);

  useEffect(() => {
    setBringChat(bringHere);
    return () => setBringChat(null);
  }, [bringHere, setBringChat]);

  useFrame((_, dt) => {
    const a = anchor.current;
    if (!a) return;
    a.visible = Boolean(session);
    const orbGoal = xrChatOpen ? orbTop : 0;
    orbLift.current += (orbGoal - orbLift.current) * Math.min(1, 10 * dt);
    if (orbSlot.current) orbSlot.current.position.y = orbLift.current;
  });

  const toggleCard = () => {
    if (dragging.current) return;
    setXrChatOpen((open) => !open);
  };

  if (!session) return null;
  return (
    <WorldCard
      ref={anchor}
      visible={false}
      size={size}
      onSizeChange={setSize}
      limits={CHAT_CARD}
      shape={xrChatOpen ? "card" : "orb"}
      radius={ORB_RADIUS}
      resizable={xrChatOpen}
      movable
      handle={xrChatOpen}
      onDragStart={() => {
        dragging.current = true;
      }}
      onDragEnd={() => {
        dragging.current = false;
      }}
    >
      <XrChatRuntimeProvider>
        <group ref={orbSlot}>
          <SpeakingOrb onClick={toggleCard} />
          {xrChatOpen ? null : <ChatOrbHud />}
        </group>
        {xrChatOpen ? <ChatPanels width={size.w} height={size.h} /> : null}
      </XrChatRuntimeProvider>
    </WorldCard>
  );
}
