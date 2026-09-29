/**
 * One live store, one socket. A part tab switch saves that client
 * state and restores the target's. Parked tabs hold no socket.
 */

import { useSyncExternalStore } from "react";

import { sendWorldCommand } from "@/hooks/useWorldRun";
import { syncOpenDocument } from "@/lib/document-query";
import { requestRefreshFiles } from "@/lib/motion";
import { parkGuard, parkOutcome, runPhase } from "@/lib/world-park";
import {
  closePartTab,
  emptyPartTabSnapshot,
  emptyPartTabs,
  openPartCrumb,
  openPartTab,
  type PartTabSnapshot,
  type PartTabsModel,
  partTabLabel,
  renamePartTab,
  retargetPartFile,
  savePartTab,
  worldPathAfterMove,
} from "@/lib/world-part-tabs";
import { captureWorldCamera, restoreWorldCamera } from "@/scene/world-camera";
import { viewerStore } from "@/state/viewer";
import { worldStore } from "@/state/world";
import { probedPorts, setProbes } from "@/state/world-probe";
import {
  resetTimeline,
  restoreTimeline,
  worldTimelineSnapshot,
} from "@/state/world-timeline";
import { treeFold, writeTreeFold } from "@/state/world-tree-fold";

export type PartTabOrigin = "sidebar" | "open-part" | "crumb" | "boot" | "pop";

type ShowAction = {
  kind: "show";
  file: string;
  origin: PartTabOrigin;
  name?: string;
  instance?: string;
  history: "push" | "replace";
  force?: boolean;
};

type CloseAction = {
  kind: "close";
  file: string;
};

type PendingPark = ShowAction | CloseAction;

type PartTabSession = {
  model: PartTabsModel;
  pending: PendingPark | null;
};

const listeners = new Set<() => void>();

let session: PartTabSession = {
  model: emptyPartTabs(),
  pending: null,
};

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSession(): PartTabSession {
  return session;
}

export function usePartTabs(): PartTabSession {
  return useSyncExternalStore(subscribe, getSession, getSession);
}

function setSession(next: PartTabSession) {
  session = next;
  emit();
}

/**
 * A6 sets a capture in flight by replacing this. It is false until then,
 * so a capture does not block parking yet.
 */
function captureInFlight(): boolean {
  return false;
}

export function phaseNow() {
  const hud = worldStore.getState();
  const strip = worldTimelineSnapshot();
  const started =
    hud.simTime > 0 ||
    (strip.recording !== null && strip.recording.to > strip.recording.from);
  return runPhase({ playing: hud.playing, started });
}

function liveSnapshot(): PartTabSnapshot {
  const hud = worldStore.getState();
  const strip = worldTimelineSnapshot();
  const fold = treeFold();
  const worth =
    strip.recording !== null &&
    (strip.recording.to > strip.recording.from ||
      strip.playhead !== null ||
      (strip.data?.tracks.length ?? 0) > 0 ||
      strip.previous);
  const timeline = worth
    ? {
        from: strip.recording?.from ?? 0,
        to: strip.recording?.to ?? 0,
        playhead: strip.playhead,
        recording: strip.recording,
        data: strip.data,
        frame: strip.frame,
      }
    : null;
  return {
    selection: hud.selection
      ? {
          path: hud.selection.path,
          ...(hud.selection.link ? { link: hud.selection.link } : {}),
        }
      : null,
    wire: hud.wire,
    collapsed: [...fold.collapsed],
    seeded: fold.seededPath === hud.path && hud.path !== "",
    camera: captureWorldCamera(),
    timeline,
    probes: [...probedPorts()],
    history: hud.history,
  };
}

function saveFocused() {
  const file = worldStore.getState().path;
  if (!file) return;
  if (!session.model.tabs.some((tab) => tab.file === file)) return;
  setSession({
    ...session,
    model: savePartTab(session.model, file, liveSnapshot()),
  });
}

function held(snap: PartTabSnapshot): boolean {
  return (
    snap.seeded ||
    snap.timeline !== null ||
    snap.selection !== null ||
    snap.wire !== null ||
    snap.collapsed.length > 0 ||
    snap.camera !== null ||
    snap.probes.length > 0 ||
    snap.history.parts.length > 0
  );
}

function activate(file: string, history: "push" | "replace") {
  const snap =
    session.model.tabs.find((tab) => tab.file === file)?.snapshot ??
    emptyPartTabSnapshot();
  const keep = held(snap);
  viewerStore.getState().clearForDocument();
  worldStore.getState().open(file, { force: true });
  if (!keep) {
    writeTreeFold({ collapsed: new Set(), seededPath: null });
    restoreWorldCamera(null);
    resetTimeline();
  } else {
    writeTreeFold({
      collapsed: new Set(snap.collapsed),
      seededPath: snap.seeded ? file : null,
    });
    worldStore.getState().replaceHistory(snap.history);
    if (snap.selection) {
      worldStore.getState().select({
        kind: "instance",
        path: snap.selection.path,
        ...(snap.selection.link ? { link: snap.selection.link } : {}),
      });
    }
    if (snap.wire) worldStore.getState().selectWire(snap.wire);
    if (snap.camera) restoreWorldCamera(snap.camera);
    else restoreWorldCamera(null);
    setProbes(snap.probes);
    const timeline = snap.timeline;
    if (timeline?.recording) {
      restoreTimeline({
        recording: timeline.recording,
        data: timeline.data ?? null,
        playhead: timeline.playhead,
        frame: timeline.frame ?? null,
        previous: true,
      });
    } else {
      resetTimeline();
    }
  }
  syncOpenDocument({ kind: "world", path: file }, history);
}

