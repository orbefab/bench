/**
 * ptc-fuse@1 and pmos-switch@1 outside the Uno cable, and the Uno
 * power-input group captured as a table. The fuse's thermal step and
 * the MOSFET's gate are per instance, in any stamped circuit.
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

import type {
  PartFile,
  RecordingRead,
  RunReport,
  SnapshotFile,
} from "@sfab-bench/contract";
import {
  AVR_PIN,
  CurrentLoad,
  Engine,
  ISource,
  MF_MSMF050,
  PmosChannel,
  PtcFuseElement,
  type PtcFuseParams,
  TheveninLimit,
  thermalVoltage,
  VSource,
} from "@sfab-bench/engine-circuit";
import {
  type Library,
  lintLibrary,
  loadPartById,
  loadTypeById,
  tableLawOf,
} from "@sfab-bench/parts";
import { closeRootWatches } from "./projects";
import {
  type AssignedPart,
  assemblyStampOf,
  type BoardStamp,
  boardStampOf,
  realize,
} from "./world/circuit-stamp";
import { attachWorld, readRecording, stopWorld } from "./world/host";
import { nodeStore } from "./world/node-store";
import { catalogRoot, planWorld } from "./world/plan";
import { BOARD_LOAD_KNEE_V, railAttachment } from "./world/power-path";
import { createRailCircuit, type RailCircuit } from "./world/rail-circuit";
import { branchDc } from "./world/snapshot-dc";
import { UnoReferenceRail } from "./world/uno-reference";
import { powerFeedsOf } from "./world/wiring";

function expect(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(label);
}

function readPart(id: string): PartFile {
  const file = join(catalogRoot(), "parts", "sfab", `${id}.json`);
  return JSON.parse(readFileSync(file, "utf8")) as PartFile;
}

function formParams(part: PartFile): Record<string, number> {
  const slot = part.axes?.behaviour?.["1"];
  const variant = slot ? Object.values(slot.variants)[0] : null;
  if (!variant || variant.kind !== "form") {
    throw new Error(`${part.id} has no class-1 form`);
  }
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(variant.params)) {
    if (typeof value !== "number") throw new Error(`${part.id} ${key}`);
    out[key] = value;
  }
  return out;
}

const fusePart = readPart("mf-msmf050@1.0.0");
const fuseParams = formParams(fusePart) as PtcFuseParams;
const mosParams = formParams(readPart("fdn340p@1.0.0"));
expect(
  fuseParams.tau === MF_MSMF050.tau,
  "catalog tau drifted from the 8 A fit"
);
expect(fuseParams.rCold === MF_MSMF050.rCold, "catalog rCold");
expect(fuseParams.rHot === MF_MSMF050.rHot, "catalog rHot");
{
  const vt = thermalVoltage(25);
  const is = 0.42 / (Math.exp(0.7 / vt) - 1);
  expect(mosParams.Is === is, `body diode Is ${mosParams.Is} vs ${is}`);
  expect(mosParams.vth === -0.8, `vth ${mosParams.vth}`);
}

function stampOf(parts: AssignedPart[], node: string): BoardStamp {
  return {
    netlist: false,
    boardNode: node,
    vbusNode: null,
    resetNode: null,
    ledAlias: null,
    resetFraction: null,
    portNodes: {},
    parts,
    pins: [],
  };
}

/** 5 V bench supply, the catalog fuse, and a resistor sized for `amps` at rCold. */
function fuseCircuit(amps: number): { engine: Engine; fuse: PtcFuseElement } {
  const load = 5 / amps - fuseParams.rCold;
  const stamp = stampOf(
    [
      {
        path: "f1",
        form: "ptc-fuse@1",
        typeId: "ptc-fuse",
        params: { ...fuseParams },
        nodes: { A: "src", B: "mid" },
      },
      {
        path: "load",
        form: "resistor@1",
        typeId: "resistor",
        params: { R: load },
        nodes: { A: "mid", B: "0" },
      },
    ],
    "mid"
  );
  const realized = realize(stamp, "header", AVR_PIN, {
    pins: false,
    keep: ["src", "mid"],
  });
  const fuse = realized.elements.find(
    (el): el is PtcFuseElement => el instanceof PtcFuseElement
  );
  if (!fuse) throw new Error("fuse did not stamp");
  const engine = new Engine(
    [
      new VSource("v", "src", "0", { kind: "dc", value: 5 }),
      ...realized.elements,
    ],
    { method: "be", h: 0.001, atol: 1e-14, rtol: 1e-12 }
  );
  return { engine, fuse };
}

