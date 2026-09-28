/**
 * Supply presets and `battery@1`. Printed lines are the proof.
 * The 1 ms step is the rail's master step.
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

import type { FormParam } from "@sfab-bench/contract";

import { type BatteryParams, batteryFrom, ocvAt } from "./world/battery";
import { CurrentLoad, Engine, Resistor, TheveninLimit } from "./world/circuit";
import { boardStampOf } from "./world/circuit-stamp";
import { catalogRoot, planWorld } from "./world/plan";
import { NANO_BOARD_A } from "./world/power-path";
import { createRailCircuit } from "./world/rail-circuit";

const MASTER_S = 0.001;
const LOAD_A = 0.2;

function expect(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(label);
}

function num(n: number): string {
  return n.toExponential(16);
}

type PartJson = {
  axes: {
    behaviour: {
      "1": {
        variants: Record<string, { params: Record<string, FormParam> }>;
      };
    };
  };
};

function variantParams(id: string, variant: string): Record<string, FormParam> {
  const part = JSON.parse(
    readFileSync(join(catalogRoot(), "parts", "sfab", `${id}.json`), "utf8")
  ) as PartJson;
  const found = part.axes.behaviour["1"].variants[variant];
  if (!found) throw new Error(`${id} has no ${variant}`);
  return found.params;
}

function point(
  V: number,
  Rs: number,
  Ilim: number,
  load: CurrentLoad | Resistor
): { v: number; i: number } {
  const eng = new Engine(
    [new TheveninLimit("src", "p", "0", V, Rs, Ilim), load],
    { method: "be", h: MASTER_S, atol: 1e-14, rtol: 1e-12 }
  );
  eng.operatingPoint();
  return { v: eng.voltage("p"), i: -eng.branchCurrent("src") };
}

function presetLine(id: string): string {
  const params = variantParams(id, "thevenin");
  const V = params.V;
  const Rs = params.Rs;
  const Ilim = params.Ilimit;
  if (
    typeof V !== "number" ||
    typeof Rs !== "number" ||
    typeof Ilim !== "number"
  ) {
    throw new Error(`${id} params`);
  }
  const openLoad = new CurrentLoad("load", "p", "0", 0);
  const halfLoad = new CurrentLoad("load", "p", "0", 0);
  halfLoad.amps = Ilim / 2;
  const open = point(V, Rs, Ilim, openLoad);
  const half = point(V, Rs, Ilim, halfLoad);
  const held = point(V, Rs, Ilim, new Resistor("r", "p", "0", 0.1));
  const d0 = Math.abs(open.v - V);
  const dHalf = Math.abs(half.v - (V - Rs * (Ilim / 2)));
  const dI = Math.abs(held.i - Ilim);
  expect(d0 <= 1e-12, `${id} 0 A Δ ${d0}`);
  expect(dHalf <= 1e-12, `${id} Ilimit/2 Δ ${dHalf}`);
  expect(held.i <= Ilim + 1e-12 && dI <= 1e-9, `${id} limit ${held.i}`);
  return `${id} 0 A Δ ${num(d0)} V; Ilimit/2 Δ ${num(dHalf)} V; above Ilimit ${num(held.i)} A`;
}

function batteryRail(cell: BatteryParams, amps: number) {
  const voc = ocvAt(cell.ocv, cell.soc0);
  const rail = createRailCircuit({
    vNom: voc,
    rSeries: cell.rInternal,
    iLimit: cell.rInternal > 0 ? voc / cell.rInternal : 1,
    motors: [],
    battery: cell,
  });
  rail.setFixed(amps);
  return rail;
}

const LINEAR: BatteryParams = {
  ocv: [
    [0, 3],
    [1, 5],
  ],
  rInternal: 1,
  capacity: 1000,
  soc0: 1,
};

function sixtyLine(): string {
  const steps = 60 / MASTER_S;
  const rail = batteryRail(LINEAR, LOAD_A);
  for (let k = 0; k < steps; k++) rail.solve();
  const soc = rail.soc;
  const stamped = rail.stampedSoc;
  expect(soc !== undefined && stamped !== undefined, "battery soc");
  const socExpected = LINEAR.soc0 - (LOAD_A * 60) / LINEAR.capacity;
  const vExpected = ocvAt(LINEAR.ocv, stamped) - LOAD_A * LINEAR.rInternal;
  const dSoc = Math.abs(soc - socExpected);
  const dV = Math.abs(rail.voltage - vExpected);
  const dI = Math.abs(rail.current - LOAD_A);
  expect(dSoc <= 1e-12, `soc Δ ${dSoc}`);
  expect(dV <= 1e-12, `terminal Δ ${dV}`);
  expect(dI <= 1e-12, `current Δ ${dI}`);
  return `battery@1 60 s soc Δ ${num(dSoc)}; terminal Δ ${num(dV)} V`;
}

function closedCutoffSteps(cell: BatteryParams): number {
  const cutoff = cell.vCutoff;
  if (cutoff === undefined) throw new Error("cutoff");
  let soc = cell.soc0;
  let k = 0;
  for (;;) {
    const terminal = ocvAt(cell.ocv, soc) - LOAD_A * cell.rInternal;
    if (terminal <= cutoff || soc <= 0) return k;
    soc -= (LOAD_A * MASTER_S) / cell.capacity;
    k += 1;
    if (k > 100000) throw new Error("closed cutoff did not arrive");
  }
}

function cutoffLine(): string {
  const cell: BatteryParams = {
    ocv: LINEAR.ocv,
    rInternal: LINEAR.rInternal,
    capacity: 10,
    soc0: 1,
    vCutoff: 4.5,
  };
  const rail = batteryRail(cell, LOAD_A);
  let steps = 0;
  while (rail.batteryWarnings() === 0) {
    rail.solve();
    steps += 1;
    if (steps > 20000) throw new Error("sim cutoff did not arrive");
  }
  const k = steps - 1;
  const closed = closedCutoffSteps(cell);
  expect(k === closed, `cutoff step ${k} closed ${closed}`);
  expect(rail.batteryWarnings() === 1, "one warning at cutoff");
  rail.solve();
  const empty = ocvAt(cell.ocv, 0);
  const dV = Math.abs(rail.voltage - empty);
  expect(dV <= 1e-12, `empty terminal Δ ${dV}`);
  expect(rail.batteryWarnings() === 1, "warning stays one");
  const t = k * MASTER_S;
  return `battery@1 cutoff t ${num(t)} s closed ${num(closed * MASTER_S)} s; warnings ${rail.batteryWarnings()}`;
}

function nanoLine(): string {
  const built = batteryFrom(
    variantParams("battery-3xaa-alkaline@1.0.0", "pack"),
    {}
  );
  if (!built.ok) throw new Error(built.error);
  const cell = built.params;
  const voc = ocvAt(cell.ocv, cell.soc0);
  const rail = createRailCircuit({
    vNom: voc,
    rSeries: cell.rInternal,
    iLimit: voc / cell.rInternal,
    motors: [],
    battery: cell,
    stamp: boardStampOf("sfab/nano-ch340@1.0.0", "circuits", {
      boardId: "nano",
    }),
    feed: "header",
  });
  rail.setFixed(NANO_BOARD_A);
  rail.setD13("high");
  for (let k = 0; k < 1000; k++) rail.solve();
  const v1 = rail.boardVoltage;
  const i1 = rail.ledCurrent;
  for (let k = 0; k < 59000; k++) rail.solve();
  const v60 = rail.boardVoltage;
  const i60 = rail.ledCurrent;
  expect(v60 < v1, `board sag ${v1} -> ${v60}`);
  expect(i1 > 0 && i60 < i1, `D13 ${i1} -> ${i60}`);
  return `battery-3xaa-alkaline nano 5V t=1 s board ${num(v1)} V D13 ${num(i1)} A; t=60 s board ${num(v60)} V D13 ${num(i60)} A`;
}

function planLine(): string {
  const dir = mkdtempSync(join(tmpdir(), "sfab-supply-"));
  try {
    mkdirSync(join(dir, "parts", "sfab"), { recursive: true });
    mkdirSync(join(dir, "firmware", "hold"), { recursive: true });
    cpSync(
      fileURLToPath(
        new URL(
          "../../../examples/nano/firmware/hold/hold.hex",
          import.meta.url
        )
      ),
      join(dir, "firmware", "hold", "hold.hex")
    );
    writeFileSync(
      join(dir, "parts", "sfab", "aa-nano-scene@1.0.0.json"),
      JSON.stringify({
        format: "sfab.part@1",
        id: "sfab/aa-nano-scene@1.0.0",
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
                      nano: {
                        part: "sfab/nano-ch340@1.0.0",
                        params: {
                          firmware: "firmware/hold/hold.hex",
                          source: "firmware/hold/hold.ino",
                        },
                      },
                      pack: { part: "sfab/battery-3xaa-alkaline@1.0.0" },
                    },
                    wires: [
                      ["pack.+", "nano.5V"],
                      ["pack.-", "nano.GND"],
                    ],
                    expose: {},
                  },
                },
              },
            },
          },
          body: {
            "0": {
              default: "none",
              variants: {
                none: { kind: "none", omits: ["assembly adds no body"] },
              },
            },
          },
          visual: {
            "0": {
              default: "none",
              variants: {
                none: { kind: "none", omits: ["assembly adds no visual"] },
              },
            },
          },
        },
      })
    );
    writeFileSync(
      join(dir, "pack.world.json"),
      JSON.stringify({
        version: 2,
        environment: { ground: { plane: true }, gravity: [0, 0, -9.81] },
        run: {
          seed: 1,
          levels: { default: 1, types: { "arduino-nano": { behaviour: 2 } } },
        },
        root: { id: "scene", part: "sfab/aa-nano-scene@1.0.0" },
      })
    );
    const planned = planWorld(dir, "pack.world.json");
    if (!planned.ok) {
      throw new Error(planned.errors.map((error) => error.message).join("; "));
    }
    const supply = planned.plan.supplies.find((item) => item.battery);
    expect(supply?.battery, "plan battery");
    expect(planned.plan.boards.length === 1, "plan board");
    const voc = supply?.voltage ?? Number.NaN;
    expect(Math.abs(voc - 4.8) <= 1e-12, `plan voc ${voc}`);
    return `battery-3xaa-alkaline plan voc ${num(voc)} V on nano 5V`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function batteryReport(): string {
  return [sixtyLine(), cutoffLine(), nanoLine(), planLine()].join("\n");
}

const presets = [
  "usb2-host-port@1.0.0",
  "usb3-host-port@1.0.0",
  "usb-charger-1a@1.0.0",
  "bench-supply-2a@1.0.0",
];
for (const id of presets) console.log(presetLine(id));

const first = batteryReport();
const second = batteryReport();
expect(first === second, "battery check repeated");
console.log(first);
console.log("battery check repeated: byte-identical");
