import type { WorldSender } from "@sfab-bench/contract";
import { useStore as useZustandStore } from "zustand";
import { createStore } from "zustand/vanilla";

import { readOpenDocument } from "@/lib/document-query";
import { projectUrl } from "@/lib/project-query";
import { emptyHistory } from "@/lib/world-history";
import { assetsSlice } from "./world/assets";
import { connectionSlice } from "./world/connection";
import { historySlice } from "./world/history";
import { selectionSlice } from "./world/selection";
import { signalsSlice } from "./world/signals";
import type { WorldHudState } from "./world/types";

export { setWorldLiveState, worldLiveState } from "./world/live";
export { reduceWorldSelection, sameWorldSelection } from "./world/selection";
export type {
  WorldConfirm,
  WorldConnection,
  WorldHudState,
  WorldSelection,
  WorldSelectionAction,
  WorldWirePick,
} from "./world/types";

function initialPath(): string {
  if (typeof window === "undefined" || !projectUrl()) return "";
  const doc = readOpenDocument(window.location.search);
  return doc.kind === "world" ? doc.path : "";
}

const path = initialPath();

/** The store is one object. Each slice in `world/` owns a group of its members. */
export const worldStore = createStore<WorldHudState>()((set, get) => ({
  path,
  loadId: 0,
  revision: 0,
  playing: false,
  simTime: 0,
  boards: {},
  connection: path ? "connecting" : "idle",
  notice: null,
  runErrors: [],
  runMessage: null,
  assetIssues: [],
  sceneReady: false,
  assets: path ? "loading" : "idle",
  selection: null,
  outline: null,
  joints: {},
  pins: {},
  parts: {},
  supplies: {},
  report: null,
  tree: null,
  diagnostics: [],
  wire: null,
  history: emptyHistory(),
  editLabel: null,
  editError: null,
  confirm: null,
  renameTick: 0,

  ...connectionSlice(set, get),
  ...selectionSlice(set, get),
  ...historySlice(set, get),
  ...signalsSlice(set, get),
  ...assetsSlice(set, get),
}));

export function useWorld<T>(selector: (state: WorldHudState) => T): T {
  return useZustandStore(worldStore, selector);
}

export type { WorldSender };
