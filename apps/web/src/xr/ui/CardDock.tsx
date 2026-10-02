import { useFrame, useThree } from "@react-three/fiber";
import { Minus, Pin, PinOff } from "@react-three/uikit-lucide";
import {
  useXR,
  useXRControllerButtonEvent,
  useXRInputSourceState,
  XRSpace,
} from "@react-three/xr";
import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { useShallow } from "zustand/react/shallow";
import { placeAtGaze } from "@/scene/SpawnInFront";
import { useXrUi } from "@/state/xr";
import { wristObject } from "@/xr/hands/HandRig";
import { CardPanels } from "@/xr/ui/CardPanels";
import { type CardSize, HandleButton, WorldCard } from "@/xr/ui/WorldCard";

const deg = Math.PI / 180;
const HAND_OFFSET = new THREE.Matrix4().compose(
  new THREE.Vector3(-0.05, 0.18, -0.2),
  new THREE.Quaternion().setFromEuler(
    new THREE.Euler(-0.48, 0.12 + 40 * deg, 0)
  ),
  new THREE.Vector3(1, 1, 1)
);
const CTRL_OFFSET = new THREE.Matrix4().compose(
  new THREE.Vector3(0.05, 0.09, -0.17),
  new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.48, 0.12, 0)),
  new THREE.Vector3(1, 1, 1)
);

const TREE_CARD = {
  w: 204,
  h: 340,
  minW: 160,
  minH: 240,
  maxW: 320,
  maxH: 500,
};

const tmpM = new THREE.Matrix4();
const tmpS = new THREE.Vector3();

function YToggle() {
  const left = useXRInputSourceState("controller", "left");
  const setCardOpen = useXrUi((s) => s.setCardOpen);
  useXRControllerButtonEvent(left, "y-button", (state) => {
    if (state === "pressed") setCardOpen((open) => !open);
  });
  return null;
}

export function CardDock() {
  const session = useXR((s) => s.session);
  const camera = useThree((s) => s.camera);
  const left = useXRInputSourceState("controller", "left");
  const {
    cardOpen,
    cardMode,
    setCardMode,
    setBringCard,
    setCardOpen,
    bringCard,
  } = useXrUi(
    useShallow((s) => ({
      cardOpen: s.cardOpen,
      cardMode: s.cardMode,
      setCardMode: s.setCardMode,
      setBringCard: s.setBringCard,
      setCardOpen: s.setCardOpen,
      bringCard: s.bringCard,
    }))
  );
  const [worldSize, setWorldSize] = useState<CardSize>({
    w: TREE_CARD.w,
    h: TREE_CARD.h,
  });
  const world = cardMode === "world";
  const size = world ? worldSize : { w: TREE_CARD.w, h: TREE_CARD.h };
  const movingCad = useXrUi((s) => s.worldGrabbing);
  const dragging = useRef(false);
  const anchor = useRef<THREE.Group>(null);
  const leftRay = useRef<THREE.Object3D>(null);
  const gate = useRef(true);
  const placed = useRef(false);

  const bringHere = useCallback(() => {
    const a = anchor.current;
    if (!a) return;
    placeAtGaze(a, camera, {
      distance: 0.55,
      drop: 0.12,
      side: -0.22,
      face: true,
    });
    placed.current = true;
  }, [camera]);

  useEffect(() => {
    setBringCard(bringHere);
    return () => setBringCard(null);
  }, [bringHere, setBringCard]);

  useEffect(() => {
    if (!session) {
      placed.current = false;
      return;
    }
    if (world && !placed.current) bringHere();
  }, [session, world, bringHere]);

  useFrame(() => {
    const a = anchor.current;
    if (!a || dragging.current) return;
    if (world) {
      a.visible = cardOpen;
      return;
    }
    const ctrl = leftRay.current;
    const src = ctrl ?? wristObject("left");
    if (!src) {
      a.visible = false;
      return;
    }
    src.updateWorldMatrix(true, false);
    tmpM.copy(src.matrixWorld).multiply(ctrl ? CTRL_OFFSET : HAND_OFFSET);
    tmpM.decompose(a.position, a.quaternion, tmpS);
    let shown = true;
    if (!ctrl) {
      const dorsalUp = src.matrixWorld.elements[5];
      gate.current = gate.current ? dorsalUp > 0.15 : dorsalUp > 0.4;
      shown = gate.current;
    }
    a.visible = cardOpen && shown && !movingCad;
  });

  const ctrlSpace = left?.inputSource.targetRaySpace;
  if (!session) return <YToggle />;
  return (
    <>
      <YToggle />
      {ctrlSpace ? <XRSpace ref={leftRay} space={ctrlSpace} /> : null}
      <WorldCard
        ref={anchor}
        visible={false}
        size={size}
        limits={TREE_CARD}
        onSizeChange={setWorldSize}
        resizable={world}
        handle={
          <>
            <HandleButton
              id="card-hide"
              icon={Minus}
              onClick={() => setCardOpen(false)}
            />
            <HandleButton
              id="card-pin"
              icon={world ? PinOff : Pin}
              onClick={() => {
                if (world) setCardMode("wrist");
                else {
                  setCardMode("world");
                  bringCard?.();
                }
              }}
            />
          </>
        }
        onDragStart={() => {
          dragging.current = true;
          if (cardMode !== "wrist") return;
          setCardMode("world");
          placed.current = true;
        }}
        onDragEnd={() => {
          dragging.current = false;
        }}
      >
        {cardOpen ? <CardPanels width={size.w} height={size.h} /> : null}
      </WorldCard>
    </>
  );
}
