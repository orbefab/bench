/**
 * The ports this tab probes. Client state only: nothing is persisted, and a
 * part tab saves and restores the list with its other state
 * (`state/part-tabs.ts`).
 */

import { useStore as useZustandStore } from "zustand";
import { createStore } from "zustand/vanilla";

import { toggleProbe } from "@/lib/world-probe";
import { invalidateSceneNow } from "@/scene/invalidate";
import { worldStore } from "@/state/world";

type WorldProbeStore = { ports: readonly string[] };

export const probeStore = createStore<WorldProbeStore>()(() => ({ ports: [] }));

export function useProbes(): readonly string[] {
  return useZustandStore(probeStore, (s) => s.ports);
}

export function probedPorts(): readonly string[] {
  return probeStore.getState().ports;
}

export function toggleProbePort(id: string) {
  probeStore.setState((s) => ({ ports: toggleProbe(s.ports, id) }));
}

export function setProbes(ports: readonly string[]) {
  probeStore.setState({ ports: [...ports] });
}

export function clearProbes() {
  if (probeStore.getState().ports.length === 0) return;
  probeStore.setState({ ports: [] });
}

// The canvas draws on demand: a marker gaining or losing its mark needs a frame.
probeStore.subscribe((state, prev) => {
  if (state.ports !== prev.ports) invalidateSceneNow();
});

let watchedPath = worldStore.getState().path;
worldStore.subscribe((state) => {
  if (state.path === watchedPath) return;
  watchedPath = state.path;
  clearProbes();
});
