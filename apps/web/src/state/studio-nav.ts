import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

import { projectUrl } from "@/lib/project-query";

type StudioNav = {
  /** Home grid, even when a folder stays open in this tab. */
  atHome: boolean;
  showHome: () => void;
  showStudio: () => void;
};

export const studioNavStore = createStore<StudioNav>((set) => ({
  atHome: projectUrl() === "",
  showHome: () => set({ atHome: true }),
  showStudio: () => set({ atHome: false }),
}));

export function useStudioNav<T>(selector: (state: StudioNav) => T): T {
  return useStore(studioNavStore, selector);
}
