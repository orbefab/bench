import {
  boardTrackId,
  jointTrackId,
  partTrackId,
  supplyTrackId,
  type TimelineMarker,
  type TimelineTrack,
} from "@sfab-bench/contract";
import {
  faultUntil,
  followLiveEdge,
  minSpan,
  resetsUntil,
  seekTimeFor,
  serialUntil,
  seriesRange,
  seriesValues,
  sparkline,
  timeAtPointer,
  tracksForSelection,
} from "./timeline";
import type { WorldOutline } from "./world-outline";

function expect(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(label);
}

expect(timeAtPointer(0, 100, 1, 3) === 1, "pointer at the start");
expect(timeAtPointer(100, 100, 1, 3) === 3, "pointer at the live edge");
expect(timeAtPointer(25, 100, 0, 4) === 1, "pointer quarter");
expect(timeAtPointer(-10, 100, 0, 4) === 0, "pointer clamps low");
expect(timeAtPointer(0, 0, 2, 5) === 2, "a zero width stays at the start");

expect(
  seekTimeFor(0.524, 0, 2) === 0.53,
  "a dip seeks the frame that closes it"
);
expect(seekTimeFor(0.52, 0, 2) === 0.52, "a frame boundary seeks itself");
expect(
  seekTimeFor(0.001, 0, 2) === 0.01,
  "the first millisecond closes at 10 ms"
);
expect(seekTimeFor(1.995, 0, 1.2) === 1.2, "seek clamps to the live edge");
expect(seekTimeFor(0, 0.5, 2) === 0.5, "seek clamps to the retained start");

const markers: TimelineMarker[] = [
  { t: 0.1, kind: "serial", board: "uno", text: "boot\r\n" },
  { t: 0.2, kind: "serial", board: "stall", text: "other\r\n" },
  { t: 0.4, kind: "reset", board: "uno" },
  { t: 0.4, kind: "serial", board: "uno", text: "— brownout reset —\n" },
  { t: 0.5, kind: "fault", board: "uno", text: "bad checksum" },
  { t: 0.8, kind: "reload", board: "uno" },
  { t: 0.9, kind: "serial", board: "uno", text: "10\r\n" },
];

expect(
  serialUntil(markers, "uno", 0.4) === "boot\r\n— brownout reset —\n",
  "serial stops at the playhead and stays on that board"
);
expect(serialUntil(markers, "stall", 1).includes("other"), "the other board");
expect(!serialUntil(markers, "uno", 0.05).includes("boot"), "before the line");
expect(resetsUntil(markers, "uno", 0.4) === 1, "one reset at the marker");
expect(resetsUntil(markers, "uno", 0.39) === 0, "the reset is not early");
expect(resetsUntil(markers, "stall", 1) === 0, "the other board did not reset");
expect(faultUntil(markers, "uno", 0.5) === "bad checksum", "fault at its time");
expect(
  faultUntil(markers, "uno", 0.8) === undefined,
  "reload clears the fault"
);

const joint: TimelineTrack = {
  id: jointTrackId("arm", "shoulder"),
  unit: "deg",
  t: [0, 0.01],
  v: [0, 90],
};
const command: TimelineTrack = {
  id: partTrackId("servo"),
  unit: "deg",
  t: [0, 0.01],
  v: [10, 90],
};
const supply: TimelineTrack = {
  id: supplyTrackId("usb"),
  unit: "V",
  t: [0, 0.01],
  v: [5, 5],
  lo: [5, 2.5],
};
const board: TimelineTrack = {
  id: boardTrackId("uno"),
  unit: "V",
  t: [0, 0.01],
  v: [4.5, 4.5],
  lo: [4.5, 2.5],
};
const tracks = [joint, command, supply, board];
const outline = {
  robots: [
    {
      id: "arm",
      links: [
        {
          name: "upper",
          meshes: [],
          joint: {
            name: "shoulder",
            type: "revolute",
            axis: [0, 1, 0],
            lowerDeg: 0,
            upperDeg: 150,
            lowerMm: null,
            upperMm: null,
          },
        },
      ],
    },
  ],
  parts: [
    {
      id: "servo",
      model: "sg90",
      drives: { robot: "arm", joint: "shoulder" },
      wires: [],
    },
  ],
  boards: [],
  supplies: [
    {
      id: "usb",
      voltage: 5,
      currentLimit: 0.9,
      rSeries: 0.5,
      boards: ["uno"],
      parts: ["servo"],
    },
  ],
} satisfies WorldOutline;

