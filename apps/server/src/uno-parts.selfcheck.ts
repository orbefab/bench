/**
 * ptc-fuse@1 and pmos-switch@1 outside the Uno cable. The fuse's thermal
 * step and the MOSFET's gate are per instance, in any stamped circuit.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PartFile } from "@sfab-bench/contract";
import { ISource, thermalVoltage, VSource } from "./world/circuit/elements";
import { Engine } from "./world/circuit/engine";
import { AVR_PIN } from "./world/circuit/pin";
import { PmosChannel } from "./world/circuit/pmos-switch";
import {
  MF_MSMF050,
  PtcFuseElement,
  type PtcFuseParams,
} from "./world/circuit/ptc-fuse";
import {
  type AssignedPart,
  assemblyStampOf,
  type BoardStamp,
  realize,
} from "./world/circuit-stamp";
import {
  type Library,
  lintLibrary,
  loadPartById,
  loadTypeById,
} from "./world/parts/library";
import { catalogRoot } from "./world/plan";

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
  const opts = { catalogDir: catalog, assetRoot: catalog };
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
