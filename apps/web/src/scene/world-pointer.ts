import type { ThreeEvent } from "@react-three/fiber";

import { type PointerOwner, pointerOwner } from "@/lib/world-wire";
import { worldToolStore } from "@/state/world-tool";

/** Set on a port marker's hit mesh so a body handler can tell it is on the ray. */
export const PORT_MARKER_TAG = "portMarker";

/**
 * Who owns the pointer for this event: a body handler returns without
 * stopping the event when a marker does, so the marker behind it gets it.
 */
export function rayOwner(
  event: ThreeEvent<MouseEvent> | ThreeEvent<PointerEvent>
): PointerOwner {
  return pointerOwner(
    worldToolStore.getState().mode,
    event.intersections.map((hit) =>
      hit.object.userData[PORT_MARKER_TAG] === true ? "marker" : "body"
    )
  );
}
