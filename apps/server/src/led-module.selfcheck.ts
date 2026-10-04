/**
 * A red LED and a 220 Ω resistor, as a circuit or as one `diode@1` fitted
 * to the plain-branch sweep, bound to the module's `IN` and `GND`.
 * The example holds D9 high. No sketch in the tree PWMs that pin.
 */

import { ok as expect } from "node:assert/strict";
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

import {
  pinBitSet,
  type SnapshotFile,
  type WorldState,
} from "@sfab-bench/contract";
import { branchDc } from "@sfab-bench/sim";
import { type CaptureFile, captureFromConfig } from "./capture";
import { closeRootWatches } from "./projects";
import { assemblyStampOf } from "./world/circuit-stamp";
import { attachWorld, stopWorld } from "./world/host";
import { planWorld } from "./world/plan";

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
  return pinBitSet(pins.ddr, bit) && pinBitSet(pins.level, bit);
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
      expect(
        row?.form === "diode@1" &&
          row.nodes.A !== undefined &&
          row.nodes.K !== undefined,
        `module form ${row?.form} nodes ${JSON.stringify(row?.nodes)}`
      );
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
    const attached = await attachWorld(
      dir,
      "parts/sfab/nano-led-module@1.0.0.json",
      {
        sender: { kind: "loopback", label: "Mac" },
        onEvent(event) {
          if (event.type === "error") {
            seen.failed =
              event.message ??
              event.errors.map((item) => item.message).join("; ");
          }
          if (event.type === "state" && event.report)
            seen.report = event.report;
        },
      }
    );
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
  const dir = mkdtempSync(join(tmpdir(), "sfab-led-bind-"));
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
    const across = structuredClone(snap);
    across.params.across = ["NOPE", "GND"];
    writeFileSync(snapPath, `${JSON.stringify(across)}\n`);
    const acrossPlan = planWorld(dir, "parts/sfab/nano-led-module@1.0.0.json");
    const acrossSaid = acrossPlan.ok
      ? [
          ...(acrossPlan.plan.degraded ?? []),
          ...(acrossPlan.plan.report?.errors ?? []),
        ]
      : acrossPlan.errors;
    expect(
      acrossSaid.some((item) =>
        item.message.includes("across port NOPE is not on led-module")
      ),
      `no across-port diagnostic: ${acrossSaid.map((item) => item.message).join(" | ")}`
    );
    snap.bind = { A: "NOPE", K: "GND" };
    writeFileSync(snapPath, `${JSON.stringify(snap)}\n`);
    const planned = planWorld(dir, "parts/sfab/nano-led-module@1.0.0.json");
    expect(planned.ok, "bad bind port did not run");
    if (!planned.ok) throw new Error("unreachable");
    const said = [
      ...(planned.plan.degraded ?? []),
      ...(planned.plan.report?.errors ?? []),
    ];
    const hit = said.find((item) =>
      item.message.includes("NOPE is not on led-module")
    );
    expect(
      hit &&
        !planned.plan.boards.some((board) =>
          board.stamp?.parts.some((part) => part.path === "module")
        ),
      `no bind-port diagnostic: ${said.map((item) => item.message).join(" | ")}`
    );
    if (!hit) throw new Error("unreachable");
    console.log(`degraded ${hit.path}: ${hit.message}`);
    // A refused snapshot says why once; it never also claims a table.
    expect(
      !said.some((item) => item.message.includes("table@1")),
      `a refused diode snapshot also says table@1: ${said.map((item) => item.message).join(" | ")}`
    );
    // A key the form does not stamp is refused too, not left to the stamp.
    const key = structuredClone(snap);
    key.bind = { anode: "IN", K: "GND" };
    writeFileSync(snapPath, `${JSON.stringify(key)}\n`);
    const keyPlan = planWorld(dir, "parts/sfab/nano-led-module@1.0.0.json");
    const keySaid = keyPlan.ok
      ? [
          ...(keyPlan.plan.degraded ?? []),
          ...(keyPlan.plan.report?.errors ?? []),
        ]
      : keyPlan.errors;
    const keyHit = keySaid.find((item) =>
      item.message.includes("diode@1 stamps no port anode")
    );
    expect(
      keyHit?.path === "module" &&
        !keySaid.some((item) => item.message.includes("table@1")),
      `no bind-key diagnostic: ${keySaid.map((item) => item.message).join(" | ")}`
    );
    console.log(`degraded ${keyHit.path}: ${keyHit.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The guard: a converged point whose current is the solver's gmin leak is
// not the part's drop. Backwards, the LED blocks, and 1 µA can only flow
// through gmin (about −1 MV). Forward, the class-2 knee and 2 mA still read.
{
  const stamp = assemblyStampOf("sfab/led-module-red@1.0.0", "netlist", {
    boardId: "module",
    across: ["IN", "GND"],
  });
  let refused = "";
  try {
    branchDc(stamp, "IN", "GND", -1e-6);
  } catch (err) {
    refused = messageOf(err);
  }
  expect(refused.includes("gmin leak"), `reverse 1 µA: ${refused || "read"}`);
  const knee = branchDc(stamp, "IN", "GND", 3.7e-6);
  const twoMa = branchDc(stamp, "IN", "GND", 2e-3);
  expect(
    Math.abs(knee - 1.317328) < 1e-6 && Math.abs(twoMa - 2.142192) < 1e-6,
    `forward ${knee} V, ${twoMa} V`
  );
  console.log(
    `branchDc guard: reverse 1 µA refused (${refused}); knee ${knee.toFixed(6)} V, 2 mA ${twoMa.toFixed(6)} V`
  );
}

// The run checks a snapshot that runs as a circuit form at the part's own
// ports. A copy of the module's snapshot bounded at 5 mA, with D9 high
// (about 11 mA), warns once at `IN` and lists it on the report row.
{
  const dir = mkdtempSync(join(tmpdir(), "sfab-led-envelope-"));
  const world = "parts/sfab/nano-led-module@1.0.0.json";
  try {
    cpSync(nanoExample, dir, { recursive: true });
    rmSync(join(dir, "parts/sfab/nano-led-module@1.0.0.lock.json"));
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
    snap.envelope.bounds = { "IN.current": [0, 0.005] };
    writeFileSync(
      join(dir, "snapshots", "sfab", "led-module-red@1.0.0.json"),
      `${JSON.stringify(snap)}\n`
    );
    const seen: {
      report: {
        snapshots: { path: string; ref: string; envelope?: string[] }[];
        warnings: { code: string; path: string; message: string }[];
      } | null;
      failed: string | null;
    } = { report: null, failed: null };
    const attached = await attachWorld(dir, world, {
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
      attached.step(400);
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline && !seen.failed) {
        const hit = seen.report?.warnings.some(
          (item) => item.code === "envelope" && item.path === "module"
        );
        if (hit) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (seen.failed) throw new Error(seen.failed);
      const warned = (seen.report?.warnings ?? []).filter(
        (item) => item.code === "envelope" && item.path === "module"
      );
      const row = seen.report?.snapshots.find((item) => item.path === "module");
      expect(
        warned.length === 1 &&
          warned[0]?.message.includes("module port IN quantity Current") &&
          row?.envelope?.length === 1,
        `module envelope: ${JSON.stringify(warned)} row ${JSON.stringify(row?.envelope)}`
      );
      console.log(`led-module envelope: ${warned[0]?.message}`);
    } finally {
      attached.detach();
      await stopWorld(dir, world);
      closeRootWatches();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