function commitShow(action: ShowAction) {
  const current = session.model.focused;
  if (current && current !== action.file) saveFocused();
  const parent =
    action.origin === "open-part" && current
      ? { file: current, instance: action.instance ?? "" }
      : null;
  let model = session.model;
  if (action.origin === "crumb") {
    model = openPartCrumb(model, action.file);
  } else {
    model = openPartTab(model, {
      file: action.file,
      ...(action.name ? { name: action.name } : {}),
      parent,
    });
  }
  const created = !session.model.tabs.some((tab) => tab.file === action.file);
  setSession({ model, pending: null });
  if (action.force && action.file === current) {
    worldStore.getState().open(action.file, { force: true });
    syncOpenDocument({ kind: "world", path: action.file }, action.history);
    return;
  }
  const already =
    created &&
    !action.force &&
    worldStore.getState().path === action.file &&
    worldStore.getState().connection !== "idle";
  if (already) {
    syncOpenDocument({ kind: "world", path: action.file }, action.history);
    return;
  }
  activate(action.file, action.history);
}

function commitClose(file: string) {
  const focused = session.model.focused;
  if (focused === file) saveFocused();
  const model = closePartTab(session.model, file);
  setSession({ model, pending: null });
  if (focused !== file) return;
  if (!model.focused) {
    viewerStore.getState().clearForDocument();
    worldStore.getState().close();
    writeTreeFold({ collapsed: new Set(), seededPath: null });
    restoreWorldCamera(null);
    resetTimeline();
    syncOpenDocument({ kind: "none" }, "replace");
    return;
  }
  activate(model.focused, "replace");
}

function needsAsk(): boolean {
  return parkGuard(phaseNow(), captureInFlight()) === "ask";
}

/** Follow a renamed part file. The focused tab reconnects at `to`. */
export function retargetOpenPart(from: string, to: string) {
  const before = session.model;
  const model = retargetPartFile(before, from, to);
  if (model === before) return;
  setSession({ ...session, model });
  requestRefreshFiles();
  const world = worldStore.getState().path;
  const next = worldPathAfterMove(world, from, to);
  if (next === world) return;
  worldStore.getState().retargetDocument(next);
  syncOpenDocument({ kind: "world", path: next }, "replace");
}

export function showPartFile(
  file: string,
  opts?: {
    origin?: PartTabOrigin;
    name?: string;
    instance?: string;
    history?: "push" | "replace";
    force?: boolean;
  }
) {
  const origin = opts?.origin ?? "sidebar";
  const history = opts?.history ?? (origin === "sidebar" ? "push" : "replace");
  const action: ShowAction = {
    kind: "show",
    file,
    origin,
    ...(opts?.name ? { name: opts.name } : {}),
    ...(opts?.instance ? { instance: opts.instance } : {}),
    history,
    ...(opts?.force ? { force: true } : {}),
  };
  const focused = session.model.focused ?? worldStore.getState().path;
  if (
    !opts?.force &&
    focused === file &&
    session.model.tabs.some((tab) => tab.file === file)
  ) {
    return;
  }
  if (!focused || origin === "boot" || origin === "pop") {
    if (origin === "pop" && focused && focused !== file && needsAsk()) {
      sendWorldCommand("pause");
    }
    commitShow(action);
    return;
  }
  if (focused !== file && needsAsk()) {
    setSession({ ...session, pending: action });
    return;
  }
  commitShow(action);
}

export function closePartFile(file: string) {
  const action: CloseAction = { kind: "close", file };
  if (session.model.focused === file && needsAsk()) {
    setSession({ ...session, pending: action });
    return;
  }
  commitClose(file);
}

export function stayPartPark() {
  if (!session.pending) return;
  setSession({ ...session, pending: null });
}

export function stopPartPark() {
  const pending = session.pending;
  if (!pending) return;
  if (parkOutcome("stop") !== "stop-and-continue") return;
  sendWorldCommand("pause");
  if (pending.kind === "close") commitClose(pending.file);
  else commitShow(pending);
}

export function notePartTabName(file: string, partId: string) {
  const name = partTabLabel(partId.includes("/") ? `${partId}.json` : partId);
  const model = renamePartTab(session.model, file, name);
  if (model === session.model) return;
  setSession({ ...session, model });
}
