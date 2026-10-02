/**
 * The Nano's power group at class 2 matches the loose diode and capacitor,
 * and its snapshot is a plain branch the board can run in their place.
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

import type {
  RecordingRead,
  RunReport,
  SnapshotFile,
  WorldState,
} from "@sfab-bench/contract";
import { tableLawOf } from "@sfab-bench/parts";
import { branchDc } from "@sfab-bench/sim";
import { NANO_BOARD_A } from "@sfab-bench/sim/power-path";
import { createRailCircuit } from "@sfab-bench/sim/rail-circuit";
import { closeRootWatches } from "./projects";
import { assemblyStampOf, boardStampOf } from "./world/circuit-stamp";
import { attachWorld, readRecording, stopWorld } from "./world/host";
import { catalogRoot } from "./world/plan";

const law = { k: 0.458, resistance: 7.1, quiescent: 0.01 };
const usb = { voltage: 5, rSeries: 0.5, currentLimit: 0.9 };
const FLAT_REST = 4.7132641361241063;
const FLAT_STALL = 4.2645668254013147;
const VCC_SCALE = 1_125_300;

function nodeAt(fraction: number, connected: boolean): number {
  const stamp = boardStampOf("sfab/nano-ch340@1.0.0", "circuits", {
    boardId: "nano",
  });
  const circuit = createRailCircuit({
    vNom: usb.voltage,
    rSeries: usb.rSeries,
    iLimit: usb.currentLimit,
    motors: [{ resistance: law.resistance, k: law.k }],
    stamp,
    feed: "usb",
  });
  circuit.setFixed(NANO_BOARD_A + law.quiescent);
  circuit.setPin("D13", "input");
  circuit.setMotor(0, fraction, 0, connected);
  for (let i = 0; i < 80; i++) circuit.solve();
  return circuit.boardVoltage;
}

{
  const rest = nodeAt(0, false);
  const stall = nodeAt(1, true);
  const dRest = Math.abs(rest - FLAT_REST);
  const dStall = Math.abs(stall - FLAT_STALL);
  expect(dRest <= 1e-12, `power-input rest Δ ${dRest} V`);
  expect(dStall <= 1e-12, `power-input stall Δ ${dStall} V`);
  console.log(
    `power-input group: rest ${rest.toFixed(6)} V (Δ ${dRest.toExponential(2)} V), stall ${stall.toFixed(6)} V (Δ ${dStall.toExponential(2)} V)`
  );
}

{
  const file = join(
    catalogRoot(),
    "snapshots",
    "sfab",
    "nano-power-input@1.0.0.json"
  );
  const snap = JSON.parse(readFileSync(file, "utf8")) as SnapshotFile;
  const table = tableLawOf(snap);
  expect(table, "power-input snapshot has no table");
  if (!table) throw new Error("power-input snapshot has no table");
  const stamp = assemblyStampOf("sfab/nano-power-input@1.0.0", "netlist", {
    boardId: "power",
    across: table.across,
  });
  let knot = 0;
  for (let i = 0; i < table.iAxis.length; i++) {
    const amps = table.iAxis[i] ?? 0;
    const got = branchDc(stamp, table.across[0], table.across[1], amps);
    knot = Math.max(knot, Math.abs(got - (table.vAxis[i] ?? 0)));
  }
  const rows = snap.error;
  if (!Array.isArray(rows))
    throw new Error("power-input snapshot has no static error");
  const interp = rows.find((row) => row.metric === "static-max-abs");
  expect(interp, "power-input snapshot has no static error");
  expect(knot <= 1e-6, `knot error ${knot} V`);
  expect((interp?.value ?? 1) <= 0.002, `interpolation ${interp?.value} V`);
  console.log(
    `power-input snapshot: knots ${table.iAxis.length}, knot error ${(knot * 1e6).toFixed(3)} µV, interpolation ${((interp?.value ?? 0) * 1000).toFixed(3)} mV, lint ${snap.quality}`
  );
}

const nanoExample = fileURLToPath(
  new URL("../../../examples/nano/", import.meta.url)
);
const gaugeExample = fileURLToPath(
  new URL("../../../examples/gauge/", import.meta.url)
);

type Ran = {
  serial: string;
  voltages: number[];
  leds: number[];
  angles: number[];
  resets: number;
  report: RunReport;
};

async function runProject(
  dir: string,
  world: string,
  ms: number
): Promise<Ran> {
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
    const deadline = Date.now() + Math.max(180_000, ms * 40);
    while (Date.now() < deadline) {
      if (seen.failed) throw new Error(seen.failed);
      if ((seen.state?.simTime ?? -1) >= ms / 1000 - 1e-3) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!seen.state || seen.state.simTime < ms / 1000 - 1e-3) {
      throw new Error(`${world} timed out`);
    }
    const read = await readRecording(dir, world, { from: 0, to: ms / 1000 });
    if ("error" in read) throw new Error(read.error);
    return {
      serial: serialOf(read),
      voltages: read.frames.map(
        (frame) => frame.boards.nano?.voltage ?? Number.NaN
      ),
      leds: read.frames.map(
        (frame) => frame.boards.nano?.leds?.["nano.led"] ?? Number.NaN
      ),
      angles: read.frames.map(
        (frame) => frame.joints.gauge?.servo ?? Number.NaN
      ),
      resets: seen.state.boards.nano?.resets ?? 0,
      report: seen.report ?? failReport(world),
    };
  } finally {
    attached.detach();
    await stopWorld(dir, world);
    closeRootWatches();
  }
}

function failReport(world: string): never {
  throw new Error(`${world} published no report`);
}

function serialOf(read: RecordingRead): string {
  let text = "";
  for (const event of read.events) {
    if (event.kind === "serial" && event.board === "nano")
      text += event.text ?? "";
  }
  return text;
}

function withPowerLevel(file: string, out: string): void {
  const world = JSON.parse(readFileSync(file, "utf8")) as {
    run?: { levels: { paths?: Record<string, { behaviour: number }> } };
    play?: { levels: { paths?: Record<string, { behaviour: number }> } };
  };
  const levels = world.play?.levels ?? world.run?.levels;
  if (!levels) throw new Error("document has no levels");
  levels.paths = {
    ...(levels.paths ?? {}),
    "nano.power": { behaviour: 1 },
  };
  writeFileSync(out, `${JSON.stringify(world, null, 2)}\n`);
}

function vccCounts(serial: string): number[] {
  return serial
    .split(/\r?\n/)
    .map((line) => /^vcc,(\d+)/.exec(line.trim()))
    .filter((hit): hit is RegExpExecArray => hit !== null)
    .map((hit) => Math.round(VCC_SCALE / Number(hit[1])));
}

function seriesDelta(a: number[], b: number[]): { max: number; rms: number } {
  const n = Math.min(a.length, b.length);
  expect(n > 0, "no samples");
  let max = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs((a[i] ?? 0) - (b[i] ?? 0));
    if (d > max) max = d;
    sum += d * d;
  }
  return { max, rms: Math.sqrt(sum / n) };
}

{
  const dir = mkdtempSync(join(tmpdir(), "sfab-power-mix-"));
  try {
    cpSync(nanoExample, dir, { recursive: true });
    withPowerLevel(
      join(dir, "parts/sfab/nano-vcc-usb@1.0.0.json"),
      join(dir, "nano-vcc-mixed.world.json")
    );
    const full = await runProject(
      dir,
      "parts/sfab/nano-vcc-usb@1.0.0.json",
      1200
    );
    const mixed = await runProject(dir, "nano-vcc-mixed.world.json", 1200);
    const again = await runProject(dir, "nano-vcc-mixed.world.json", 1200);
    const rail = seriesDelta(full.voltages, mixed.voltages);
    const led = seriesDelta(full.leds, mixed.leds);
    const counts = vccCounts(full.serial);
    const mixedCounts = vccCounts(mixed.serial);
    expect(
      counts.length > 0 && counts.length === mixedCounts.length,
      "vcc lines"
    );
    let countDelta = 0;
    for (let i = 0; i < counts.length; i++) {
      countDelta = Math.max(
        countDelta,
        Math.abs((counts[i] ?? 0) - (mixedCounts[i] ?? 0))
      );
    }
    expect(countDelta <= 1, `vcc ADC counts differ by ${countDelta}`);
    const row = mixed.report.snapshots.find(
      (item) => item.path === "nano.power"
    );
    expect(row, "report has no nano.power snapshot");
    expect(
      (row?.envelope ?? []).length === 0 && mixed.report.warnings.length === 0,
      `mixed run warned ${mixed.report.warnings.map((item) => item.message).join("; ")}`
    );
    expect(
      mixed.serial === again.serial &&
        mixed.voltages.join(",") === again.voltages.join(","),
      "mixed nano-vcc repeat differed"
    );
    console.log(
      `power-input mixed nano-vcc: 5V max-abs ${(rail.max * 1000).toFixed(3)} mV, rms ${(rail.rms * 1000).toFixed(3)} mV, vcc within ${countDelta} ADC count, D13 Δ ${(led.max * 1000).toFixed(3)} mA, no warning, repeat byte-identical, report ${row?.path} ${row?.quality} ${row?.ref}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = mkdtempSync(join(tmpdir(), "sfab-power-gauge-"));
  try {
    cpSync(gaugeExample, dir, { recursive: true });
    withPowerLevel(
      join(dir, "parts/sfab/gauge-usb@1.0.0.json"),
      join(dir, "gauge-mixed.world.json")
    );
    const started = Date.now();
    const full = await runProject(dir, "parts/sfab/gauge-usb@1.0.0.json", 7000);
    const mixed = await runProject(dir, "gauge-mixed.world.json", 7000);
    if (process.env.BENCH_TIMINGS === "1")
      console.log(
        `INFO mixed gauge: ${((Date.now() - started) / 1000).toFixed(1)} s wall`
      );
    const measure = (text: string) =>
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^\d+,/.test(line));
    const a = measure(full.serial);
    const b = measure(mixed.serial);
    expect(a.length > 0 && a.join("\n") === b.join("\n"), "gauge lines differ");
    const counts = vccCounts(full.serial);
    const mixedCounts = vccCounts(mixed.serial);
    expect(
      counts.length > 0 && counts.length === mixedCounts.length,
      "vcc lines"
    );
    let countDelta = 0;
    for (let i = 0; i < counts.length; i++) {
      countDelta = Math.max(
        countDelta,
        Math.abs((counts[i] ?? 0) - (mixedCounts[i] ?? 0))
      );
    }
    expect(countDelta <= 1, `vcc ADC counts differ by ${countDelta}`);
    const rail = seriesDelta(full.voltages, mixed.voltages);
    const flag = seriesDelta(full.angles, mixed.angles);
    const warned =
      mixed.report.warnings.length > 0 ||
      (mixed.report.snapshots.find((item) => item.path === "nano.power")
        ?.envelope?.length ?? 0) > 0;
    expect(!warned, "mixed gauge warned");
    expect(full.resets === 0 && mixed.resets === 0, "gauge reset");
    console.log(
      `power-input mixed gauge: ${a.length} us,d_cm,angle lines identical, vcc within ${countDelta} ADC count, 5V max-abs ${(rail.max * 1000).toFixed(3)} mV, rms ${(rail.rms * 1000).toFixed(3)} mV, flag max Δ ${((flag.max * 180) / Math.PI).toFixed(3)} deg, no warning, no resets`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
