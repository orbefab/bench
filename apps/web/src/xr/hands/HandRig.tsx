import { useXRInputSourceState, XRSpace } from "@react-three/xr";
import { type ReactNode, useCallback } from "react";
import type { Object3D } from "three";

export type Handedness = "left" | "right";

/**
 * The one wrist `Object3D` per side, kept module-level so frame-loop code
 * (XRGrab) can read it without a React subscription. Written by the rig's
 * XRSpace ref and cleared when that hand stops being tracked.
 */
const wrists: Record<Handedness, Object3D | null> = { left: null, right: null };

/** Wrist object of a tracked hand, or `null`. Safe to call inside `useFrame`. */
export function wristObject(handedness: Handedness): Object3D | null {
  return wrists[handedness];
}

/**
 * One wrist `XRSpace` per hand. Everything wrist-mounted renders inside this
 * rig, so `@react-three/xr` resolves each wrist pose once per frame instead of
 * once per consumer. Renders nothing while that hand is not tracked.
 */
export function HandRig({
  handedness,
  children,
}: {
  handedness: Handedness;
  children: ReactNode;
}) {
  const state = useXRInputSourceState("hand", handedness);
  const setWrist = useCallback(
    (object: Object3D | null) => {
      wrists[handedness] = object;
    },
    [handedness]
  );
  const wrist = state?.inputSource.hand?.get("wrist");
  if (!wrist) return null;
  return (
    <XRSpace ref={setWrist} space={wrist}>
      {children}
    </XRSpace>
  );
}
