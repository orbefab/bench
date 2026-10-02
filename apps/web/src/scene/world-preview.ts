import type { Pose } from "@sfab-bench/contract";

import { invalidateSceneNow } from "@/scene/invalidate";

/**
 * A drag previews on the stage and sends one edit on release. Each drawn
 * instance registers here under its run path. `set(pose)` moves what it
 * draws; `set(null)` puts it back where the document has it.
 */
export type PreviewEntry = { set: (pose: Pose | null) => void };

const entries = new Map<string, Set<PreviewEntry>>();

export function registerPreview(path: string, entry: PreviewEntry) {
  let set = entries.get(path);
  if (!set) {
    set = new Set();
    entries.set(path, set);
  }
  set.add(entry);
  return () => {
    set.delete(entry);
    if (set.size === 0 && entries.get(path) === set) entries.delete(path);
  };
}

export function previewPose(path: string, pose: Pose | null) {
  for (const entry of entries.get(path) ?? []) entry.set(pose);
  invalidateSceneNow();
}

export function clearPreviews() {
  for (const set of entries.values()) {
    for (const entry of set) entry.set(null);
  }
  invalidateSceneNow();
}
