/**
 * Chip input thresholds from the type's `vil` / `vih`. A `[k, b]` threshold
 * is `k·vcc + b`: the static check resolves it at the cited `vcc`, a run at
 * the solved board node. A GPIO whose net has a circuit reads its solved
 * node before the CPU (the ADC's one-step lag); between VIL and VIH the
 * last level holds.
 *
 * The run: D9 drives 10 kΩ into 1 µF and D2 reads the capacitor. The sketch
 * prints the microseconds from each D9 edge to the D2 edge that follows.
 * The 328P's 0.6·VCC rise and 0.3·VCC fall do not depend on the rail.
 */

import { ok as expect } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RecordingRead, WorldState } from "@sfab-bench/contract";
import { loadTypeById, loadWorldV2, logicThresholds } from "@sfab-bench/parts";
import { closeRootWatches } from "./projects";
import { attachWorld, readRecording, stopWorld } from "./world/host";
import { nodeStore } from "./world/node-store";
import { catalogRoot } from "./world/plan";

const catalog = catalogRoot();
const opts = { store: nodeStore, catalogDir: catalog, assetRoot: catalog };

function typeOf(id: string) {
  const loaded = loadTypeById(catalog, opts, id);
  if (!("type" in loaded)) throw new Error(`${id} did not load`);
  return loaded.type;
}

function edgesAt(id: string, port: string, vcc: number) {
  const logic = typeOf(id).ports[port]?.ratings?.logic;
  const edges = logicThresholds(logic, vcc);
  return [edges.vil, edges.vih].map((v) =>
    v === null ? null : Number(v.toFixed(6))
  );
}

{
  const cases: [string, string, number, (number | null)[]][] = [
    ["atmega328p", "PB1", 5, [1.5, 3]],
    ["arduino-nano", "D2", 5, [1.5, 3]],
    ["arduino-nano", "D2", 3.3, [0.99, 1.98]],
    ["arduino-nano", "RESET", 5, [0.5, 4.5]],
    ["arduino-uno-r3", "RESET", 5, [0.5, 4.5]],
    ["atmega32u4", "PB0", 5, [0.9, 1.9]],
    ["sparkfun-pro-micro", "RST", 5, [null, null]],
  ];
  for (const [id, port, vcc, want] of cases) {
    const got = edgesAt(id, port, vcc);
    expect(
      JSON.stringify(got) === JSON.stringify(want),
      `${id}.${port} at ${vcc} V: ${JSON.stringify(got)}, want ${JSON.stringify(want)}`
    );
  }
  console.log(
    "pin-thresholds: Nano D2 1.5 / 3.0 V at 5 V and 0.99 / 1.98 V at 3.3 V; 328P RESET 0.5 / 4.5 V; 32U4 GPIO 0.9 / 1.9 V; Pro Micro RST has none"
  );
}

const dir = fileURLToPath(new URL("../fixtures/schmitt/", import.meta.url));
const world = "schmitt.world.json";

{
  const loaded = loadWorldV2(`${dir}${world}`, {
    store: nodeStore,
    catalogDir: catalog,
    assetRoot: dir,
  });
  const errors = loaded.diagnostics.filter((d) => d.severity === "error");
  expect(errors.length === 0, errors.map((d) => d.message).join("; "));
  console.log("pin-thresholds: the RC fixture loads with no rating error");
}

async function runWorld(ms: number): Promise<RecordingRead> {
  const seen: { state: WorldState | null; failed: string | null } = {
    state: null,
    failed: null,
  };
  const attached = await attachWorld(dir, world, {
    sender: { kind: "loopback", label: "Mac" },
    onEvent(event) {
      if (event.type === "error") {
        seen.failed =
          event.message ?? event.errors.map((item) => item.message).join("; ");
      }
      if (event.type === "state") seen.state = event.state;
    },
  });
  if ("error" in attached) throw new Error(attached.error);
  try {
    attached.step(ms);
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (seen.failed) throw new Error(seen.failed);
      if ((seen.state?.simTime ?? -1) >= ms / 1000 - 1e-3) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const read = await readRecording(dir, world, { from: 0, to: ms / 1000 });
    if ("error" in read) throw new Error(read.error);
    return read;
  } finally {
    attached.detach();
    await stopWorld(dir, world);
    closeRootWatches();
  }
}

function field(text: string, name: string): number {
  const match = text.match(new RegExp(`${name},(\\d+)`));
  expect(
    match?.[1] !== undefined,
    `missing ${name} in ${JSON.stringify(text)}`
  );
  return Number(match?.[1]);
}

{
  const read = await runWorld(250);
  let text = "";
  for (const event of read.events) {
    if (event.kind === "serial" && event.board === "nano") text += event.text;
  }
  const R = 10_000;
  const C = 1e-6;
  // The pin drive is the chip part's fit; the analytic answer uses it.
  const chip = JSON.parse(
    readFileSync(join(catalog, "parts/sfab/atmega328p@1.0.0.json"), "utf8")
  );
  const { roh, rol } = chip.axes.behaviour["1"].variants.avr8js.params;
  const tauUp = (R + roh) * C;
  const tauDown = (R + rol) * C;
  const highFor = 0.05;
  const riseUs = -tauUp * Math.log(1 - 0.6) * 1e6;
  const peak = 1 - Math.exp(-highFor / tauUp);
  const fallUs = tauDown * Math.log(peak / 0.3) * 1e6;
  const start = field(text, "start");
  const rise = field(text, "rise");
  const fall = field(text, "fall");
  expect(start === 0, `D2 started ${start}`);
  // The CPU reads the solve that ended the master step (1 ms) the node
  // crossed in: up to one step late, never early. 50 µs covers micros()'
  // 4 µs tick and the edge's place inside its step.
  const late = (got: number, want: number) =>
    got >= want - 50 && got <= want + 1050;
  expect(late(rise, riseUs), `rise ${rise} µs vs ${riseUs.toFixed(0)} µs`);
  expect(late(fall, fallUs), `fall ${fall} µs vs ${fallUs.toFixed(0)} µs`);
  console.log(
    `pin-thresholds: D2 rises ${rise} µs after D9 (0.6·VCC at ${riseUs.toFixed(0)} µs), falls ${fall} µs after (0.3·VCC at ${fallUs.toFixed(0)} µs; one threshold at VCC/2 would be ${(tauDown * Math.log(peak / 0.5) * 1e6).toFixed(0)} µs)`
  );
}
