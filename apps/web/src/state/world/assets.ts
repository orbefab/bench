import type { WorldSlice } from "./types";

/** The scene's asset load: issues and the loading state. */
export const assetsSlice: WorldSlice<"setAssetIssues" | "setAssets"> = (
  set,
  get
) => ({
  setAssetIssues: (assetIssues) => {
    const current = get().assetIssues;
    if (
      current.length === assetIssues.length &&
      current.every(
        (issue, index) =>
          issue.text === assetIssues[index]?.text &&
          issue.mesh === assetIssues[index]?.mesh
      )
    ) {
      return;
    }
    set({ assetIssues });
  },
  setAssets: (assets, sceneReady) =>
    set((s) => ({
      assets,
      sceneReady: sceneReady ?? s.sceneReady,
    })),
});