function closedTripS(amps: number): number {
  const power = amps * amps * fuseParams.rCold;
  return -fuseParams.tau * Math.log(1 - fuseParams.tripPower / power);
}

/** Pull, solve, then one thermal step. The same order as the rail. */
function master(engine: Engine, fuse: PtcFuseElement, first: boolean): number {
  if (fuse.pull()) engine.dropFactor();
  if (first) engine.operatingPoint();
  else engine.stepFast();
  const amps = fuse.current((node) => engine.voltage(node));
  fuse.advance(amps, 0.001);
  return amps;
}

function tripMs(target: number): { ms: number; amps: number } {
  const { engine, fuse } = fuseCircuit(target);
  let amps = 0;
  const limit = Math.ceil(closedTripS(target) * 1000) + 5;
  for (let step = 0; step < limit; step++) {
    amps = master(engine, fuse, step === 0);
    if (fuse.tripped) return { ms: step + 1, amps };
  }
  throw new Error(`${target} A did not trip in ${limit} ms`);
}

function withinStep(target: number): string {
  const run = tripMs(target);
  const predict = closedTripS(run.amps);
  const got = run.ms * 0.001;
  const delta = Math.abs(got - predict);
  expect(delta <= 0.001, `${target} A trip Δ ${delta} s`);
  expect(
    Math.abs(run.amps - target) < 1e-9,
    `${target} A solved as ${run.amps}`
  );
  return `${target} A in ${run.ms} ms (closed form ${(predict * 1000).toFixed(3)} ms, Δ ${(delta * 1000).toFixed(3)} ms)`;
}

console.log(`loose fuse: ${withinStep(8)}, ${withinStep(1.5)}`);

{
  const { engine, fuse } = fuseCircuit(fuseParams.iHold);
  const amps = master(engine, fuse, true);
  expect(Math.abs(amps - fuseParams.iHold) < 1e-9, `hold current ${amps}`);
  for (let step = 1; step < 10_000; step++) fuse.advance(amps, 0.001);
  expect(!fuse.tripped, `0.5 A tripped, u=${fuse.u}`);
  console.log(
    `loose fuse hold: ${fuseParams.iHold} A for 10 s, u=${fuse.u.toFixed(3)}, not tripped`
  );
}

/**
 * Two master steps. The channel starts on. The gate latched from the
 * first solve is what the second solve stamps.
 * Gate on GND holds the source at 5 V, so Vgs is about −5 V and the
 * channel stays on. Gate on S is the source node itself.
 */
function mosSecond(
  gateOnSource: boolean,
  amps: number
): {
  drop: number;
  on: boolean;
} {
  const nodes = gateOnSource
    ? { S: "0", D: "d", G: "0" }
    : { S: "s", D: "d", G: "0" };
  const stamp = stampOf(
    [
      {
        path: "t1",
        form: "pmos-switch@1",
        typeId: "pmos-switch",
        params: { ...mosParams },
        nodes,
      },
    ],
    "d"
  );
  const realized = realize(stamp, "header", AVR_PIN, {
    pins: false,
    keep: gateOnSource ? ["d"] : ["s", "d"],
  });
  const channel = realized.elements.find(
    (el): el is PmosChannel => el instanceof PmosChannel
  );
  if (!channel) throw new Error("pmos did not stamp");
  const engine = new Engine(
    [
      ...realized.elements,
      ...(gateOnSource
        ? [new ISource("i", "0", "d", { kind: "dc", value: amps })]
        : [
            new VSource("v", "s", "0", { kind: "dc", value: 5 }),
            new ISource("i", "d", "0", { kind: "dc", value: amps }),
          ]),
    ],
    { method: "be", h: 0.001, atol: 1e-14, rtol: 1e-12 }
  );
  const voltage = (node: string) => engine.voltage(node);
  engine.operatingPoint();
  channel.latch(voltage);
  if (channel.apply()) engine.dropFactor();
  engine.stepFast();
  const drop = gateOnSource
    ? engine.voltage("d")
    : engine.voltage("s") - engine.voltage("d");
  return { drop, on: channel.on };
}

