/**
 * Port-level tracks from what a run already records. A probed port maps to
 * the quantities the recorder holds for its instance; a port with nothing
 * recorded is reported, never returned as an empty track.
 */

import {
  parsePortProbeId,
  pinHas,
  pinIndex,
  portTrackId,
  type RecordedFrame,
  type RecordingRead,
  type TimelineTrack,
  type TimelineUnit,
} from "@sfab-bench/contract";

export type ProbeIndex = {
  /** Servo instance to the `robot/joint` it turns. */
  shafts: Record<string, string>;
  /** Board id to exposed GPIO names, in pin-state order. */
  pins: Record<string, readonly string[]>;
};

type Kind = "servo" | "ranger" | "supply" | "board" | "robot";

function kindOf(read: RecordingRead, instance: string): Kind | null {
  for (const frame of read.frames) {
    const part = frame.parts[instance];
    if (part) {
      return part.distanceM !== undefined || part.echoS !== undefined
        ? "ranger"
        : "servo";
    }
    if (frame.supplies[instance]) return "supply";
    if (frame.boards[instance]) return "board";
    if (frame.joints[instance]) return "robot";
  }
  return null;
}

type Pick = (frame: RecordedFrame) => number | null;

type Channel = { unit: TimelineUnit; pick: Pick; lo?: Pick; hi?: Pick };

function partChannel(
  instance: string,
  pick: (part: RecordedFrame["parts"][string]) => number | null
): Pick {
  return (frame) => {
    const part = frame.parts[instance];
    return part ? pick(part) : null;
  };
}

function supplyChannels(instance: string): Channel[] {
  return [
    {
      unit: "V",
      pick: (f) => f.supplies[instance]?.voltage ?? null,
      lo: (f) => f.supplies[instance]?.minVoltage ?? 0,
    },
    { unit: "A", pick: (f) => f.supplies[instance]?.current ?? null },
  ];
}

function channelsOf(
  kind: Kind,
  instance: string,
  port: string,
  index: ProbeIndex,
  read: RecordingRead
): Channel[] {
  if (kind === "servo") {
    if (port === "signal") {
      return [
        {
          unit: "ms",
          pick: partChannel(instance, (p) =>
            p.pulseUs === null ? null : p.pulseUs / 1000
          ),
        },
      ];
    }
    if (port === "V+") {
      return [
        { unit: "V", pick: partChannel(instance, (p) => p.voltage) },
        { unit: "A", pick: partChannel(instance, (p) => p.current) },
      ];
    }
    if (port === "shaft") {
      const joint = index.shafts[instance];
      if (!joint) return [];
      const slash = joint.indexOf("/");
      const robot = joint.slice(0, slash);
      const name = joint.slice(slash + 1);
      return [
        {
          unit: "deg",
          pick: (f) => {
            const rad = f.joints[robot]?.[name];
            return rad === undefined ? null : (rad * 180) / Math.PI;
          },
        },
      ];
    }
    return [];
  }
  if (kind === "ranger") {
    if (port === "VCC") {
      return [
        { unit: "V", pick: partChannel(instance, (p) => p.voltage) },
        { unit: "A", pick: partChannel(instance, (p) => p.current) },
      ];
    }
    if (port === "Echo") {
      return [
        {
          unit: "ms",
          pick: partChannel(instance, (p) =>
            p.echoS === null || p.echoS === undefined ? null : p.echoS * 1000
          ),
        },
      ];
    }
    return [];
  }
  if (kind === "supply") {
    return port === "5V" || port === "+" ? supplyChannels(instance) : [];
  }
  if (kind === "board") {
    if (port === "5V") {
      return [
        {
          unit: "V",
          pick: (f) => f.boards[instance]?.voltage ?? null,
          lo: (f) => f.boards[instance]?.minVoltage ?? 0,
        },
      ];
    }
    const names = index.pins[instance];
    if (!names || pinIndex(names, port) === undefined) return [];
    // A pin with a circuit on its net reads its solved node; one without
    // reads its output level times the board node.
    const solved = (f: RecordedFrame) => f.boards[instance]?.pinVolts?.[port];
    if (read.frames.some((f) => solved(f) !== undefined)) {
      return [
        {
          unit: "V",
          pick: (f) => solved(f)?.v ?? null,
          lo: (f) => solved(f)?.lo ?? 0,
          hi: (f) => solved(f)?.hi ?? 0,
        },
      ];
    }
    return [
      {
        unit: "V",
        pick: (f) => {
          const board = f.boards[instance];
          if (!board) return null;
          return pinHas(board.pins.level, names, port) ? board.voltage : 0;
        },
      },
    ];
  }
  return [
    {
      unit: "deg",
      pick: (f) => {
        const rad = f.joints[instance]?.[port];
        return rad === undefined ? null : (rad * 180) / Math.PI;
      },
    },
  ];
}

/**
 * The tracks of the probed ports, in the order they were asked, and the
 * ports with nothing recorded. A track whose every value is null counts as
 * not recorded.
 */
export function probeTracks(
  read: RecordingRead,
  probes: string[],
  index: ProbeIndex
): { tracks: TimelineTrack[]; unrecorded: string[] } {
  const tracks: TimelineTrack[] = [];
  const unrecorded: string[] = [];
  const t = read.frames.map((frame) => frame.t);
  for (const probe of probes) {
    const parsed = parsePortProbeId(probe);
    const kind = parsed ? kindOf(read, parsed.instance) : null;
    const channels =
      parsed && kind
        ? channelsOf(kind, parsed.instance, parsed.port, index, read)
        : [];
    const built: TimelineTrack[] = [];
    for (const channel of channels) {
      const v = read.frames.map(channel.pick);
      if (v.every((value) => value === null)) continue;
      built.push({
        id: portTrackId(probe, channel.unit),
        unit: channel.unit,
        t,
        v,
        ...(channel.lo ? { lo: read.frames.map(channel.lo) as number[] } : {}),
        ...(channel.hi ? { hi: read.frames.map(channel.hi) as number[] } : {}),
      });
    }
    if (built.length === 0) unrecorded.push(probe);
    else tracks.push(...built);
  }
  return { tracks, unrecorded };
}
