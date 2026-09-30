import { emptyHistory } from "@/lib/world-history";
import { setWorldLiveState } from "./live";
import { reduceWorldSelection } from "./selection";
import type { WorldSlice } from "./types";

/** Open, close and retarget the document, the connection, the run flag, and the run's problem. */
export const connectionSlice: WorldSlice<
  | "retargetDocument"
  | "open"
  | "close"
  | "noteReload"
  | "setConnection"
  | "setRun"
  | "setRunProblem"
  | "clearRunProblem"
  | "setNotice"
> = (set, get) => ({
  retargetDocument: (next) => {
    const current = get();
    if (!next || current.path === next) return;
    set({ path: next, loadId: current.loadId + 1 });
  },

  open: (next, opts) => {
    const current = get();
    if (
      !opts?.force &&
      current.path === next &&
      current.connection !== "idle"
    ) {
      return;
    }
    const sameDocument = current.path === next && next !== "";
    setWorldLiveState(null);
    set({
      path: next,
      loadId: current.loadId + 1,
      playing: false,
      simTime: 0,
      boards: {},
      connection: "connecting",
      notice: null,
      runErrors: [],
      runMessage: null,
      assetIssues: [],
      sceneReady: false,
      assets: "loading",
      selection: sameDocument
        ? current.selection
        : reduceWorldSelection(current.selection, { type: "close" }),
      outline: sameDocument ? current.outline : null,
      tree: sameDocument ? current.tree : null,
      diagnostics: [],
      wire: sameDocument ? current.wire : null,
      history: sameDocument ? current.history : emptyHistory(),
      editLabel: sameDocument ? current.editLabel : null,
      editError: null,
      confirm: null,
      renameTick: sameDocument ? current.renameTick : 0,
      joints: {},
      pins: {},
      parts: {},
      supplies: {},
      report: null,
    });
  },
  close: () => {
    if (!get().path && get().connection === "idle") return;
    setWorldLiveState(null);
    set({
      path: "",
      playing: false,
      simTime: 0,
      boards: {},
      connection: "idle",
      notice: null,
      runErrors: [],
      runMessage: null,
      assetIssues: [],
      sceneReady: false,
      assets: "idle",
      selection: reduceWorldSelection(get().selection, { type: "close" }),
      outline: null,
      tree: null,
      diagnostics: [],
      wire: null,
      history: emptyHistory(),
      editLabel: null,
      editError: null,
      confirm: null,
      renameTick: 0,
      joints: {},
      pins: {},
      parts: {},
      supplies: {},
      report: null,
    });
  },
  noteReload: () => set((s) => ({ revision: s.revision + 1, report: null })),
  setConnection: (connection) => {
    if (get().connection !== connection) set({ connection });
  },
  setRun: (playing, simTime) => {
    const current = get();
    if (
      current.playing === playing &&
      current.simTime === simTime &&
      current.connection === "live"
    ) {
      return;
    }
    set({ playing, simTime, connection: "live" });
  },
  setRunProblem: (errors, message) =>
    set({
      runErrors: errors,
      runMessage: message?.trim() ? message : null,
      playing: false,
      connection: "live",
    }),
  clearRunProblem: () => {
    const current = get();
    if (current.runErrors.length === 0 && !current.runMessage) return;
    set({ runErrors: [], runMessage: null });
  },
  setNotice: (notice) => {
    if (get().notice !== notice) set({ notice });
  },
});
