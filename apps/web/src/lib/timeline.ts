import {
  boardTrackId,
  jointTrackId,
  nameRootPath,
  partTrackId,
  RECORD_FRAME_MS,
  supplyTrackId,
  type TimelineMarker,
  type TimelineTrack,
} from "@sfab-bench/contract";

import type { WorldOutline } from "@/lib/world-outline";
import type { WorldSelection } from "@/state/world";

/** Seconds at a pointer position along the strip. */
export function timeAtPointer(
  x: number,
  width: number,
  from: number,
  to: number
): number {
  if (!(width > 0) || !(to > from)) return from;
  const u = Math.min(1, Math.max(0, x / width));
  return from + u * (to - from);
}

/**
 * Seek time whose frame window contains `playhead`. The frame at that
 * boundary stores the 10 ms ending there, including a 1 ms dip inside it.
 * Clamped to the retained recording.
 */
export function seekTimeFor(
  playhead: number,
  from: number,
  to: number,
  frameMs = RECORD_FRAME_MS
): number {
  const step = Math.max(1, Math.round(frameMs));
  const covered = Math.ceil(Math.round(playhead * 1000) / step) * step;
  const lo = Math.round(from * 1000);
  const hi = Math.round(Math.max(to, from) * 1000);
  return Math.min(Math.max(covered, lo), hi) / 1000;
}

/** Board TX, and sent lines, at or before `t`. Markers are time-sorted. */
export function serialUntil(
  markers: readonly TimelineMarker[],
  board: string,
  t: number
): string {
  let text = "";
  for (const marker of markers) {
    if (marker.t > t) break;
    if (marker.kind !== "serial" || marker.board !== board) continue;
    text += marker.text ?? "";
  }
  return text;
}

export function resetsUntil(
  markers: readonly TimelineMarker[],
  board: string,
  t: number
): number {
  let count = 0;
  for (const marker of markers) {
    if (marker.t > t) break;
    if (marker.kind === "reset" && marker.board === board) count += 1;
  }
  return count;
}

/** Fault text at or before `t`. A later reload of that board clears it. */
export function faultUntil(
  markers: readonly TimelineMarker[],
  board: string,
  t: number
): string | undefined {
  let fault: string | undefined;
  for (const marker of markers) {
    if (marker.t > t) break;
    if (marker.board !== board) continue;
    if (marker.kind === "fault") fault = marker.text;
    if (marker.kind === "reload") fault = undefined;
  }
  return fault;
}

/**
 * The strip's label. A leaf opened as the root is recorded as `$root`;
 * the label uses the part's short name, the same name as the tree row.
 * The track id itself is unchanged.
 */
export function timelineTrackLabel(
  id: string,
  unit: string,
  rootName?: string | null
): string {
  const name = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
  return `${nameRootPath(name, rootName)} (${unit})`;
}

function byId(
  tracks: readonly TimelineTrack[],
  id: string
): TimelineTrack | null {
  return tracks.find((track) => track.id === id) ?? null;
}

function firstJoint(
  outline: WorldOutline | null
): { robot: string; joint: string } | null {
  if (!outline) return null;
  for (const robot of outline.robots) {
    for (const link of robot.links) {
      if (link.joint) return { robot: robot.id, joint: link.joint.name };
    }
  }
  return null;
}

function linkJoint(
  outline: WorldOutline | null,
  robotId: string,
  linkName: string
): string | null {
  const robot = outline?.robots.find((item) => item.id === robotId);
  const link = robot?.links.find((item) => item.name === linkName);
  return link?.joint?.name ?? null;
}

/**
 * One track, or a joint plus its command when a part is selected.
 * Nothing selected uses the first joint.
 */
