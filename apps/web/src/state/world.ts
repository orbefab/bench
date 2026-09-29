import type {
  EditOp,
  RunReport,
  WorldBoardState,
  WorldError,
  WorldPartState,
  WorldPinState,
  WorldSender,
  WorldState,
  WorldSupplyState,
  WorldViewTree,
} from "@sfab-bench/contract";
import { useStore as useZustandStore } from "zustand";
import { createStore } from "zustand/vanilla";

import { readOpenDocument } from "@/lib/document-query";
import { projectUrl } from "@/lib/project-query";
import {
  applyHistory,
  emptyHistory,
  type HistoryAnswer,
  type HistoryModel,
  refuseHistory,
  sameHistory,
  syncHistories,
} from "@/lib/world-history";
import type { AssetIssue } from "@/lib/world-issues";
import type { WorldOutline } from "@/lib/world-outline";
import { findViewNode, viewPaths } from "@/lib/world-tree";

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

export function sameWorldSelection(
  a: WorldSelection,
  b: WorldSelection
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.path === b.path && (a.link ?? "") === (b.link ?? "");
}

/** Select, drop on close, or keep a selection only when the reload still has its path. */
export function reduceWorldSelection(
  selection: WorldSelection,
  action: WorldSelectionAction
): WorldSelection {
  if (action.type === "close") return null;
  if (action.type === "select") {
    return sameWorldSelection(selection, action.selection)
      ? selection
      : action.selection;
  }
  if (!selection) return null;
  return action.paths.includes(selection.path) ? selection : null;
}

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

function keptWire(
  tree: WorldViewTree,
  wire: WorldWirePick | null
): WorldWirePick | null {
  if (!wire) return null;
  const node = findViewNode(tree.nodes, wire.owner);
  const count = node?.wires?.length ?? 0;
  if (wire.index < 0 || wire.index >= count) return null;
  return wire;
}

function initialPath(): string {
  if (typeof window === "undefined" || !projectUrl()) return "";
  const doc = readOpenDocument(window.location.search);
  return doc.kind === "world" ? doc.path : "";
}

const path = initialPath();

/** Latest physics snapshot. The frame loop reads this. */
let live: WorldState | null = null;

export function worldLiveState(): WorldState | null {
  return live;
}

