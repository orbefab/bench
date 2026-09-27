import type {
  RunReport,
  WorldBoardState,
  WorldError,
  WorldPartState,
  WorldPinState,
  WorldSender,
  WorldState,
  WorldSupplyState,
} from "@sfab-bench/contract";
import { useStore as useZustandStore } from "zustand";
import { createStore } from "zustand/vanilla";

import { readOpenDocument } from "@/lib/document-query";
import { projectUrl } from "@/lib/project-query";
import type { AssetIssue } from "@/lib/world-issues";
import { outlineItems, type WorldOutline } from "@/lib/world-outline";

/**
 * The open world document and the low-rate HUD. Poses live in
 * `worldLiveState`, not here: a 30 Hz state must not render React.
 */
export type WorldConnection = "idle" | "connecting" | "live" | "reconnecting";

/** Per client. The shared run does not carry this (D-015). */
export type WorldSelection =
  | { kind: "link"; robot: string; link: string }
  | { kind: "board"; board: string }
  | { kind: "part"; part: string }
  | { kind: "supply"; supply: string }
  | null;

export type WorldSelectionAction =
  | { type: "select"; selection: WorldSelection }
  | { type: "close" }
  | {
      type: "reload";
      links: readonly { robot: string; link: string }[];
      boards: readonly string[];
      parts: readonly string[];
      supplies: readonly string[];
    };

export function sameWorldSelection(
  a: WorldSelection,
  b: WorldSelection
): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "board" && b.kind === "board") return a.board === b.board;
  if (a.kind === "part" && b.kind === "part") return a.part === b.part;
  if (a.kind === "supply" && b.kind === "supply") return a.supply === b.supply;
  return a.kind === "link" && b.kind === "link"
    ? a.robot === b.robot && a.link === b.link
    : false;
}

/** Select, drop on close, or keep a selection only when the reload still has it. */
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
  if (selection.kind === "board") {
    return action.boards.includes(selection.board) ? selection : null;
  }
  if (selection.kind === "part") {
    return action.parts.includes(selection.part) ? selection : null;
  }
  if (selection.kind === "supply") {
    return action.supplies.includes(selection.supply) ? selection : null;
  }
  const kept = action.links.some(
    (item) => item.robot === selection.robot && item.link === selection.link
  );
  return kept ? selection : null;
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
  open: (path: string, opts?: { force?: boolean }) => void;
  close: () => void;
  select: (selection: WorldSelection) => void;
  /** Replace the outline and drop a selection the new document no longer has. */
  setOutline: (outline: WorldOutline) => void;
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
    if (next === get().selection) return;
    set({ selection: next });
  },
  setOutline: (outline) => {
    const items = outlineItems(outline);
    set({
      outline,
      selection: reduceWorldSelection(get().selection, {
        type: "reload",
        links: items.links,
        boards: items.boards,
        parts: items.parts,
        supplies: items.supplies,
      }),
    });
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
