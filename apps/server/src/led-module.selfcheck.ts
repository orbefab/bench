/**
 * A red LED and a 220 Ω resistor, as a circuit or as one plain-branch table.
 * The example holds D9 high. No sketch in the tree PWMs that pin.
 */

import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { SnapshotFile, WorldState } from "@sfab-bench/contract";
import { type CaptureFile, captureFromConfig } from "./capture";
import { closeRootWatches } from "./projects";
import { assemblyStampOf } from "./world/circuit-stamp";
import { attachWorld, stopWorld } from "./world/host";
import { planWorld } from "./world/plan";

function expect(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(label);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const nanoExample = fileURLToPath(
  new URL("../../../examples/nano/", import.meta.url)
);

async function runWorld(dir: string, world: string): Promise<WorldState> {
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
  const ms = 400;
  try {
    attached.step(ms);
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (seen.failed) throw new Error(seen.failed);
      if ((seen.state?.simTime ?? -1) >= ms / 1000 - 1e-3) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!seen.state) throw new Error(`${world} published no state`);
    return seen.state;
  } finally {
    attached.detach();
    await stopWorld(dir, world);
    closeRootWatches();
  }
}

function pinHigh(state: WorldState, bit: number): boolean {
  const pins = state.boards.nano?.pins;
  if (!pins) return false;
  return ((pins.ddr >> bit) & 1) === 1 && ((pins.level >> bit) & 1) === 1;
}

{
  const dir = mkdtempSync(join(tmpdir(), "sfab-led-module-"));
  try {
    cpSync(nanoExample, dir, { recursive: true });
    const world = JSON.parse(
      readFileSync(join(dir, "parts/sfab/nano-led-module@1.0.0.json"), "utf8")
    ) as {
      run?: { levels: { paths?: Record<string, { behaviour: number }> } };
      play?: { levels: { paths?: Record<string, { behaviour: number }> } };
    };
    const levels = world.play?.levels ?? world.run?.levels;
    if (!levels) throw new Error("led module has no levels");
    levels.paths = { module: { behaviour: 2 } };
    writeFileSync(
      join(dir, "nano-led-module-c2.world.json"),
      `${JSON.stringify(world, null, 2)}\n`
    );
    const low = await runWorld(dir, "parts/sfab/nano-led-module@1.0.0.json");
    const high = await runWorld(dir, "nano-led-module-c2.world.json");
    expect(pinHigh(low, 9) && pinHigh(high, 9), "D9 is not driven HIGH");
    const supply = (state: WorldState) =>
      Object.values(state.supplies ?? {})[0]?.current ?? Number.NaN;
    const rail = (state: WorldState) =>
      state.boards.nano?.voltage ?? Number.NaN;
    const i1 = supply(low);
    const i2 = supply(high);
    const v1 = rail(low);
    const v2 = rail(high);
    const leds1 = low.boards.nano?.leds ?? {};
    const leds2 = high.boards.nano?.leds ?? {};
    console.log(
      `led-module: class 1 supply ${i1.toFixed(6)} A, class 2 supply ${i2.toFixed(6)} A, Δ ${Math.abs(i1 - i2).toExponential(3)} A; 5V ${v1.toFixed(4)} V vs ${v2.toFixed(4)} V, Δ ${Math.abs(v1 - v2).toExponential(3)} V`
    );
    console.log(
      `led-module leds class 1: ${JSON.stringify(leds1)} (no inner LED at the snapshot); class 2: ${JSON.stringify(leds2)}`
    );
    const planned = planWorld(dir, "parts/sfab/nano-led-module@1.0.0.json");
    expect(planned.ok, "class 1 module did not plan");
    if (planned.ok) {
      const row = planned.plan.boards
        .flatMap((board) => board.stamp?.parts ?? [])
        .find((part) => part.path === "module");
      expect(row?.form === "table@1", `module form ${row?.form}`);
    }
    const report = low.boards.nano ? "ran" : "missing";
    expect(report === "ran", "no board");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = mkdtempSync(join(tmpdir(), "sfab-led-report-"));
  try {
    cpSync(nanoExample, dir, { recursive: true });
    const seen: {
      report: {
        snapshots: { path: string; quality: string; ref: string }[];
      } | null;
      failed: string | null;
      state: WorldState | null;
    } = {
      report: null,
      failed: null,
      state: null,
    };
    const attached = await attachWorld(dir, "parts/sfab/nano-led-module@1.0.0.json", {
      sender: { kind: "loopback", label: "Mac" },
      onEvent(event) {
        if (event.type === "error") {
          seen.failed =
            event.message ??
            event.errors.map((item) => item.message).join("; ");
        }
        if (event.type === "state" && event.report) seen.report = event.report;
      },
    });
    if ("error" in attached) throw new Error(attached.error);
    try {
      attached.step(50);
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && !seen.report && !seen.failed) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (seen.failed) throw new Error(seen.failed);
      const row = seen.report?.snapshots.find((item) => item.path === "module");
      expect(row, "report has no module snapshot");
      console.log(
        `led-module report: ${row?.path} ${row?.quality} ${row?.ref}`
      );
    } finally {
      attached.detach();
      await stopWorld(dir, "parts/sfab/nano-led-module@1.0.0.json");
      closeRootWatches();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const config = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL("../catalog/fixtures/capture.config.json", import.meta.url)
      ),
      "utf8"
    )
  ) as CaptureFile;
  const entry = structuredClone(
    config.entries.find((row) => row.id === "sfab/nano-power-input@1.0.0")
  );
  expect(entry, "power-input capture entry");
  if (!entry) throw new Error("power-input capture entry");
  delete entry.across;
  try {
    await captureFromConfig({
      config: { created: config.created, tool: config.tool, entries: [entry] },
    });
    throw new Error("missing across was accepted");
  } catch (err) {
    const text = messageOf(err);
    expect(text.includes("no across"), text);
    console.log(`reject no across: ${text}`);
  }
}

{
  const part = "sfab/sg90@1.0.0";
  try {
    assemblyStampOf(part, "netlist");
    throw new Error("non-circuit leaf was accepted");
  } catch (err) {
    const text = messageOf(err);
    expect(text.includes("is not a circuit leaf"), text);
    console.log(`reject non-circuit leaf: ${text}`);
  }
}

{
  const dir = mkdtempSync(join(tmpdir(), "sfab-led-across-"));
  try {
    cpSync(nanoExample, dir, { recursive: true });
    rmSync(join(dir, "parts/sfab/nano-led-module@1.0.0.lock.json"));
    const snapPath = join(
      dir,
      "snapshots",
      "sfab",
      "led-module-red@1.0.0.json"
    );
    mkdirSync(join(dir, "snapshots", "sfab"), { recursive: true });
    const snap = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(
            "../catalog/snapshots/sfab/led-module-red@1.0.0.json",
            import.meta.url
          )
        ),
        "utf8"
      )
    ) as SnapshotFile;
    const params = snap.params as { across?: string[] };
    params.across = ["NOPE", "GND"];
    writeFileSync(snapPath, `${JSON.stringify(snap)}\n`);
    const planned = planWorld(dir, "parts/sfab/nano-led-module@1.0.0.json");
    expect(planned.ok, "bad across port did not run");
    if (!planned.ok) throw new Error("unreachable");
    const hit = (planned.plan.degraded ?? []).find((item) =>
      item.message.includes("across port NOPE")
    );
    expect(hit, "no across-port diagnostic");
    console.log(`degraded ${hit.path}: ${hit.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
