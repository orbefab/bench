/**
 * The Probe tool's list and how the strip reads it. Pure: the store in
 * `state/world-probe.ts` holds the list, and the server decides which
 * recorded quantities a port maps to.
 */

import {
  parsePortProbeId,
  probeOfTrack,
  type TimelineTrack,
  type TimelineUnit,
} from "@sfab-bench/contract";

export const NOT_RECORDED = "Not recorded at this level";

/** Add the port, or remove it when it is already probed. */
export function toggleProbe(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
}

/** `servo.V+`. A leaf opened as the root is recorded as `$root`. */
export function probeLabel(id: string, rootName?: string | null): string {
  const parsed = parsePortProbeId(id);
  if (!parsed) return id;
  let instance = parsed.instance;
  if (
    rootName &&
    (instance === "$root" ||
      instance.startsWith("$root/") ||
      instance.startsWith("$root."))
  ) {
    instance = rootName + instance.slice("$root".length);
  }
  return `${instance}.${parsed.port}`;
}

export function trackLabel(
  track: Pick<TimelineTrack, "id" | "unit">,
  rootName?: string | null
): string {
  const probe = probeOfTrack(track.id);
  return `${probe ? probeLabel(probe, rootName) : track.id} (${track.unit})`;
}

export function formatProbeValue(
  value: number | null | undefined,
  unit: TimelineUnit
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  if (unit === "deg") return `${value.toFixed(1)}°`;
  if (unit === "ms") return `${value.toFixed(2)} ms`;
  return `${value.toFixed(3)} ${unit}`;
}

/** The value at the last sample at or before `t`. Null before the first. */
export function valueAt(track: TimelineTrack, t: number): number | null {
  let found: number | null = null;
  for (let i = 0; i < track.t.length; i++) {
    const at = track.t[i];
    if (at === undefined || at > t) break;
    found = track.v[i] ?? null;
  }
  return found;
}

export type ProbeRow = {
  probe: string;
  /** Tracks: this port's quantities. Unrecorded: nothing at this level. Pending: not read yet. */
  state: "tracks" | "unrecorded" | "pending";
  tracks: TimelineTrack[];
};

/** One row per probed port, in list order. */
export function probeRows(
  list: readonly string[],
  data: {
    tracks: readonly TimelineTrack[];
    unrecorded?: readonly string[];
  } | null
): ProbeRow[] {
  return list.map((probe) => {
    const tracks = (data?.tracks ?? []).filter(
      (track) => probeOfTrack(track.id) === probe
    );
    if (tracks.length > 0) return { probe, state: "tracks", tracks };
    if (data?.unrecorded?.includes(probe)) {
      return { probe, state: "unrecorded", tracks: [] };
    }
    return { probe, state: "pending", tracks: [] };
  });
}

/** What a row without tracks says. A previous run cannot be read again. */
export function rowNote(row: ProbeRow, previous: boolean): string | null {
  if (row.state === "unrecorded") return NOT_RECORDED;
  if (row.state === "pending") {
    return previous ? "Not read before this run stopped" : "Reading…";
  }
  return null;
}