expect(
  tracksForSelection(tracks, null, outline).primary?.id === joint.id,
  "nothing selected plots the first joint"
);
const link = tracksForSelection(
  tracks,
  { kind: "link", robot: "arm", link: "upper" },
  outline
);
expect(
  link.primary?.id === joint.id && link.secondary === null,
  "a link plots its joint"
);
const part = tracksForSelection(
  tracks,
  { kind: "part", part: "servo" },
  outline
);
expect(
  part.primary?.id === joint.id && part.secondary?.id === command.id,
  "a part plots the joint and the command"
);
expect(
  tracksForSelection(tracks, { kind: "supply", supply: "usb" }, outline).primary
    ?.id === supply.id,
  "a supply plots voltage"
);
expect(
  tracksForSelection(tracks, { kind: "board", board: "uno" }, outline).primary
    ?.id === board.id,
  "a board plots its 5V node"
);

const loRange = seriesRange([seriesValues(supply, "lo")], minSpan("V"));
const vRange = seriesRange([seriesValues(supply, "v")], minSpan("V"));
expect(loRange !== null && vRange !== null, "voltage ranges");
if (!loRange || !vRange) throw new Error("unreachable");
const line = sparkline(supply, 0, 0.01, "lo", loRange);
expect(
  line.includes("M ") && line.includes("100.00"),
  "the dip line reaches the frame"
);
expect(
  sparkline(supply, 0, 0.01, "lo", loRange) !==
    sparkline(supply, 0, 0.01, "v", vRange),
  "min voltage is its own series"
);

const jitter: TimelineTrack = {
  id: partTrackId("servo"),
  unit: "deg",
  t: [0, 0.5, 1],
  v: [180, 180.0000002, 179.9999998],
};
const alone = seriesRange([seriesValues(jitter, "v")], minSpan("deg"));
expect(
  alone !== null && Math.abs(alone.max - alone.min - 1) < 1e-9,
  "a flat command spans 1°"
);
if (!alone) throw new Error("unreachable");
const flatYs = ys(sparkline(jitter, 0, 1, "v", alone));
expect(
  flatYs.length === 3 && flatYs.every((y) => y === flatYs[0]),
  `a flat command draws flat, saw ${flatYs.join(",")}`
);

const swing: TimelineTrack = {
  id: jointTrackId("arm", "shoulder"),
  unit: "deg",
  t: [0, 1],
  v: [10, 90],
};
const shared = seriesRange(
  [seriesValues(swing, "v"), seriesValues(jitter, "v")],
  minSpan("deg")
);
expect(
  shared !== null && shared.min <= 10 && shared.max >= 180,
  "shared degree range"
);
if (!shared) throw new Error("unreachable");
const sharedYs = ys(sparkline(jitter, 0, 1, "v", shared));
expect(
  sharedYs.length === 3 && sharedYs.every((y) => y === sharedYs[0]),
  `a shared scale keeps the command flat, saw ${sharedYs.join(",")}`
);

expect(
  followLiveEdge({
    shownTo: 1,
    prevFrom: 0,
    from: 0,
    to: 1.05,
    playing: true,
  }).publish === false,
  "a short step while playing does not move the strip"
);
const paused = followLiveEdge({
  shownTo: 1,
  prevFrom: 0,
  from: 0,
  to: 1.05,
  playing: false,
});
expect(
  paused.publish && paused.immediate,
  "a pause catches the tail immediately"
);
const playing = followLiveEdge({
  shownTo: 1,
  prevFrom: 0,
  from: 0,
  to: 1.25,
  playing: true,
});
expect(
  playing.publish && !playing.immediate,
  "a longer step while playing is debounced"
);

function ys(path: string): number[] {
  const parts = path.split(/\s+/).filter((part) => part !== "" && part !== "M");
  const out: number[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const y = Number(parts[i]);
    if (Number.isFinite(y)) out.push(y);
  }
  return out;
}

console.log("timeline.selfcheck ok");
