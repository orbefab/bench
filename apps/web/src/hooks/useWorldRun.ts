import type {
  EditOp,
  WorldPinState,
  WorldSender,
  WorldServerMessage,
  WorldState,
} from "@sfab-bench/contract";
import { useEffect } from "react";

import { showToast } from "@/components/ui/toast";
import { getDeviceToken } from "@/lib/api";
import { editMessageText } from "@/lib/world-edit-message";
import { historyButtons } from "@/lib/world-history";
import { decideHudSample } from "@/lib/world-hud";
import { commandNotice, isOwnCommandNonce } from "@/lib/world-issues";
import { worldLiveSocketUrl } from "@/lib/world-live-url";
import { worldCommandNonce } from "@/lib/world-nonce";
import { worldSocketKey } from "@/lib/world-socket";
import { invalidateSceneNow } from "@/scene/invalidate";
import {
  appendBoardSerial,
  noteBoardReject,
  noteBoardSent,
  resetBoardConsole,
} from "@/state/board-console";
import { retargetOpenPart } from "@/state/part-tabs";
import {
  setWorldLiveState,
  useWorld,
  worldLiveState,
  worldStore,
} from "@/state/world";
import {
  bindWorldSocket,
  goLive,
  noteLiveRecording,
  releasePreviousRun,
  resetTimeline,
  takeFrame,
  takeTimeline,
  takeTimelineError,
} from "@/state/world-timeline";

const SIM_TIME_MS = 200;
const ATTACH_COMMAND_MS = 300;
const NOTICE_MS = 3200;

let socket: WebSocket | null = null;
/** Nonces this tab has sent and not yet seen echoed. */
const sentNonces = new Set<string>();
/** Serial writes this tab sent. A rejection with one of these is ours. */
const sentSerialNonces = new Set<string>();

export function sendWorldCommand(type: "play" | "pause") {
  if (type === "play") {
    releasePreviousRun();
    goLive();
  }
  if (socket?.readyState !== WebSocket.OPEN) return;
  const nonce = worldCommandNonce();
  sentNonces.add(nonce);
  socket.send(JSON.stringify({ type, nonce }));
}

export function sendBoardSerial(board: string, text: string) {
  if (!board || !text || socket?.readyState !== WebSocket.OPEN) return;
  const nonce = worldCommandNonce();
  sentSerialNonces.add(nonce);
  socket.send(JSON.stringify({ type: "serial-send", board, text, nonce }));
}

type PendingEdit = {
  kind: "edit" | "undo" | "redo";
  ops?: EditOp[];
  part?: string;
  label?: string;
};

/** The edit this tab is waiting on. Stay drops it. */
let pendingEdit: PendingEdit | null = null;

function sendSocket(message: unknown) {
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(message));
}

export function sendWorldEdit(edit: {
  ops: EditOp[];
  part?: string;
  label?: string;
  confirm?: "break";
}) {
  if (edit.ops.length === 0) return;
  pendingEdit = {
    kind: "edit",
    ops: edit.ops,
    part: edit.part,
    label: edit.label,
  };
  worldStore.getState().setEditError(null);
  sendSocket({
    type: "edit",
    ops: edit.ops,
    ...(edit.part ? { part: edit.part } : {}),
    ...(edit.label ? { label: edit.label } : {}),
    ...(edit.confirm ? { confirm: edit.confirm } : {}),
  });
}

export function sendWorldUndo() {
  const buttons = historyButtons(worldStore.getState().history);
  if (!buttons.canUndo) return;
  pendingEdit = { kind: "undo", part: buttons.undoPart };
  worldStore.getState().setEditError(null);
  sendSocket({
    type: "undo",
    ...(buttons.undoPart ? { part: buttons.undoPart } : {}),
  });
}

export function sendWorldRedo() {
  const buttons = historyButtons(worldStore.getState().history);
  if (!buttons.canRedo) return;
  pendingEdit = { kind: "redo", part: buttons.redoPart };
  worldStore.getState().setEditError(null);
  sendSocket({
    type: "redo",
    ...(buttons.redoPart ? { part: buttons.redoPart } : {}),
  });
}

/** Stay: the edit is not sent again. */
export function stayWorldEdit() {
  pendingEdit = null;
  worldStore.getState().setConfirm(null);
}

/** Break N: the same operations, with confirm. */
export function breakWorldEdit() {
  const confirm = worldStore.getState().confirm;
  if (!confirm || confirm.ops.length === 0) return;
  sendWorldEdit({
    ops: confirm.ops,
    part: confirm.part,
    label: confirm.label,
    confirm: "break",
  });
}

