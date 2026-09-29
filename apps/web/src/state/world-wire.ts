/**
 * The Wire tool's own state: the first port of a wire, held until the second
 * is picked. The generic tool state (`state/world-tool.ts`) knows nothing of
 * it beyond the gesture flag that Esc reads.
 */

import { useStore as useZustandStore } from "zustand";
import { createStore } from "zustand/vanilla";

import { type WireTap, wireCommit, wireStep } from "@/lib/world-wire";
import { invalidateSceneNow } from "@/scene/invalidate";
import { worldStore } from "@/state/world";
import { worldEditStore } from "@/state/world-edit";
import {
  beginToolGesture,
  commitToolEdit,
  endToolGesture,
  worldToolStore,
} from "@/state/world-tool";

type WireStore = { from: string | null };

export const wireStore = createStore<WireStore>()(() => ({ from: null }));

export function useWireHeld(): string | null {
  return useZustandStore(wireStore, (s) => s.from);
}

function holdWire(ref: string) {
  wireStore.setState({ from: ref });
  beginToolGesture(() => wireStore.setState({ from: null }));
}

function dropWire() {
  wireStore.setState({ from: null });
  endToolGesture();
}

function stepWire(tap: WireTap) {
  const held = wireStore.getState().from;
  if (worldToolStore.getState().mode !== "wire" || worldEditStore.getState().pending) {
    return;
  }
  const next = wireStep(held, tap);
  if (next.hold !== held) {
    if (next.hold === null) dropWire();
    else holdWire(next.hold);
  }
  if (next.commit) {
    commitToolEdit(wireCommit(next.commit, worldStore.getState().path));
  }
}

/** A click on a port marker: the first port holds, the second commits. */
export function tapWirePort(ref: string) {
  stepWire({ type: "port", ref });
}

/** A click on anything that is not a port lets go of a held first port. */
export function tapWireEmpty() {
  if (wireStore.getState().from === null) return;
  stepWire({ type: "empty" });
}

// The canvas draws on demand: a held port let go must ask for a frame, or
// the rubber band stays on screen.
wireStore.subscribe((state, prev) => {
  if (state.from !== prev.from) invalidateSceneNow();
});
