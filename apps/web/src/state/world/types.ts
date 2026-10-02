import type {
  EditOp,
  RunReport,
  WorldBoardState,
  WorldError,
  WorldPartState,
  WorldPinState,
  WorldSupplyState,
  WorldViewTree,
} from "@sfab-bench/contract";
import type { StoreApi } from "zustand/vanilla";

import type { HistoryAnswer, HistoryModel } from "@/lib/world-history";
import type { AssetIssue } from "@/lib/world-issues";
import type { WorldOutline } from "@/lib/world-outline";

/**
 * The open world document and the low-rate HUD. Poses live in
 * `worldLiveState`, not here: a 30 Hz state must not render React.
 */
export type WorldConnection = "idle" | "connecting" | "live" | "reconnecting";

/** Per client. The shared run does not carry this (D-015). */
export type WorldSelection = {
  kind: "instance";
  /** Run path. The same id as a tree row and a report level. */
  path: string;
  /** Set when the pick is one link of a robot. */
  link?: string;
} | null;

/** A wire row. Not part of the agent selection. */
export type WorldWirePick = {
  owner: string;
  index: number;
};

export type WorldConfirm = {
  count: number;
  ports: { name: string; dependents: string[] }[];
  message: string;
  ops: EditOp[];
  part?: string;
  label?: string;
};

export type WorldSelectionAction =
  | { type: "select"; selection: WorldSelection }
  | { type: "close" }
  | { type: "reload"; paths: readonly string[] };

export type WorldHudState = {
  path: string;
  /** Bumped on an explicit reopen so a failed load can be retried. */
  loadId: number;
  /** Bumped when the server says the document changed on disk. */
  revision: number;
  playing: boolean;
  simTime: number;
  boards: Record<string, WorldBoardState>;
  connection: WorldConnection;
  /** Short "Paused by …" line. The attach snapshot does not set this. */
  notice: string | null;
  runErrors: WorldError[];
  runMessage: string | null;
  assetIssues: AssetIssue[];
  /** True once a scene has been built. A later error keeps that scene. */
  sceneReady: boolean;
  assets: "idle" | "loading" | "ready" | "error";
  /** This client's pick. Not part of the shared run. */
  selection: WorldSelection;
  /** Links, joints, and boards for the inspector. Null until the file loads. */
  outline: WorldOutline | null;
  /** Joint positions in radians, copied at the HUD rate. */
  joints: Record<string, Record<string, number>>;
  /** Pin masks, copied at the HUD rate. */
  pins: Record<string, WorldPinState>;
  /** Servo pulse and command, copied at the HUD rate. */
  parts: Record<string, WorldPartState>;
  /** Supply voltage and current, copied with each state. */
  supplies: Record<string, WorldSupplyState>;
  /**
   * Run report that arrived with a state. A late joiner gets the same
   * object from the host's snapshot. Ordinary states leave it in place.
   */
  report: RunReport | null;
  /** Part tree from the world view. Null until the file loads. */
  tree: WorldViewTree | null;
  /** Degraded rows on the latest state. Empty when the state omits them. */
  diagnostics: { path: string; message: string; code: string }[];
  /** Wire row. Mutually exclusive with `selection`. */
  wire: WorldWirePick | null;
  /** Server undo flags, and which part the next undo or redo names. */
  history: HistoryModel;
  editLabel: string | null;
  /** The loader's refusal of the last edit. */
  editError: string | null;
  confirm: WorldConfirm | null;
  /** Bumped when F2 asks the tree to rename the selection. */
  renameTick: number;
  open: (path: string, opts?: { force?: boolean }) => void;
  /** The open file moved. Reconnects without clearing this tab's history. */
  retargetDocument: (path: string) => void;
  close: () => void;
  select: (selection: WorldSelection) => void;
  selectWire: (wire: WorldWirePick | null) => void;
  /** Replace the outline. Selection follows the tree, not this list. */
  setOutline: (outline: WorldOutline) => void;
  /** Replace the tree and keep a selection whose path is still there. */
  setTree: (tree: WorldViewTree | null) => void;
  setDiagnostics: (
    diagnostics: { path: string; message: string; code: string }[]
  ) => void;
  setEditError: (message: string | null) => void;
  setConfirm: (confirm: WorldConfirm | null) => void;
  requestRename: () => void;
  applyHistory: (answer: HistoryAnswer, label: string) => void;
  refuseHistory: (kind: "undo" | "redo", part?: string) => void;
  /** Put a parked tab's history back. The connect reply then trims it. */
  replaceHistory: (history: HistoryModel) => void;
  syncHistory: (rows: HistoryAnswer["histories"]) => void;
  setSignals: (
    joints: Record<string, Record<string, number>>,
    pins: Record<string, WorldPinState>,
    parts: Record<string, WorldPartState>
  ) => void;
  noteReload: () => void;
  setConnection: (connection: WorldConnection) => void;
  setRun: (playing: boolean, simTime: number) => void;
  setBoards: (boards: Record<string, WorldBoardState>) => void;
  setSupplies: (supplies: Record<string, WorldSupplyState>) => void;
  setReport: (report: RunReport | null) => void;
  setRunProblem: (errors: WorldError[], message?: string | null) => void;
  clearRunProblem: () => void;
  setNotice: (notice: string | null) => void;
  setAssetIssues: (issues: AssetIssue[]) => void;
  setAssets: (assets: WorldHudState["assets"], sceneReady?: boolean) => void;
};

/** What a slice creator gets: the store's own `set` and `get`. */
export type WorldSet = StoreApi<WorldHudState>["setState"];
export type WorldGet = StoreApi<WorldHudState>["getState"];

/** A slice returns only the members it owns; the store merges them. */
export type WorldSlice<K extends keyof WorldHudState> = (
  set: WorldSet,
  get: WorldGet
) => Pick<WorldHudState, K>;
