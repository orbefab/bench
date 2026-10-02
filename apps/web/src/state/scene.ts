import type { Group, Object3D, Vector3 } from "three";
import { useStore as useZustandStore } from "zustand";
import { createStore } from "zustand/vanilla";

export type SceneCrash = { error: unknown; reset: () => void };

export type SceneState = {
  placed: Group | null;
  fit: ((obj: Object3D, dir?: Vector3) => void) | null;
  setPlaced: (group: Group | null) => void;
  setFit: (fit: ((obj: Object3D, dir?: Vector3) => void) | null) => void;
  bumpScale: (factor: number) => void;
  resetScale: () => void;
  /** Uniform scale of `placed`, mirrored here so UI can show it. */
  modelScale: number;
  setModelScale: (scale: number) => void;
  /** Re-places the model in front of the wearer at 1:1; registered by the scene. */
  recenter: (() => void) | null;
  setRecenter: (fn: (() => void) | null) => void;
  /** Canvas island crash; Overlay paints the card so chat and the rail stay up. */
  sceneCrash: SceneCrash | null;
  setSceneCrash: (next: SceneCrash | null) => void;
};

/**
 * Live scene handles. UI subscribes (`modelScale`, `fit`, `sceneCrash`) and
 * the frame loop reads `placed` on demand, so this is a store. Not persisted.
 */
export const sceneStore = createStore<SceneState>()((set, get) => ({
  placed: null,
  fit: null,
  setPlaced: (placed) => set({ placed }),
  setFit: (fit) => set({ fit }),
  bumpScale: (factor) => {
    const g = get().placed;
    if (!g) return;
    const next = Math.max(0.15, Math.min(8, g.scale.x * factor));
    g.scale.setScalar(next);
    set({ modelScale: next });
  },
  resetScale: () => {
    get().placed?.scale.setScalar(1);
    set({ modelScale: 1 });
  },
  modelScale: 1,
  setModelScale: (scale) => {
    if (get().modelScale !== scale) set({ modelScale: scale });
  },
  recenter: null,
  setRecenter: (recenter) => set({ recenter }),
  sceneCrash: null,
  setSceneCrash: (sceneCrash) => set({ sceneCrash }),
}));

export function useScene<T>(selector: (state: SceneState) => T): T {
  return useZustandStore(sceneStore, selector);
}