{
  const amps = 0.2;
  const onGate = mosSecond(false, amps);
  const rds = amps * (mosParams.rds ?? 0);
  expect(onGate.on, "gate on GND turned the channel off");
  expect(
    Math.abs(onGate.drop - rds) < 1e-6,
    `rds drop ${onGate.drop} V vs ${rds} V`
  );
  const diodeAmps = 0.42;
  const onSource = mosSecond(true, diodeAmps);
  const vt = thermalVoltage(25);
  const law =
    (mosParams.N ?? 1) * vt * Math.log(diodeAmps / (mosParams.Is ?? 1) + 1) +
    diodeAmps * (mosParams.Rs ?? 0);
  expect(!onSource.on, "gate on S left the channel on");
  expect(
    Math.abs(onSource.drop - law) < 1e-6,
    `diode drop ${onSource.drop} V vs ${law} V`
  );
  console.log(
    `loose pmos: gate on GND, ${onGate.drop.toFixed(6)} V at ${amps} A (rds ${rds.toFixed(6)} V); gate on S, ${onSource.drop.toFixed(6)} V at ${diodeAmps} A (diode law ${law.toFixed(6)} V)`
  );
}

{
  const catalog = catalogRoot();
  const opts = { store: nodeStore, catalogDir: catalog, assetRoot: catalog };
  const loaded = loadPartById(catalog, opts, "sfab/mf-msmf050@1.0.0");
  const type = loadTypeById(catalog, opts, "ptc-fuse");
  if (!("part" in loaded) || !("type" in type)) {
    throw new Error("catalog fuse did not load");
  }
  const part: PartFile = structuredClone(loaded.part);
  const thermal = part.axes?.behaviour?.["1"]?.variants.thermal;
  if (!thermal || thermal.kind !== "form")
    throw new Error("no thermal variant");
  thermal.params.rHot = thermal.params.rCold;
  const lib: Library = {
    worldDir: catalog,
    worldName: "reject-fuse",
    assetRoot: catalog,
    parts: new Map([[part.id, { ...loaded, part }]]),
    types: new Map([[type.type.id, type]]),
    world: {
      version: 2,
      environment: { ground: { plane: true }, gravity: [0, 0, -9.81] },
      run: { seed: 1, levels: { default: 1 } },
      root: { id: "r", part: part.id },
    },
  };
  const hit = lintLibrary(lib).find((diag) =>
    diag.message.includes("rHot greater than rCold")
  );
  expect(hit, "rHot <= rCold was accepted");
  console.log(`reject rHot: ${hit?.message}`);
}

