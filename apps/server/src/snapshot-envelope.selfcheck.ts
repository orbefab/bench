/**
 * C1 envelope: a table snapshot driven outside its range warns once per path
 * and ref, naming the bound, and the run goes on. Two Nanos are fed on their
 * 5V pins, each with an LED module on VBUS. The SS14 blocks that path; the
 * class-1 table extrapolates its first segment instead and carries the LED
 * current backwards, below the 0 A bound. Above the bound is
 * snapshot.selfcheck's stalled-servo run.
 */

import { ok as expect } from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { RunReport, WorldState } from "@sfab-bench/contract";

import { closeRootWatches } from "./projects";
import { attachWorld, stopWorld } from "./world/host";

const SNAPSHOT_ID = "sfab/nano-power-input@1.0.0";
const nanoDir = fileURLToPath(
  new URL("../../../examples/nano/", import.meta.url)
);

const none = (what: string) => ({
  "0": {
    default: "none",
    variants: { none: { kind: "none", omits: [`assembly adds no ${what}`] } },
  },
});

function writeScene(dir: string): void {
  const nano = {
    part: "sfab/nano-ch340@1.0.0",
    params: {
      firmware: "firmware/vcc/vcc.hex",
      source: "firmware/vcc/vcc.ino",
    },
  };
  const wires: [string, string][] = [];
  for (const [board, led, supply] of [
    ["nano", "led", "bench"],
    ["nano2", "led2", "bench2"],
  ]) {
    wires.push(
      [`${supply}.5V`, `${board}.5V`],
      [`${supply}.GND`, `${board}.GND`],
      [`${led}.IN`, `${board}.VBUS`],
      [`${led}.GND`, `${board}.GND`]
    );
  }
  const pose = { position: [0.2, 0, 0], rotation: [1, 0, 0, 0] };
  writeFileSync(
    join(dir, "parts", "sfab", "backfeed-scene@1.0.0.json"),
    JSON.stringify({
      format: "sfab.part@1",
      id: "sfab/backfeed-scene@1.0.0",
      type: "assembly",
      foreign: false,
      axes: {
        behaviour: {
          "2": {
            default: "netlist",
            variants: {
              netlist: {
                kind: "composite",
                omits: ["no snapshot of this assembly"],
                netlist: {
                  instances: {
                    nano,
                    nano2: { ...nano, pose },
                    led: { part: "sfab/led-module-red@1.0.0" },
                    led2: { part: "sfab/led-module-red@1.0.0", pose },
                    bench: { part: "sfab/bench-supply@1.0.0" },
                    bench2: { part: "sfab/bench-supply@1.0.0", pose },
                  },
                  wires,
                  expose: {},
                },
              },
            },
          },
        },
        body: none("body"),
        visual: none("visual"),
      },
    })
  );
  for (const [name, level] of [
    ["backfeed-1", 1],
    ["backfeed-2", 2],
  ] as const) {
    writeFileSync(
      join(dir, `${name}.world.json`),
      JSON.stringify({
        version: 2,
        environment: { ground: { plane: true }, gravity: [0, 0, -9.81] },
        run: { seed: 1, levels: { default: level } },
        root: { id: "scene", part: "sfab/backfeed-scene@1.0.0" },
      })
    );
  }
}

async function run(
  dir: string,
  world: string,
  ms: number
): Promise<{ report: RunReport | null; state: WorldState | null }> {
  const seen: {
    state: WorldState | null;
    report: RunReport | null;
    failed: string | null;
  } = { state: null, report: null, failed: null };
  const attached = await attachWorld(dir, world, {
    sender: { kind: "loopback", label: "Mac" },
    onEvent(event) {
      if (event.type === "error") {
        seen.failed =
          event.message ?? event.errors.map((item) => item.message).join("; ");
      }
      if (event.type === "state") {
        seen.state = event.state;
        if (event.report) seen.report = event.report;
      }
    },
  });
  if ("error" in attached) throw new Error(attached.error);
  try {
    attached.step(ms);
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (seen.failed) throw new Error(seen.failed);
      if ((seen.state?.simTime ?? -1) >= ms / 1000 - 1e-3) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!seen.state || seen.state.simTime < ms / 1000 - 1e-3) {
      throw new Error(`${world} timed out at ${seen.state?.simTime} s`);
    }
  } finally {
    attached.detach();
    await stopWorld(dir, world);
    closeRootWatches();
  }
  return seen;
}

const dir = mkdtempSync(join(tmpdir(), "sfab-envelope-"));
try {
  cpSync(nanoDir, dir, { recursive: true });
  writeScene(dir);

  const low = await run(dir, "backfeed-1.world.json", 300);
  const warnings = (low.report?.warnings ?? []).filter((row) =>
    row.message.includes("envelope exceeded")
  );
  const lines = warnings.map((row) => row.message).join("\n");
  expect(
    warnings.length === 2,
    `envelope warnings ${warnings.length}:\n${lines}`
  );
  for (const path of ["nano.power", "nano2.power"]) {
    const row = warnings.find((item) => item.path === path);
    expect(row, `${path} did not warn:\n${lines}`);
    expect(
      row?.port === "VBUS" &&
        row.quantity === "Current" &&
        row.right === "0..0.9" &&
        Number(row.left) < 0 &&
        row.message.includes(SNAPSHOT_ID),
      `${path} warning does not name the bound: ${row?.message}`
    );
    const snapshot = low.report?.snapshots.find(
      (item) => item.path === path && item.ref === SNAPSHOT_ID
    );
    expect(
      snapshot?.envelope?.length === 1,
      `${path} snapshot row holds ${snapshot?.envelope?.length} envelope notes`
    );
  }
  const reverse = -Number(warnings[0]?.left);
  console.log(`snapshot-envelope: class 1, 300 ms: ${warnings[0]?.message}`);

  const high = await run(dir, "backfeed-2.world.json", 300);
  expect(
    (high.report?.warnings ?? []).length === 0,
    `class 2 warned: ${high.report?.warnings.map((row) => row.message).join("; ")}`
  );
  const supply = (state: WorldState | null) =>
    (state?.supplies?.bench?.current ?? 0) * 1000;
  console.log(
    `snapshot-envelope: one warning per path and ref (nano.power, nano2.power); the table carries ${(reverse * 1000).toFixed(2)} mA back into VBUS where the SS14 blocks (bench ${supply(low.state).toFixed(2)} mA at class 1, ${supply(high.state).toFixed(2)} mA at class 2, no warning)`
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
