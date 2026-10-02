import type { WorldState } from "@sfab-bench/contract";

/** Latest physics snapshot. The frame loop reads this. */
let live: WorldState | null = null;

export function worldLiveState(): WorldState | null {
  return live;
}

export function setWorldLiveState(state: WorldState | null) {
  live = state;
}