{
  const root = mkdtempSync(join(tmpdir(), "sfab-pmos-gate-"));
  try {
    const dir = join(root, "parts", "sfab");
    mkdirSync(dir, { recursive: true });
    const open: PartFile = {
      format: "sfab.part@1",
      id: "sfab/open-gate@1.0.0",
      type: "power-input",
      foreign: false,
      axes: {
        behaviour: {
          "2": {
            default: "netlist",
            variants: {
              netlist: {
                kind: "composite",
                omits: ["gate"],
                netlist: {
                  instances: { t1: { part: "sfab/fdn340p@1.0.0" } },
                  wires: [],
                  expose: { VBUS: "t1.S", "5V": "t1.D", GND: "t1.D" },
                },
              },
            },
          },
        },
        body: {
          "0": {
            default: "none",
            variants: { none: { kind: "none", omits: ["package body"] } },
          },
        },
        visual: {
          "0": {
            default: "none",
            variants: { none: { kind: "none", omits: ["package body"] } },
          },
        },
      },
    };
    writeFileSync(join(dir, "open-gate@1.0.0.json"), JSON.stringify(open));
    let message = "";
    try {
      const stamp = assemblyStampOf("sfab/open-gate@1.0.0", "netlist", {
        worldDir: root,
        boardId: "power",
        across: ["VBUS", "5V"],
      });
      realize(stamp, "header", AVR_PIN, { pins: false });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(
      message.includes("no gate net"),
      message || "open gate was accepted"
    );
    console.log(`reject no gate: ${message}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

type Stepped = {
  setFixed(amps: number): void;
  setMotor(
    index: number,
    fraction: number,
    omega: number,
    connected: boolean
  ): void;
  solve(): void;
  tripFuse(): void;
  boardVoltage: number;
  readonly tripped: boolean;
};

const armDir = fileURLToPath(
  new URL("../../../examples/arm/", import.meta.url)
);

function worldRails(world: string): {
  class2: Stepped;
  alias: Stepped;
  reference: Stepped;
  fixed: number;
} {
  const planned = planWorld(armDir, world);
  if (!planned.ok) {
    throw new Error(planned.errors.map((item) => item.message).join("; "));
  }
  const board = planned.plan.boards.find((item) => item.id === "uno");
  if (!board) throw new Error(`${world} has no uno`);
  const supplyId = powerFeedsOf(planned.plan).boards[board.id];
  const supply = planned.plan.supplies.find((item) => item.id === supplyId);
  if (!supply) throw new Error(`${world} uno has no supply`);
  const motor = planned.plan.parts.find((part) => part.motor)?.motor;
  if (!motor) throw new Error(`${world} has no motor`);
  const motors = [{ resistance: motor.resistance, k: motor.k }];
  const fixed = board.current + motor.quiescent;
  const make = (class2: boolean): RailCircuit => {
    const stamp = class2
      ? boardStampOf("sfab/uno-r3@1.0.0", "circuits", { boardId: board.id })
      : board.stamp;
    const attached = railAttachment({
      connector: supply.connector,
      boardCircuit: class2 ? null : board.boardCircuit,
      hasNetlist: class2 || board.hasNetlist,
      stamp,
    });
    return createRailCircuit({
      vNom: supply.voltage,
      rSeries: supply.rSeries,
      iLimit: supply.currentLimit,
      motors,
      ...(attached.boardPath ? { boardPath: attached.boardPath } : {}),
      ...(attached.stamp && attached.feed
        ? { stamp: attached.stamp, feed: attached.feed }
        : {}),
    });
  };
  return {
    class2: make(true),
    alias: make(false),
    reference: new UnoReferenceRail({
      vNom: supply.voltage,
      rSeries: supply.rSeries,
      iLimit: supply.currentLimit,
      motors,
      header: supply.connector !== "usb",
    }),
    fixed,
  };
}

function boardDelta(world: string): { class2: number; alias: number } {
  const rails = worldRails(world);
  let class2 = 0;
  let alias = 0;
  const step = (fraction: number) => {
    for (const rail of [rails.class2, rails.alias, rails.reference]) {
      rail.setFixed(rails.fixed);
      rail.setMotor(0, fraction, 0, fraction > 0);
      rail.solve();
    }
    class2 = Math.max(
      class2,
      Math.abs(rails.class2.boardVoltage - rails.reference.boardVoltage)
    );
    alias = Math.max(
      alias,
      Math.abs(rails.alias.boardVoltage - rails.reference.boardVoltage)
    );
  };
  for (let i = 0; i < 50; i++) step(0);
  for (let i = 0; i < 400; i++) step(1);
  return { class2, alias };
}

function sci(n: number): string {
  return n.toExponential(2);
}

for (const world of ["arm.world.json", "arm-stall.world.json"]) {
  const delta = boardDelta(world);
  expect(delta.class2 <= 1e-12, `${world} class 2 Δ ${delta.class2} V`);
  expect(delta.alias <= 1e-12, `${world} class 1 Δ ${delta.alias} V`);
  console.log(
    `uno netlist vs reference: ${world} class 2 ${sci(delta.class2)} V, class 1 ${sci(delta.alias)} V`
  );
}

function fuseTrace(startTripped: boolean): {
  trip: number[];
  reset: number[];
  delta: number;
} {
  const rails = worldRails("arm.world.json");
  const order = [rails.class2, rails.alias, rails.reference];
  const trip = [-1, -1, -1];
  const reset = [-1, -1, -1];
  let delta = 0;
  if (startTripped) for (const rail of order) rail.tripFuse();
  for (let ms = 1; ms <= 20_000; ms++) {
    for (let i = 0; i < order.length; i++) {
      const rail = order[i]!;
      const cooling = startTripped || (trip[i] ?? -1) > 0;
      rail.setFixed(cooling ? 0.03 : 2);
      rail.setMotor(0, 0, 0, false);
      rail.solve();
      if (rail.tripped && trip[i] === -1) trip[i] = startTripped ? 0 : ms;
      if ((trip[i] ?? -1) >= 0 && !rail.tripped && reset[i] === -1)
        reset[i] = ms;
    }
    delta = Math.max(
      delta,
      Math.abs(rails.class2.boardVoltage - rails.reference.boardVoltage),
      Math.abs(rails.alias.boardVoltage - rails.reference.boardVoltage)
    );
    if (reset.every((step) => step > 0) && ms > Math.max(...reset) + 2) break;
  }
  return { trip, reset, delta };
}

{
  const run = fuseTrace(true);
  expect(run.delta <= 1e-12, `fuseStart board Δ ${run.delta} V`);
  expect(
    run.trip[0] === run.trip[1] && run.trip[1] === run.trip[2],
    `trip ${run.trip}`
  );
  expect(
    run.reset[0] === run.reset[1] &&
      run.reset[1] === run.reset[2] &&
      (run.reset[0] ?? 0) > 0,
    `reset ${run.reset}`
  );
  console.log(
    `uno fuseStart tripped: board Δ ${sci(run.delta)} V, trip ${run.trip.join("/")}, reset ${run.reset.join("/")}`
  );
}

{
  const file = join(
    catalogRoot(),
    "snapshots",
    "sfab",
    "uno-power-input@1.0.0.json"
  );
  const snap = JSON.parse(readFileSync(file, "utf8")) as SnapshotFile;
  const table = tableLawOf(snap);
  expect(table, "uno power snapshot has no table");
  if (!table) throw new Error("uno power snapshot has no table");
  const hi = table.iAxis[table.iAxis.length - 1] ?? 0;
  expect(Math.abs(hi - fuseParams.iHold) < 1e-9, `envelope end ${hi} A`);
  const stamp = assemblyStampOf("sfab/uno-power-input@1.0.0", "netlist", {
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
  if (!Array.isArray(rows)) {
    throw new Error("uno power snapshot has no static error");
  }
  const interp = rows.find((row) => row.metric === "static-max-abs");
  expect(interp, "uno power snapshot has no static error");
  expect(knot <= 1e-6, `knot error ${knot} V`);
  expect((interp?.value ?? 1) <= 0.002, `interpolation ${interp?.value} V`);
  console.log(
    `uno power snapshot: knots ${table.iAxis.length}, knot error ${(knot * 1e6).toFixed(3)} µV, interpolation ${((interp?.value ?? 0) * 1000).toFixed(3)} mV, lint ${snap.quality}`
  );
}

type ArmRun = {
  voltages: number[];
  maxCurrent: number;
  warnings: string[];
};

function seriesDelta(a: number[], b: number[]): { max: number; rms: number } {
  const n = Math.min(a.length, b.length);
  expect(n > 0, "no samples");
  let max = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs((a[i] ?? 0) - (b[i] ?? 0));
    if (!Number.isFinite(d)) throw new Error("board voltage was not finite");
    if (d > max) max = d;
    sum += d * d;
  }
  return { max, rms: Math.sqrt(sum / n) };
}

function withUnoLevels(file: string, out: string, powerClass: 1 | 2): void {
  const world = JSON.parse(readFileSync(file, "utf8")) as {
    run: { levels: { paths?: Record<string, { behaviour: number }> } };
  };
  const paths: Record<string, { behaviour: number }> = {
    ...(world.run.levels.paths ?? {}),
    uno: { behaviour: 2 },
  };
  if (powerClass === 1) paths["uno.power"] = { behaviour: 1 };
  world.run.levels.paths = paths;
  writeFileSync(out, `${JSON.stringify(world, null, 2)}\n`);
}

async function runArm(dir: string, world: string, ms: number): Promise<ArmRun> {
  const seen: {
    report: RunReport | null;
    failed: string | null;
    sim: number;
  } = { report: null, failed: null, sim: -1 };
  const attached = await attachWorld(dir, world, {
    sender: { kind: "loopback", label: "Mac" },
    onEvent(event) {
      if (event.type === "error") {
        seen.failed =
          event.message ?? event.errors.map((item) => item.message).join("; ");
      }
      if (event.type === "state") {
        seen.sim = event.state.simTime;
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
      if (seen.sim >= ms / 1000 - 1e-3) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (seen.sim < ms / 1000 - 1e-3) throw new Error(`${world} timed out`);
    const read = await readRecording(dir, world, { from: 0, to: ms / 1000 });
    if ("error" in read) throw new Error(read.error);
    if (!seen.report) throw new Error(`${world} published no report`);
    return {
      voltages: boardVolts(read),
      maxCurrent: peakSupply(read),
      warnings: seen.report.warnings.map((item) => item.message),
    };
  } finally {
    attached.detach();
    await stopWorld(dir, world);
    closeRootWatches();
  }
}

function boardVolts(read: RecordingRead): number[] {
  return read.frames.map((frame) => frame.boards.uno?.voltage ?? Number.NaN);
}

function peakSupply(read: RecordingRead): number {
  let max = 0;
  for (const frame of read.frames) {
    for (const supply of Object.values(frame.supplies)) {
      max = Math.max(max, supply.current, supply.maxCurrent);
    }
  }
  return max;
}

{
  const dir = mkdtempSync(join(tmpdir(), "sfab-uno-mix-"));
  try {
    cpSync(armDir, dir, { recursive: true });
    withUnoLevels(
      join(dir, "arm.world.json"),
      join(dir, "arm-class2.world.json"),
      2
    );
    withUnoLevels(
      join(dir, "arm.world.json"),
      join(dir, "arm-mixed.world.json"),
      1
    );
    withUnoLevels(
      join(dir, "arm-stall.world.json"),
      join(dir, "arm-stall-mixed.world.json"),
      1
    );
    const full = await runArm(dir, "arm-class2.world.json", 3000);
    const mixed = await runArm(dir, "arm-mixed.world.json", 3000);
    const rail = seriesDelta(full.voltages, mixed.voltages);
    const envelope = mixed.warnings.filter((line) =>
      line.includes("envelope exceeded")
    );
    console.log(
      `uno power mixed arm.world.json: 5V max-abs ${(rail.max * 1000).toFixed(3)} mV, rms ${(rail.rms * 1000).toFixed(3)} mV, supply peak ${mixed.maxCurrent.toFixed(4)} A, ${envelope.length > 0 ? envelope.join("; ") : "no warning"}`
    );

    const stall = await runArm(dir, "arm-stall-mixed.world.json", 3000);
    const stallEnvelope = stall.warnings.filter((line) =>
      line.includes("envelope exceeded")
    );
    if (stall.maxCurrent > fuseParams.iHold + 1e-9) {
      expect(
        stallEnvelope.length > 0,
        `arm-stall ${stall.maxCurrent} A did not warn`
      );
      console.log(`uno power envelope: ${stallEnvelope.join("; ")}`);
    } else {
      console.log(
        `uno power snapshot arm-stall: supply ${stall.maxCurrent.toFixed(4)} A, under iHold ${fuseParams.iHold} A`
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

type ArmLines = {
  board: number[];
  servo: string;
  serial: string;
};

async function armLines(dir: string, world: string): Promise<ArmLines> {
  const seen: { failed: string | null; sim: number } = {
    failed: null,
    sim: -1,
  };
  const attached = await attachWorld(dir, world, {
    sender: { kind: "loopback", label: "Mac" },
    onEvent(event) {
      if (event.type === "error") {
        seen.failed =
          event.message ?? event.errors.map((item) => item.message).join("; ");
      }
      if (event.type === "state") seen.sim = event.state.simTime;
    },
  });
  if ("error" in attached) throw new Error(attached.error);
  try {
    attached.step(3000);
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (seen.failed) throw new Error(seen.failed);
      if (seen.sim >= 3 - 1e-3) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (seen.sim < 3 - 1e-3) throw new Error(`${world} timed out`);
    const read = await readRecording(dir, world, { from: 0, to: 3 });
    if ("error" in read) throw new Error(read.error);
    const boardId = Object.keys(read.frames[0]?.boards ?? {})[0];
    if (!boardId) throw new Error(`${world} has no board`);
    const servo = read.frames.map((frame) => {
      const part = frame.parts.servo;
      return `${part?.pulseUs ?? "none"} ${part?.current ?? "none"}`;
    });
    const serial = read.events.flatMap((event) =>
      event.kind === "serial" ? [event.text] : []
    );
    return {
      board: read.frames.map(
        (frame) => frame.boards[boardId]?.voltage ?? Number.NaN
      ),
      servo: servo.join("\n"),
      serial: serial.join("\n"),
    };
  } finally {
    attached.detach();
    await stopWorld(dir, world);
    closeRootWatches();
  }
}

{
  const dir = mkdtempSync(join(tmpdir(), "sfab-uno-mcu-"));
  try {
    cpSync(armDir, dir, { recursive: true });
    rmSync(join(dir, "arm.world.lock.json"), { force: true });
    const scene = join(dir, "parts", "sfab", "arm-scene@1.0.0.json");
    const text = readFileSync(scene, "utf8")
      .replaceAll('"uno"', '"mcu"')
      .replaceAll("uno.", "mcu.");
    writeFileSync(scene, text);
    const original = await armLines(armDir, "arm.world.json");
    const renamed = await armLines(dir, "arm.world.json");
    let delta = 0;
    const n = Math.min(original.board.length, renamed.board.length);
    expect(n > 0 && n === original.board.length, "mcu frames");
    for (let i = 0; i < n; i++) {
      delta = Math.max(
        delta,
        Math.abs((original.board[i] ?? 0) - (renamed.board[i] ?? 0))
      );
    }
    expect(delta === 0, `mcu board node Δ ${delta} V`);
    expect(renamed.serial === original.serial, "mcu serial differs");
    expect(renamed.servo === original.servo, "mcu servo differs");
    console.log(
      `mcu rename: board node Δ ${delta} V, serial identical, servo identical`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = mkdtempSync(join(tmpdir(), "sfab-two-uno-"));
  try {
    cpSync(armDir, dir, { recursive: true });
    rmSync(join(dir, "arm.world.lock.json"), { force: true });
    const scene = join(dir, "parts", "sfab", "arm-scene@1.0.0.json");
    const part = JSON.parse(readFileSync(scene, "utf8")) as PartFile;
    const slot = part.axes?.behaviour?.["2"];
    const variant = slot?.variants.netlist;
    if (variant?.kind !== "composite") throw new Error("arm scene netlist");
    const sceneUno = variant.netlist.instances.uno;
    if (!sceneUno) throw new Error("arm scene has no uno");
    variant.netlist.instances.other = {
      part: sceneUno.part,
      pose: { position: [0.2, 0, 0.006], rotation: [1, 0, 0, 0] },
      params: sceneUno.params,
    };
    variant.netlist.wires.push(
      ["usb.5V", "other.5V"],
      ["usb.GND", "other.GND"]
    );
    writeFileSync(scene, `${JSON.stringify(part, null, 2)}\n`);
    const planned = planWorld(dir, "arm.world.json");
    if (!planned.ok) {
      throw new Error(
        `two class-1 Unos planned: ${planned.errors.map((item) => item.message).join("; ")}`
      );
    }
    const uno = planned.plan.boards.find((board) => board.id === "uno");
    const other = planned.plan.boards.find((board) => board.id === "other");
    const usb = planned.plan.supplies.find((item) => item.id === "usb");
    expect(uno?.stamp && other?.stamp && usb, "both Unos stamped on usb");
    if (!uno?.stamp || !other?.stamp || !usb) throw new Error("unreachable");
    const tie = (stamp: BoardStamp): BoardStamp => {
      const vbus = stamp.vbusNode;
      const node = (name: string) => (vbus && name === vbus ? "term" : name);
      return {
        ...stamp,
        boardNode: node(stamp.boardNode),
        vbusNode: stamp.vbusNode ? node(stamp.vbusNode) : null,
        resetNode: stamp.resetNode ? node(stamp.resetNode) : null,
        portNodes: Object.fromEntries(
          Object.entries(stamp.portNodes).map(([key, value]) => [
            key,
            node(value),
          ])
        ),
        parts: stamp.parts.map((row) => ({
          ...row,
          nodes: Object.fromEntries(
            Object.entries(row.nodes).map(([key, value]) => [key, node(value)])
          ),
        })),
        pins: stamp.pins.map((row) => ({ ...row, node: node(row.node) })),
      };
    };
    const left = realize(tie(other.stamp), "usb", other.pin, {
      pinId: (port) => `pin.other.${port}`,
    });
    const right = realize(tie(uno.stamp), "usb", uno.pin, {
      pinId: (port) => `pin.uno.${port}`,
    });
    const loadOther = new CurrentLoad(
      "load.other",
      left.boardNode,
      "0",
      BOARD_LOAD_KNEE_V
    );
    const loadUno = new CurrentLoad(
      "load.uno",
      right.boardNode,
      "0",
      BOARD_LOAD_KNEE_V
    );
    loadOther.amps = other.current;
    loadUno.amps = uno.current;
    const stamped = [...left.elements, ...right.elements].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    );
    const reference = new Engine(
      [
        new TheveninLimit(
          "src",
          "term",
          "0",
          usb.voltage,
          usb.rSeries,
          usb.currentLimit
        ),
        loadOther,
        loadUno,
        ...stamped,
      ],
      { method: "be", h: 0.0001, atol: 1e-14, rtol: 1e-12 }
    );
    const rail = createRailCircuit({
      vNom: usb.voltage,
      rSeries: usb.rSeries,
      iLimit: usb.currentLimit,
      motors: [],
      boards: [
        { id: "other", stamp: other.stamp, feed: "usb", pin: other.pin },
        { id: "uno", stamp: uno.stamp, feed: "usb", pin: uno.pin },
      ],
    });
    rail.setBoardLoad("other", other.current);
    rail.setBoardLoad("uno", uno.current);
    reference.operatingPoint();
    rail.solve();
    const unoV = rail.boardReading("uno").voltage;
    const otherV = rail.boardReading("other").voltage;
    const delta = Math.max(
      Math.abs(unoV - reference.voltage(right.boardNode)),
      Math.abs(otherV - reference.voltage(left.boardNode)),
      Math.abs(rail.current - -reference.branchCurrent("src"))
    );
    expect(delta <= 1e-12, `two Unos Δ ${delta}`);
    console.log(
      `two class-1 Unos: uno ${unoV.toFixed(6)} V, other ${otherV.toFixed(6)} V, supply ${rail.current.toFixed(6)} A, Δ ${delta.toExponential(2)} V`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = mkdtempSync(join(tmpdir(), "sfab-uno-no-net-"));
  try {
    cpSync(armDir, dir, { recursive: true });
    rmSync(join(dir, "arm.world.lock.json"), { force: true });
    const part = readPart("uno-r3@1.0.0");
    const behaviour = part.axes?.behaviour;
    if (behaviour) delete behaviour["2"];
    const folder = join(dir, "parts", "sfab");
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "uno-r3@1.0.0.json"),
      `${JSON.stringify(part, null, 2)}\n`
    );
    const planned = planWorld(dir, "arm.world.json");
    expect(planned.ok, "a Uno with no netlist did not run");
    if (!planned.ok) throw new Error("unreachable");
    const hit = (planned.plan.degraded ?? []).find((item) =>
      item.message.includes(
        "sfab/uno-r3@1.0.0 has no board netlist for path:uno-usb"
      )
    );
    expect(hit, "no netlist diagnostic");
    console.log(
      `degraded ${hit.path}: sfab/uno-r3@1.0.0 has no board netlist for path:uno-usb`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
