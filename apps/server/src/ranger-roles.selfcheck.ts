/**
 * The ranger form finds its ports by role, not by name (layered-sim unit 8).
 * The gauge world runs twice: once on the catalog HC-SR04, once on a
 * project copy whose type renames every port. The recordings must be the
 * same, and the probe must answer the renamed power and echo ports.
 */
import { ok as expect } from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { TimelineTrack } from "@sfab-bench/contract";
import { headlessSim } from "./run";
import { catalogRoot } from "./world/plan";

const gaugeDir = fileURLToPath(
  new URL("../../../examples/gauge/", import.meta.url)
);
const WORLD = "parts/sfab/gauge-usb@1.0.0.json";
const SCENE = "parts/sfab/gauge-scene@1.0.0.json";
const MS = 3000;
const RENAMED: Record<string, string> = {
  VCC: "PWR",
  GND: "RTN",
  Trig: "PING",
  Echo: "PONG",
};

type Json = Record<string, unknown>;
const readJson = (file: string): Json =>
  JSON.parse(readFileSync(file, "utf8")) as Json;
const writeJson = (file: string, value: unknown) =>
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

function renameKeys(record: Json): Json {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [RENAMED[key] ?? key, value])
  );
}

/** A project type and part with every port renamed; the scene uses them. */
function renamePorts(root: string): void {
  const type = readJson(
    join(catalogRoot(), "types", "ultrasonic-ranger-4pin.json")
  );
  writeJson(join(root, "types", "ranger-renamed.json"), {
    ...type,
    id: "ranger-renamed",
    ports: renameKeys(type.ports as Json),
  });
  const part = readJson(
    join(catalogRoot(), "parts", "sfab", "hc-sr04@1.0.0.json")
  );
  writeJson(join(root, "parts", "sfab", "hc-sr04-renamed@1.0.0.json"), {
    ...part,
    id: "sfab/hc-sr04-renamed@1.0.0",
    type: "ranger-renamed",
    ratings: renameKeys(part.ratings as Json),
  });
  const scene = readFileSync(join(root, SCENE), "utf8")
    .replace('"sfab/hc-sr04@1.0.0"', '"sfab/hc-sr04-renamed@1.0.0"')
    .replace(/"sensor\.(VCC|GND|Trig|Echo)"/g, (_, port: string) => {
      return `"sensor.${RENAMED[port]}"`;
    });
  writeFileSync(join(root, SCENE), scene);
}

async function run(
  root: string,
  ports: { power: string; echo: string; old: string }
): Promise<{ frames: string; tracks: TimelineTrack[]; unrecorded: string[] }> {
  const sim = headlessSim();
  try {
    const loaded = await sim.load({
      project: root,
      world: WORLD,
      generation: 1,
    });
    if (!loaded.ok) {
      throw new Error(loaded.errors.map((row) => row.message).join("; "));
    }
    await sim.step(MS);
    const to = MS / 1000;
    const read = sim.record({ op: "read", from: 0, to });
    if (read.op !== "read") throw new Error("no recording");
    const probed = sim.record({
      op: "timeline",
      from: 0,
      to,
      maxPoints: 1000,
      tracks: [
        `port:sensor.${ports.power}`,
        `port:sensor.${ports.echo}`,
        `port:sensor.${ports.old}`,
      ],
    });
    if (probed.op !== "timeline") throw new Error("no timeline");
    const probes = new Set(
      [ports.power, ports.echo, ports.old].map((port) => `port:sensor.${port}`)
    );
    return {
      frames: JSON.stringify(read.read.frames),
      tracks: probed.tracks.filter((track) =>
        [...probes].some((probe) => track.id.startsWith(probe))
      ),
      unrecorded: probed.unrecorded ?? [],
    };
  } finally {
    sim.dispose();
  }
}

const base = mkdtempSync(join(tmpdir(), "sfab-ranger-roles-"));
try {
  const named = join(base, "named");
  const renamed = join(base, "renamed");
  for (const root of [named, renamed]) {
    cpSync(gaugeDir, root, { recursive: true });
    // The renamed scene changes the scene's hash; neither copy keeps a lock.
    rmSync(join(root, "parts", "sfab", "gauge-usb@1.0.0.lock.json"));
  }
  renamePorts(renamed);

  const a = await run(named, { power: "VCC", echo: "Echo", old: "PONG" });
  const b = await run(renamed, { power: "PWR", echo: "PONG", old: "Echo" });

  expect(a.frames.includes('"distanceM":0.1'), "the card is never in range");
  expect(a.frames === b.frames, "renamed ranger ports change the recording");
  const units = (tracks: TimelineTrack[]) =>
    tracks.map((track) => track.unit).join(",");
  expect(units(a.tracks) === "V,A,ms", `named probe units ${units(a.tracks)}`);
  expect(
    units(b.tracks) === "V,A,ms",
    `renamed probe units ${units(b.tracks)}`
  );
  const values = (tracks: TimelineTrack[]) =>
    JSON.stringify(tracks.map((track) => track.v));
  expect(
    values(a.tracks) === values(b.tracks),
    "the renamed probe reads other values"
  );
  expect(
    b.unrecorded.includes("port:sensor.Echo"),
    `the old port name still answers: ${b.unrecorded.join(", ")}`
  );
  const echoes = b.tracks.at(-1)?.v.filter((v) => v !== null).length ?? 0;
  console.log(
    `ranger roles: ports ${Object.entries(RENAMED)
      .map(([from, to]) => `${from}→${to}`)
      .join(
        " "
      )}; ${MS} ms recordings identical (${a.frames.length} bytes); probe PWR V,A and PONG ms match VCC and Echo (${echoes} echo points); Echo unrecorded on the renamed part`
  );
} finally {
  rmSync(base, { recursive: true, force: true });
}
console.log("ranger-roles.selfcheck ok");
