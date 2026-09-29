import type {
  RecordedFrame,
  RecordingSummary,
  TimelineMarker,
  TimelineTrack,
  WorldClientMessage,
  WorldServerMessage,
} from "@sfab-bench/contract";
import { useSyncExternalStore } from "react";
import { followLiveEdge, seekTimeFor } from "@/lib/timeline";
import { worldCommandNonce } from "@/lib/world-nonce";
import { invalidateSceneNow } from "@/scene/invalidate";
import { probedPorts, probeStore } from "@/state/world-probe";

/**
 * This client's scrub. The shared run keeps playing; only this tab's
 * view, inspector, and console follow the playhead (D-015).
 */

export type TimelineData = {
  recording: string;
  from: number;
  to: number;
  tracks: TimelineTrack[];
  markers: TimelineMarker[];
  /** Probed ports with no recorded quantity. Absent when none were asked for. */
  unrecorded?: string[];
};

export type TimelineSnapshot = {
  recording: RecordingSummary | null;
  data: TimelineData | null;
  /** Null while this client follows the live edge. */
  playhead: number | null;
  frame: RecordedFrame | null;
  /** The worker that wrote this recording is gone. Play starts a new one. */
  previous: boolean;
};

const listeners = new Set<() => void>();

let recording: RecordingSummary | null = null;
let data: TimelineData | null = null;
let playhead: number | null = null;
let frame: RecordedFrame | null = null;
let previous = false;
/** The live recording that arrived while a previous run is on screen. */
let pendingRecording: RecordingSummary | null = null;
let snapshot: TimelineSnapshot = {
  recording: null,
  data: null,
  playhead: null,
  frame: null,
  previous: false,
};
let shownTo = -1;
let send: ((message: WorldClientMessage) => void) | null = null;
let inflight: string | null = null;
let queued: number | null = null;
let timelineTimer: ReturnType<typeof setTimeout> | null = null;

function emit() {
  snapshot = { recording, data, playhead, frame, previous };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): TimelineSnapshot {
  return snapshot;
}

export function useWorldTimeline(): TimelineSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function worldTimelineSnapshot(): TimelineSnapshot {
  return snapshot;
}

export function worldViewPoses(): RecordedFrame["poses"] | null {
  if (playhead === null || !frame) return null;
  return frame.poses;
}

export function bindWorldSocket(
  next: ((message: WorldClientMessage) => void) | null
) {
  send = next;
  if (!next && !previous) goLive();
}

export function noteLiveRecording(
  summary: RecordingSummary | undefined,
  playing: boolean
) {
  if (!summary) return;
  if (previous) {
    pendingRecording = summary;
    return;
  }
  const prev = recording;
  const idChanged = !prev || prev.id !== summary.id;
  recording = summary;
  if (idChanged) {
    data = null;
    playhead = null;
    frame = null;
    inflight = null;
    queued = null;
    shownTo = summary.to;
    emit();
    invalidateSceneNow();
    scheduleTimeline(0);
    return;
  }
  const edge = followLiveEdge({
    shownTo,
    prevFrom: prev.from,
    from: summary.from,
    to: summary.to,
    playing,
  });
  if (!edge.publish) return;
  shownTo = summary.to;
  emit();
  scheduleTimeline(edge.immediate ? 0 : 200);
}

export function takeTimeline(
  message: Extract<WorldServerMessage, { type: "timeline-data" }>
) {
  if (recording && message.recording !== recording.id) return;
  data = {
    recording: message.recording,
    from: message.from,
    to: message.to,
    tracks: message.tracks,
    markers: message.markers,
    ...(message.unrecorded ? { unrecorded: message.unrecorded } : {}),
  };
  emit();
}

export function takeFrame(
  message: Extract<WorldServerMessage, { type: "frame" }>
) {
  if (inflight !== message.nonce) return;
  inflight = null;
  if (
    playhead !== null &&
    message.frame &&
    (!recording || recording.id === message.recording)
  ) {
    frame = message.frame;
    emit();
    invalidateSceneNow();
  }
  flushQueuedSeek();
}

/** A failed read. Does not touch the shared run. A matching seek nonce is retired. */
export function takeTimelineError(
  message: Extract<WorldServerMessage, { type: "timeline-error" }>
) {
  if (message.nonce !== undefined) {
    if (inflight !== message.nonce) return;
    inflight = null;
  }
  flushQueuedSeek();
}

function flushQueuedSeek() {
  if (queued === null || playhead === null || inflight !== null) return;
  const next = queued;
  queued = null;
  sendSeek(next);
}

export function scrubTo(t: number) {
  if (!recording) return;
  const next = Math.min(recording.to, Math.max(recording.from, t));
  playhead = next;
  emit();
  if (previous) return;
  if (!data) scheduleTimeline(0);
  sendSeek(seekTimeFor(next, recording.from, recording.to));
}

/** Drop this tab's strip. A failed load must not keep the previous run. */
export function resetTimeline() {
  if (timelineTimer) {
    clearTimeout(timelineTimer);
    timelineTimer = null;
  }
  recording = null;
  data = null;
  playhead = null;
  frame = null;
  previous = false;
  pendingRecording = null;
  inflight = null;
  queued = null;
  shownTo = -1;
  emit();
  invalidateSceneNow();
}

/**
 * Show a parked tab's strip. The recording stays on screen, and a new
 * attach is held until Play. Scrubbing moves the playhead locally: the
 * worker that wrote the frames is gone.
 */
export function restoreTimeline(next: TimelineSnapshot) {
  if (timelineTimer) {
    clearTimeout(timelineTimer);
    timelineTimer = null;
  }
  recording = next.recording;
  data = next.data;
  playhead = next.playhead;
  frame = next.frame;
  previous = next.previous && next.recording !== null;
  pendingRecording = null;
  inflight = null;
  queued = null;
  shownTo = next.recording?.to ?? -1;
  emit();
  invalidateSceneNow();
}

/** Play replaces the previous run with the recording the server is writing. */
export function releasePreviousRun() {
  if (!previous && pendingRecording === null) return;
  const summary = pendingRecording;
  previous = false;
  pendingRecording = null;
  if (!summary) {
    resetTimeline();
    return;
  }
  recording = null;
  data = null;
  playhead = null;
  frame = null;
  noteLiveRecording(summary, false);
}

export function goLive() {
  if (previous) return;
  inflight = null;
  queued = null;
  if (playhead === null && frame === null) return;
  playhead = null;
  frame = null;
  emit();
  invalidateSceneNow();
}

function sendSeek(t: number) {
  if (!send || playhead === null) return;
  if (inflight) {
    queued = t;
    return;
  }
  const nonce = worldCommandNonce();
  inflight = nonce;
  send({ type: "seek", t, nonce });
}

function scheduleTimeline(delay: number) {
  if (timelineTimer) clearTimeout(timelineTimer);
  timelineTimer = setTimeout(() => {
    timelineTimer = null;
    if (!recording || !send) return;
    const probed = probedPorts();
    send({
      type: "timeline",
      from: recording.from,
      to: recording.to,
      maxPoints: 480,
      ...(probed.length > 0 ? { tracks: [...probed] } : {}),
    });
  }, delay);
}

// A newly probed port is read at once; a removed one needs no read.
probeStore.subscribe((state, prev) => {
  if (previous || !recording) return;
  if (state.ports.every((id) => prev.ports.includes(id))) return;
  scheduleTimeline(0);
});