export function tracksForSelection(
  tracks: readonly TimelineTrack[],
  selection: WorldSelection,
  outline: WorldOutline | null
): { primary: TimelineTrack | null; secondary: TimelineTrack | null } {
  if (!selection) {
    const joint = firstJoint(outline);
    const id = joint ? jointTrackId(joint.robot, joint.joint) : "";
    return {
      primary:
        (id && byId(tracks, id)) ||
        tracks.find((t) => t.unit === "deg" && t.id.startsWith("joint:")) ||
        null,
      secondary: null,
    };
  }
  if (selection.link) {
    const name = linkJoint(outline, selection.path, selection.link);
    const joint = name
      ? byId(tracks, jointTrackId(selection.path, name))
      : null;
    return { primary: joint, secondary: null };
  }
  const drives = outline?.parts.find(
    (item) => item.id === selection.path
  )?.drives;
  if (drives) {
    const joint = byId(tracks, jointTrackId(drives.robot, drives.joint));
    const command = byId(tracks, partTrackId(selection.path));
    if (joint) return { primary: joint, secondary: command };
    return { primary: command, secondary: null };
  }
  if (outline?.supplies.some((item) => item.id === selection.path)) {
    return {
      primary: byId(tracks, supplyTrackId(selection.path)),
      secondary: null,
    };
  }
  if (outline?.boards.some((item) => item.id === selection.path)) {
    return {
      primary: byId(tracks, boardTrackId(selection.path)),
      secondary: null,
    };
  }
  return {
    primary: byId(tracks, partTrackId(selection.path)),
    secondary: null,
  };
}

/** Smallest vertical span, so a flat or jittering trace does not fill the strip. */
export function minSpan(unit: TimelineTrack["unit"]): number {
  if (unit === "deg") return 1;
  if (unit === "A") return 0.01;
  return 0.1;
}

export function seriesValues(
  track: TimelineTrack,
  field: "v" | "lo"
): (number | null)[] {
  return field === "lo" ? (track.lo ?? track.v) : track.v;
}

/** Pad a flat series out to `span` around its midpoint. */
export function seriesRange(
  samples: readonly (readonly (number | null | undefined)[])[],
  span: number
): { min: number; max: number } | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const series of samples) {
    for (const value of series) {
      if (value === null || value === undefined || !Number.isFinite(value)) {
        continue;
      }
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (max - min >= span) return { min, max };
  const mid = (min + max) / 2;
  const half = span / 2;
  return { min: mid - half, max: mid + half };
}

/**
 * Whether the strip should publish a newer live edge.
 * A pause or a finished step catches up immediately. While playing, the
 * edge waits until it has moved 0.2 s.
 */
export function followLiveEdge(input: {
  shownTo: number;
  prevFrom: number;
  from: number;
  to: number;
  playing: boolean;
}): { publish: boolean; immediate: boolean } {
  const caughtUp = !input.playing && input.to !== input.shownTo;
  const moved =
    input.from !== input.prevFrom || Math.abs(input.to - input.shownTo) >= 0.2;
  if (!caughtUp && !moved) return { publish: false, immediate: false };
  return { publish: true, immediate: caughtUp };
}

/** SVG polyline in a 0..100 by 0..100 box. Null samples break the line. */
export function sparkline(
  track: TimelineTrack,
  from: number,
  to: number,
  field: "v" | "lo",
  range: { min: number; max: number }
): string {
  const values = seriesValues(track, field);
  const spanT = Math.max(to - from, 1e-9);
  const spanV = range.max - range.min;
  if (!(spanV > 0)) return "";
  let points = "";
  let pen = false;
  for (let i = 0; i < track.t.length; i++) {
    const t = track.t[i];
    const value = values[i];
    if (
      t === undefined ||
      value === null ||
      value === undefined ||
      !Number.isFinite(value)
    ) {
      pen = false;
      continue;
    }
    const x = ((t - from) / spanT) * 100;
    const y = 100 - ((value - range.min) / spanV) * 100;
    points += `${pen ? " " : "M "}${x.toFixed(2)} ${y.toFixed(2)}`;
    pen = true;
  }
  return points;
}