function senderLabel(by: WorldSender): string {
  return by.kind === "agent" ? "agent" : by.label || "someone";
}

function backoff(attempt: number): number {
  return Math.min(8_000, 400 * 2 ** attempt);
}

function pinsOf(boards: WorldState["boards"]): Record<string, WorldPinState> {
  const pins: Record<string, WorldPinState> = {};
  for (const [id, board] of Object.entries(boards)) {
    if (board.pins) pins[id] = board.pins;
  }
  return pins;
}

/**
 * One socket for the open world. Poses stay in a ref. React hears
 * play state, a throttled sim time, the last remote command, and errors.
 */
export function useWorldRun(project: string, world: string) {
  const loadId = useWorld((s) => s.loadId);
  // revision is intentionally absent: a reload refetches meshes only.
  const socketKey = worldSocketKey({ project, world, loadId });
  useEffect(() => {
    if (!project || !world) return;
    let closed = false;
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let noticeTimer: ReturnType<typeof setTimeout> | null = null;
    let attachTimer: ReturnType<typeof setTimeout> | null = null;
    let lastHud = 0;
    let sawState = false;
    let attachCommand = false;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingHud: WorldState | null = null;
    const hud = worldStore.getState();
    resetBoardConsole();

    const clearAttach = () => {
      if (attachTimer) clearTimeout(attachTimer);
      attachTimer = null;
      attachCommand = false;
    };

    const clearFlush = () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      pendingHud = null;
    };

    const writeHud = (state: WorldState, now: number, simTime: boolean) => {
      const current = worldStore.getState();
      current.setRun(state.playing, simTime ? state.simTime : current.simTime);
      current.setSignals(state.joints, pinsOf(state.boards), state.parts ?? {});
      lastHud = now;
    };

    const publish = (state: WorldState) => {
      setWorldLiveState(state);
      invalidateSceneNow();
      const now = performance.now();
      const current = worldStore.getState();
      current.setBoards(state.boards);
      current.setSupplies(state.supplies ?? {});
      current.setDiagnostics(
        (state.diagnostics ?? []).map((row) => ({
          path: row.path,
          message: row.message,
          code: row.code,
        }))
      );
      const live = current.connection === "live";
      const decision = decideHudSample({
        now,
        lastPublish: lastHud,
        intervalMs: SIM_TIME_MS,
        live,
        playingChanged: live && current.playing !== state.playing,
      });
      if (decision.publishNow) {
        const simTime = !live || now - lastHud >= SIM_TIME_MS;
        clearFlush();
        writeHud(state, now, simTime);
        return;
      }
      // Hold the latest skipped sample and flush it once, at the end of
      // the window opened by the previous write.
      pendingHud = state;
      if (flushTimer !== null || decision.flushAt === null) return;
      const wait = Math.max(0, decision.flushAt - now);
      flushTimer = setTimeout(() => {
        flushTimer = null;
        const latest = pendingHud;
        pendingHud = null;
        if (closed || !latest) return;
        writeHud(latest, performance.now(), true);
      }, wait);
    };

    const showNotice = (text: string) => {
      worldStore.getState().setNotice(text);
      if (noticeTimer) clearTimeout(noticeTimer);
      noticeTimer = setTimeout(() => {
        worldStore.getState().setNotice(null);
      }, NOTICE_MS);
    };

    const onMessage = (raw: string) => {
      let message: WorldServerMessage;
      try {
        message = JSON.parse(raw) as WorldServerMessage;
      } catch {
        return;
      }
      if (message.type === "state") {
        if (!sawState) {
          sawState = true;
          attachCommand = true;
          if (attachTimer) clearTimeout(attachTimer);
          // The attach snapshot's `command` follows `state` immediately.
          // A later command is someone acting, and every client shows it.
          attachTimer = setTimeout(() => {
            attachCommand = false;
          }, ATTACH_COMMAND_MS);
        }
        worldStore.getState().clearRunProblem();
        // The host sends the report on the first state and again when it
        // changes. A late joiner's snapshot includes it. Later states omit it.
        if (message.report) worldStore.getState().setReport(message.report);
        noteLiveRecording(message.state.recording, message.state.playing);
        publish(message.state);
        return;
      }
      if (message.type === "timeline-data") {
        takeTimeline(message);
        return;
      }
      if (message.type === "frame") {
        takeFrame(message);
        return;
      }
      if (message.type === "timeline-error") {
        takeTimelineError(message);
        return;
      }
      if (message.type === "command") {
        const duringAttach = attachCommand;
        if (duringAttach) clearAttach();
        const playing = message.command === "play";
        const live = worldLiveState();
        if (live) setWorldLiveState({ ...live, playing });
        worldStore.getState().setRun(playing, worldStore.getState().simTime);
        const own = isOwnCommandNonce(message.nonce, sentNonces);
        if (message.nonce) sentNonces.delete(message.nonce);
        if (duringAttach || own) return;
        showNotice(commandNotice(message.command, message.by));
        return;
      }
      if (message.type === "reloaded") {
        resetBoardConsole();
        worldStore.getState().noteReload();
        return;
      }
      if (message.type === "serial") {
        appendBoardSerial(message.board, message.text, message.next);
        return;
      }
      if (message.type === "serial-sent") {
        noteBoardSent(message.board, message.text, senderLabel(message.by));
        return;
      }
      if (message.type === "board-error") {
        if (!isOwnCommandNonce(message.nonce, sentSerialNonces)) return;
        if (message.nonce) sentSerialNonces.delete(message.nonce);
        noteBoardReject(message.board, message.message);
        return;
      }
      if (message.type === "needs-confirm") {
        const pending = pendingEdit;
        if (!pending?.ops) return;
        worldStore.getState().setConfirm({
          count: message.count,
          ports: message.ports,
          message: message.message,
          ops: pending.ops,
          part: pending.part,
          label: pending.label,
        });
        return;
      }
      if (message.type === "histories") {
        worldStore.getState().syncHistory(message.histories);
        return;
      }
      if (message.type === "edited") {
        const pending = pendingEdit;
        pendingEdit = null;
        worldStore.getState().applyHistory(
          {
            part: message.part ?? pending?.part,
            canUndo: message.canUndo,
            canRedo: message.canRedo,
            ...(message.histories ? { histories: message.histories } : {}),
          },
          message.label
        );
        if (message.moved) {
          retargetOpenPart(message.moved.from, message.moved.to);
        }
        showNotice(message.label);
        return;
      }
      if (message.type === "error") {
        const pending = pendingEdit;
        const refusal = pending !== null && (message.errors?.length ?? 0) === 0;
        const bare =
          message.message === "nothing to undo" ||
          message.message === "nothing to redo";
        if (refusal || bare) {
          pendingEdit = null;
          worldStore.getState().setConfirm(null);
          const kind =
            pending?.kind === "redo" || message.message === "nothing to redo"
              ? "redo"
              : pending?.kind === "undo" ||
                  message.message === "nothing to undo"
                ? "undo"
                : "edit";
          if (kind === "undo" || kind === "redo") {
            worldStore.getState().refuseHistory(kind, pending?.part);
            showToast({
              type: "info",
              title: kind === "redo" ? "Nothing to redo." : "Nothing to undo.",
            });
          } else {
            worldStore
              .getState()
              .setEditError(
                editMessageText(message.message ?? "The edit was refused.")
              );
          }
          return;
        }
        if (!sawState) resetTimeline();
        const live = worldLiveState();
        if (live) setWorldLiveState({ ...live, playing: false });
        worldStore.getState().setRunProblem(message.errors, message.message);
        invalidateSceneNow();
      }
    };

    const connect = () => {
      if (closed) return;
      sawState = false;
      clearAttach();
      const url = worldLiveSocketUrl({
        pageProtocol: window.location.protocol,
        host: window.location.host,
        project,
        world,
        token: getDeviceToken(),
      });
      const ws = new WebSocket(url);
      socket = ws;
      bindWorldSocket((message) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
      });
      ws.onmessage = (ev) => {
        if (closed || socket !== ws) return;
        onMessage(String(ev.data));
      };
      ws.onopen = () => {
        attempt = 0;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "histories" }));
        }
      };
      ws.onclose = () => {
        if (socket === ws) socket = null;
        if (closed) return;
        worldStore.getState().setConnection("reconnecting");
        const wait = backoff(attempt);
        attempt += 1;
        retry = setTimeout(connect, wait);
      };
    };

    hud.setConnection(
      hud.connection === "live" ? "reconnecting" : "connecting"
    );
    connect();

    return () => {
      closed = true;
      bindWorldSocket(null);
      sentNonces.clear();
      sentSerialNonces.clear();
      pendingEdit = null;
      if (retry) clearTimeout(retry);
      if (noticeTimer) clearTimeout(noticeTimer);
      clearFlush();
      clearAttach();
      // StrictMode mounts, cleans up, and mounts again. Closing here
      // leaves one socket for this key.
      socket?.close();
      socket = null;
    };
  }, [socketKey]);
}
