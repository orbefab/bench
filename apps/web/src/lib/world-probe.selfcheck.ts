import type { TimelineTrack } from "@sfab-bench/contract";

import {
  formatProbeValue,
  NOT_RECORDED,
  probeLabel,
  probeRows,
  rowNote,
  toggleProbe,
  trackLabel,
  valueAt,
} from "./world-probe";

function expect(cond: boolean, label: string) {
  if (!cond) throw new Error(label);
}

// The list: a click adds, the same click removes, order is pick order.
let list: string[] = [];
list = toggleProbe(list, "port:servo.signal");
list = toggleProbe(list, "port:servo.V+");
expect(
  list.join(",") === "port:servo.signal,port:servo.V+",
  "picks add in order"
);
const before = list;
list = toggleProbe(list, "port:servo.signal");
expect(list.join(",") === "port:servo.V+", "the same port again removes it");
expect(before.length === 2, "toggling does not change the old list");
expect(toggleProbe(list, "port:usb.5V").length === 2, "another port adds");
expect(toggleProbe([], "port:a.b").length === 1, "the first port adds");

// Labels and units.
expect(probeLabel("port:servo.V+") === "servo.V+", "instance and port");
expect(
  probeLabel("port:fleet.rig2.servo.signal") === "fleet.rig2.servo.signal",
  "a nested run path keeps its dots"
);
expect(
  probeLabel("port:$root.5V", "nano") === "nano.5V",
  "the root shows the part's short name"
);
expect(
  probeLabel("joint:arm/shoulder") === "joint:arm/shoulder",
  "not a probe"
);
expect(
  trackLabel({ id: "port:servo.V+~A", unit: "A" }) === "servo.V+ (A)",
  "a track label names the port and the unit"
);
expect(formatProbeValue(4.9574, "V") === "4.957 V", "volts");
expect(formatProbeValue(0.01, "A") === "0.010 A", "amperes");
expect(formatProbeValue(1.5, "ms") === "1.50 ms", "milliseconds");
expect(formatProbeValue(9.9074, "deg") === "9.9°", "degrees");
expect(formatProbeValue(null, "V") === "—", "no value");
expect(formatProbeValue(Number.NaN, "V") === "—", "not a number");

// Rows from the server's answer.
function track(id: string, unit: TimelineTrack["unit"], v: (number | null)[]) {
  return { id, unit, t: v.map((_, i) => i * 0.1), v } satisfies TimelineTrack;
}
const data = {
  tracks: [
    track("joint:arm/shoulder", "deg", [0, 1, 2]),
    track("port:servo.V+~V", "V", [4.9, 5, 5]),
    track("port:servo.V+~A", "A", [0, 0.1, 0.2]),
  ],
  unrecorded: ["port:servo.GND"],
};
const rows = probeRows(
  ["port:servo.V+", "port:servo.GND", "port:uno.D9"],
  data
);
expect(rows.length === 3, "one row per probed port");
expect(
  rows[0]?.state === "tracks" && rows[0].tracks.length === 2,
  "a port with tracks gets all its quantities, and not the joint"
);
expect(rows[1]?.state === "unrecorded", "a named port is unrecorded");
expect(rows[2]?.state === "pending", "an unanswered port is pending");
function row(index: number) {
  const found = rows[index];
  if (!found) throw new Error(`row ${index}`);
  return found;
}
expect(
  rowNote(row(1), false) === NOT_RECORDED &&
    NOT_RECORDED === "Not recorded at this level",
  "the unrecorded line"
);
expect(rowNote(row(2), false) === "Reading…", "a live pending line");
expect(
  rowNote(row(2), true) === "Not read before this run stopped",
  "a previous run cannot read a new port"
);
expect(rowNote(row(0), false) === null, "a row with tracks has no note");
expect(
  probeRows(["port:a.b"], null)[0]?.state === "pending",
  "no data yet is pending"
);
expect(probeRows([], data).length === 0, "no probes, no rows");

// Values follow the playhead.
const amps = data.tracks[2] as TimelineTrack;
expect(valueAt(amps, -1) === null, "before the first sample");
expect(valueAt(amps, 0.05) === 0, "between samples takes the earlier");
expect(valueAt(amps, 0.1) === 0.1, "on a sample");
expect(valueAt(amps, 9) === 0.2, "past the end takes the last");

console.log("world-probe.selfcheck ok");
