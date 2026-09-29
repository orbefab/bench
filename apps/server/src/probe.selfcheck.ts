import { ok as expect } from "node:assert/strict";
import { fileURLToPath } from "node:url";

import {
  parsePortProbeId,
  portProbeId,
  portTrackId,
  probeOfTrack,
  type TimelineTrack,
  type WorldServerMessage,
} from "@sfab-bench/contract";

import { closeRootWatches } from "./projects";
import { attachWorld, stopWorld } from "./world/host";
import { parseWorldClient } from "./world/live";

/**
 * Probe: a port asked for by id comes back as tracks computed from what the
 * run already recorded. Without `tracks` the answer is the one it always was.
 */

const armDir = fileURLToPath(
  new URL("../../../examples/arm/", import.meta.url)
);
const world = "parts/sfab/arm-bench@1.0.0.json";

const id = portProbeId("fleet.rig2.servo", "V+");
expect(id === "port:fleet.rig2.servo.V+", "probe id");
const parsed = parsePortProbeId(id);
expect(
  parsed?.instance === "fleet.rig2.servo" && parsed.port === "V+",
  "probe id splits at the last dot"
);
expect(parsePortProbeId("joint:arm/shoulder") === null, "not a probe id");
expect(parsePortProbeId("port:servo.") === null, "a port needs a name");
expect(probeOfTrack(portTrackId(id, "A")) === id, "track to probe");
expect(probeOfTrack("supply:usb") === null, "a plain track has no probe");

const plain = parseWorldClient(
  JSON.stringify({ type: "timeline", from: 0, to: 1, maxPoints: 8 })
);
expect(
  !("error" in plain) && plain.type === "timeline" && !("tracks" in plain),
  "no tracks stays absent"
);
const named = parseWorldClient(
  JSON.stringify({
    type: "timeline",
    from: 0,
    to: 1,
    maxPoints: 8,
    tracks: ["port:servo.signal"],
  })
);
expect(
  !("error" in named) &&
    named.type === "timeline" &&
    named.tracks?.[0] === "port:servo.signal",
  "tracks parse"
);
const bad = parseWorldClient(
  JSON.stringify({
    type: "timeline",
    from: 0,
    to: 1,
    maxPoints: 8,
    tracks: [1],
  })
);
expect("error" in bad, "tracks must be strings");
console.log("probe: ids and the timeline message parse");

const events: WorldServerMessage[] = [];
const attached = await attachWorld(armDir, world, {
  sender: { kind: "loopback", label: "Mac" },
  onEvent(event) {
    events.push(event);
  },
});
if ("error" in attached) throw new Error(attached.error);

function stateMs(): number {
  const last = [...events].reverse().find((event) => event.type === "state");
  return last?.type === "state" ? Math.round(last.state.simTime * 1000) : -1;
}

function line(track: TimelineTrack): string {
  const last = track.v.length - 1;
  const fmt = (n: number | null) => (n === null ? "null" : n.toFixed(4));
  return `probe ${track.id} ${track.unit} n=${track.v.length} first=${fmt(track.v[0] ?? null)} last=${fmt(track.v[last] ?? null)}`;
}

try {
  attached.step(500);
  const started = Date.now();
  while (stateMs() !== 500) {
    if (Date.now() - started > 30000) throw new Error("run timed out");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  const query = { from: 0, to: 0.5, maxPoints: 40 };
  const base = await attached.timeline(query);
  if ("error" in base) throw new Error(base.error);
  const again = await attached.timeline(query);
  expect(
    JSON.stringify(again) === JSON.stringify(base),
    "the same request answers the same"
  );
  expect(!("unrecorded" in base), "no tracks: no unrecorded field");

  const asked = [
    "port:servo.signal",
    "port:servo.V+",
    "port:servo.shaft",
    "port:usb.5V",
    "port:uno.D9",
    "port:arm.shoulder",
    "port:servo.GND",
    "port:servo.mount",
    "port:arm.base",
    "port:nowhere.V+",
  ];
  const probed = await attached.timeline({ ...query, tracks: asked });
  if ("error" in probed) throw new Error(probed.error);
  expect(
    JSON.stringify(probed.tracks.slice(0, base.tracks.length)) ===
      JSON.stringify(base.tracks),
    "the default tracks come first and are unchanged"
  );
  expect(
    JSON.stringify(probed.markers) === JSON.stringify(base.markers),
    "markers are unchanged"
  );
  const extra = probed.tracks.slice(base.tracks.length);
  for (const track of extra) console.log(line(track));
  const ids = extra.map((track) => track.id);
  for (const want of [
    "port:servo.signal~ms",
    "port:servo.V+~V",
    "port:servo.V+~A",
    "port:servo.shaft~deg",
    "port:usb.5V~V",
    "port:usb.5V~A",
    "port:uno.D9~V",
    "port:arm.shoulder~deg",
  ]) {
    expect(ids.includes(want), `missing ${want}: ${ids.join(", ")}`);
  }
  for (const track of extra) {
    expect(track.v.length > 1, `${track.id} has points`);
    expect(track.t.length === track.v.length, `${track.id} t and v match`);
    expect(
      track.v.some((value) => value !== null),
      `${track.id} is not empty`
    );
  }
  const signal = extra.find((track) => track.id === "port:servo.signal~ms");
  expect(
    signal?.v.some((value) => value !== null && value >= 0.5 && value <= 2.5),
    "the servo pulse is between 0.5 and 2.5 ms"
  );
  const supply = extra.find((track) => track.id === "port:usb.5V~V");
  expect(
    supply?.v.every((value) => value !== null && value > 4),
    "the supply output holds near 5 V"
  );
  expect(
    probed.unrecorded?.join(",") ===
      [
        "port:servo.GND",
        "port:servo.mount",
        "port:arm.base",
        "port:nowhere.V+",
      ].join(","),
    `unrecorded: ${probed.unrecorded?.join(", ")}`
  );
  for (const port of probed.unrecorded ?? []) {
    console.log(`probe ${port} Not recorded at this level`);
  }

  const empty = await attached.timeline({ ...query, tracks: [] });
  if ("error" in empty) throw new Error(empty.error);
  expect(
    JSON.stringify(empty.tracks) === JSON.stringify(base.tracks) &&
      empty.unrecorded?.length === 0,
    "an empty list adds nothing"
  );
  console.log(
    "probe: timeline without tracks is byte-identical, ports without a record are named"
  );
} finally {
  attached.detach();
  await stopWorld(armDir, world);
  closeRootWatches();
}

console.log("probe.selfcheck ok");
