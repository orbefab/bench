import { treeTops } from "@/cad/tree";
import type { ViewerSnapshot } from "@/lib/viewer-snapshot";
import { emptySnapshot } from "@/lib/viewer-snapshot";
import { viewerStore } from "@/state/viewer";
import { type WorldSelection, worldLiveState, worldStore } from "@/state/world";

/**
 * What get_viewer reports for this client's world selection.
 * Undefined when no world is open, so a CAD snapshot stays unchanged.
 */
export function worldViewerSelection(
  worldOpen: boolean,
  selection: WorldSelection
): WorldSelection | undefined {
  if (!worldOpen) return undefined;
  return selection;
}

export function viewerSnapshot(): ViewerSnapshot {
  const world = worldStore.getState();
  if (world.path) {
    const live = worldLiveState();
    return {
      file: world.path,
      empty: false,
      selected: null,
      selectedName: null,
      tree: [],
      partCount: 0,
      playing: live?.playing ?? world.playing,
      simTime: live?.simTime ?? world.simTime,
      selection: worldViewerSelection(true, world.selection),
    };
  }
  const s = viewerStore.getState();
  const file = s.url;
  if (!file || !s.review) return emptySnapshot(file);
  const review = s.review;
  const part = s.selectedId !== null ? review.parts[s.selectedId] : undefined;
  const tree = treeTops(review).map((obj) => {
    const item = review.partByObject.get(obj);
    return { name: item?.name ?? obj.name, ref: item?.cadRef };
  });
  return {
    file,
    empty: false,
    selected: s.pickedRef ?? part?.cadRef ?? null,
    selectedName: part?.name ?? null,
    tree,
    partCount: review.parts.length,
  };
}
