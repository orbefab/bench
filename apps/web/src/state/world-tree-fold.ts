/**
 * The part tree's fold, outside the component so a part tab can
 * save it and put it back.
 */

import { useSyncExternalStore } from "react";

export type TreeFold = {
  collapsed: ReadonlySet<string>;
  seededPath: string | null;
};

const listeners = new Set<() => void>();

let fold: TreeFold = { collapsed: new Set(), seededPath: null };

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function treeFold(): TreeFold {
  return fold;
}

export function useTreeFold(): TreeFold {
  return useSyncExternalStore(subscribe, treeFold, treeFold);
}

export function writeTreeFold(next: TreeFold) {
  if (
    next.collapsed === fold.collapsed &&
    next.seededPath === fold.seededPath
  ) {
    return;
  }
  fold = next;
  emit();
}
