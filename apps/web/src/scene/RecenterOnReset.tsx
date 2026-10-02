import { useFrame, useThree } from "@react-three/fiber";
import { useXR } from "@react-three/xr";
import { useEffect, useRef } from "react";

import {
  placeAtGaze,
  XR_CAD_SPAWN_DISTANCE,
  XR_CAD_SPAWN_DROP,
} from "@/scene/SpawnInFront";
import { sceneStore } from "@/state/scene";
import { xrUiStore } from "@/state/xr";

/** Quest hold-Meta recenter fires XRReferenceSpace `reset`. Bring the CAD
 * model and world-locked cards back in front of the wearer. Wrist docks stay put.
 * Unlike the card Recenter button, inspection scale is kept. */
export function RecenterOnReset() {
  const session = useXR((s) => s.session);
  const origin = useXR((s) => s.originReferenceSpace);
  const camera = useThree((s) => s.camera);
  const pending = useRef(0);

  useFrame(() => {
    if (pending.current === 0) return;
    pending.current -= 1;
    if (pending.current > 0) return;
    const placed = sceneStore.getState().placed;
    const xr = xrUiStore.getState();
    if (placed)
      placeAtGaze(placed, camera, {
        distance: XR_CAD_SPAWN_DISTANCE,
        drop: XR_CAD_SPAWN_DROP,
        face: true,
        resetScale: false,
      });
    if (xr.cardOpen && xr.cardMode === "world") xr.bringCard?.();
    xr.bringChat?.();
  });

  useEffect(() => {
    if (!session) return;
    const seen = new Set<XRReferenceSpace>();
    const offs: Array<() => void> = [];
    let cancelled = false;

    const listen = (ref: XRReferenceSpace) => {
      if (seen.has(ref)) return;
      seen.add(ref);
      const onReset = () => {
        // Skip the current XR frame: pose is applied at frame start, and
        // reset can fire after that. Next frame has the new camera.
        pending.current = 2;
      };
      ref.addEventListener("reset", onReset);
      offs.push(() => ref.removeEventListener("reset", onReset));
    };

    if (origin) listen(origin);

    // Three.js may not have published origin yet; the session space still
    // receives Quest's reset. bounded-floor is what `createXRStore({ bounded: true })` uses.
    const trySpace = (type: XRReferenceSpaceType) =>
      session.requestReferenceSpace(type).then((ref) => {
        if (!cancelled && ref) listen(ref);
      });
    void trySpace("local-floor")
      .catch(() => trySpace("local"))
      .catch(() => undefined);
    void trySpace("bounded-floor").catch(() => undefined);

    return () => {
      cancelled = true;
      for (const off of offs) off();
    };
  }, [session, origin]);

  return null;
}