export function setWorldLiveState(state: WorldState | null) {
  live = state;
}

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
    live = null;
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
    live = null;
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
  select: (selection) => {
    const next = reduceWorldSelection(get().selection, {
      type: "select",
      selection,
    });
    if (next === get().selection && get().wire === null) return;
    set({ selection: next, wire: null, editError: null });
  },
  selectWire: (wire) => {
    if (!wire) {
      if (get().wire === null) return;
      set({ wire: null });
      return;
    }
    set({ wire, selection: null, editError: null });
  },
  setOutline: (outline) => {
    set({ outline });
  },
  setTree: (tree) => {
    const current = get();
    if (current.tree === tree) return;
    const paths = tree ? viewPaths(tree.nodes) : null;
    const selection =
      paths === null
        ? current.selection
        : reduceWorldSelection(current.selection, { type: "reload", paths });
    const wire = selection || !tree ? null : keptWire(tree, current.wire);
    set({ tree, selection, wire });
  },
  setDiagnostics: (diagnostics) => {
    const current = get().diagnostics;
    if (
      current.length === diagnostics.length &&
      current.every(
        (row, index) =>
          row.path === diagnostics[index]?.path &&
          row.code === diagnostics[index]?.code &&
          row.message === diagnostics[index]?.message
      )
    ) {
      return;
    }
    set({ diagnostics });
  },
  setEditError: (message) => {
    if (get().editError === message) return;
    set({ editError: message });
  },
  setConfirm: (confirm) => {
    set({ confirm });
  },
  requestRename: () => {
    set((state) => ({ renameTick: state.renameTick + 1 }));
  },
  applyHistory: (answer, label) => {
    const history = applyHistory(get().history, answer);
    const current = get();
    if (
      sameHistory(current.history, history) &&
      current.editLabel === label &&
      current.editError === null &&
      current.confirm === null
    ) {
      return;
    }
    set({ history, editLabel: label, editError: null, confirm: null });
  },
  refuseHistory: (kind, part) => {
    set({ history: refuseHistory(get().history, kind, part) });
  },
  replaceHistory: (history) => {
    if (sameHistory(get().history, history)) return;
    set({ history, editLabel: null, editError: null, confirm: null });
  },
  syncHistory: (rows) => {
    if (!rows) return;
    const history = syncHistories(get().history, rows);
    if (sameHistory(get().history, history)) return;
    set({ history });
  },
  setSignals: (joints, pins, parts) => {
    const current = get();
    if (
      sameJoints(current.joints, joints) &&
      samePins(current.pins, pins) &&
      sameParts(current.parts, parts)
    ) {
      return;
    }
    set({ joints, pins, parts });
  },
  noteReload: () => set((s) => ({ revision: s.revision + 1, report: null })),
  setReport: (report) => {
    if (get().report === report) return;
    set({ report });
  },
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
  setBoards: (boards) => {
    const current = get().boards;
    const keys = Object.keys(boards);
    const prev = Object.keys(current);
    if (
      keys.length === prev.length &&
      keys.every((key) => {
        const next = boards[key];
        const old = current[key];
        return (
          next !== undefined &&
          old !== undefined &&
          next.running === old.running &&
          next.fault === old.fault &&
          next.unpowered === old.unpowered &&
          next.brownout === old.brownout &&
          next.resets === old.resets &&
          next.voltage === old.voltage &&
          next.ledCurrent === old.ledCurrent &&
          sameLeds(next.leds, old.leds) &&
          next.warnings?.[0]?.message === old.warnings?.[0]?.message
        );
      })
    ) {
      return;
    }
    set({ boards });
  },
  setSupplies: (supplies) => {
    if (sameSupplies(get().supplies, supplies)) return;
    set({ supplies });
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
}));

function sameJoints(
  a: Record<string, Record<string, number>>,
  b: Record<string, Record<string, number>>
): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const robot of aKeys) {
    const left = a[robot];
    const right = b[robot];
    if (!left || !right) return false;
    const names = Object.keys(left);
    if (names.length !== Object.keys(right).length) return false;
    for (const name of names) {
      if (left[name] !== right[name]) return false;
    }
  }
  return true;
}

function sameParts(
  a: Record<string, WorldPartState>,
  b: Record<string, WorldPartState>
): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const id of keys) {
    const left = a[id];
    const right = b[id];
    if (
      !left ||
      !right ||
      left.pulseUs !== right.pulseUs ||
      left.commandDeg !== right.commandDeg ||
      left.state !== right.state ||
      left.current !== right.current ||
      left.voltage !== right.voltage ||
      left.distanceM !== right.distanceM ||
      left.echoS !== right.echoS ||
      left.hit !== right.hit
    ) {
      return false;
    }
  }
  return true;
}

function sameLeds(
  a: Record<string, number> | undefined,
  b: Record<string, number> | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

function sameSupplies(
  a: Record<string, WorldSupplyState>,
  b: Record<string, WorldSupplyState>
): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const id of keys) {
    const left = a[id];
    const right = b[id];
    if (
      !left ||
      !right ||
      left.voltage !== right.voltage ||
      left.current !== right.current
    ) {
      return false;
    }
  }
  return true;
}

function samePins(
  a: Record<string, WorldPinState>,
  b: Record<string, WorldPinState>
): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const id of keys) {
    const left = a[id];
    const right = b[id];
    if (
      !left ||
      !right ||
      left.ddr !== right.ddr ||
      left.level !== right.level ||
      left.toggled !== right.toggled
    ) {
      return false;
    }
  }
  return true;
}

export function useWorld<T>(selector: (state: WorldHudState) => T): T {
  return useZustandStore(worldStore, selector);
}

export type { WorldSender };
