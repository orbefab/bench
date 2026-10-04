/**
 * A rail answers for an instance from what it registered as that
 * instance's own: stamped parts by path, a board's pins and its own draw
 * on the board load. Two boards on one island, each from its own supply,
 * grounds tied: every snapshot the circuit holds (both boards' parts and
 * a span between them) is checked once per solve, whichever supply comes
 * first; a pin sourcing current reads negative at the board and positive
 * at its load; the board's supply port carries its own draw and no other
 * board's.
 */
import { ok as expect } from "node:assert/strict";
import type { RunReport } from "@sfab-bench/contract";
import { AvrBoard, requireChipSpec } from "@sfab-bench/engine-mcu";
import { assemble } from "avr8js/dist/esm/utils/assembler.js";
import type { AssignedPart, BoardStamp } from "../src/circuit-stamp";
import type { RunPlan } from "../src/plan";
import { createRailCircuit } from "../src/rail-circuit";
import { snapshotDriveModes } from "../src/session/boards";
import { portReading } from "../src/session/ports";
import { solveSupplies } from "../src/session/solve";
import { type BoardPower, createState } from "../src/session/state";
import type { SimHost } from "../src/sim";

const chip = requireChipSpec("atmega328p");
const R = 1000;
const DRAW = { a: 0.02, b: 0.03 } as const;

/** A resistor whose watch holds its current under `max` amperes. */
function watched(path: string, a: string, b: string, max: number) {
  return {
    path,
    form: "resistor@1",
    typeId: "resistor",
    params: { R },
    nodes: { A: a, B: b },
    watch: {
      ref: `test/${path}@1.0.0`,
      bounds: { "1.current": [0, max] },
      ports: { A: "1" },
    },
  } as AssignedPart;
}

/**
 * Board `id`: its 5 V node, a watched 1 kΩ of its own on 5 V, and a pin
 * into a scene part's 1 kΩ (`id-load`, not under the board).
 */
function stampOf(id: string, max: number): BoardStamp {
  return {
    netlist: true,
    boardNode: `${id}.vcc`,
    vbusNode: null,
    regulatorNode: null,
    resetNode: null,
    ledAlias: null,
    ledPin: null,
    resetFraction: 0.9,
    portNodes: { P: `${id}.p`, "5V": `${id}.vcc` },
    parts: [
      {
        path: `${id}-load`,
        form: "resistor@1",
        typeId: "resistor",
        params: { R },
        nodes: { A: `${id}.p`, B: "0" },
      } as AssignedPart,
      watched(`${id}.bleed`, `${id}.vcc`, "0", max),
    ],
    pins: [{ port: "P", bit: 0, node: `${id}.p` }],
  } as BoardStamp;
}

// a's bleed (5 mA) is inside its watch, b's is not; the span from a's 5 V
// to b's pin is outside its own. Both warnings must come once per run.
const stamps = { a: stampOf("a", 0.01), b: stampOf("b", 0.001) };
const span = watched("wire", "a.vcc", "b.p", 1e-4);

// Drive PB0 high and hold it.
const assembled = assemble("sbi 0x04, 0\nsbi 0x05, 0\ndone: rjmp done\n");
expect(assembled.errors.length === 0, assembled.errors.join("; "));
const program = new Uint8Array(chip.flashBytes).fill(0xff);
program.set(assembled.bytes);

type Run = {
  warnings: string[];
  pin: number;
  load: number;
  supplyA: number;
  supplyB: number;
  bleedB: number;
};

function run(order: readonly ("s1" | "s2")[]): Run {
  const circuit = createRailCircuit({
    vNom: 5,
    rSeries: 0.05,
    iLimit: 10,
    motors: [],
    boards: [
      { id: "a", stamp: stamps.a, feed: "header" },
      { id: "b", stamp: stamps.b, feed: "header" },
    ],
    primaryId: "s1",
    primaryNode: "a.vcc",
    also: [{ id: "s2", vNom: 5, rSeries: 0.05, iLimit: 10, node: "b.vcc" }],
    spans: [span],
  });
  const s = createState({ post() {} } as unknown as SimHost);
  const avr = new AvrBoard("a", chip, ["PB0"]);
  avr.load(program);
  s.boards = [avr];
  s.runPlan = {
    boards: [
      { id: "a", stamp: stamps.a },
      { id: "b", stamp: stamps.b },
    ],
    supplies: [{ id: "s1" }, { id: "s2" }],
    spans: [{ part: span, boards: ["a", "b"] }],
    parts: [],
    // A board port reads through the stamped part ports on its net.
    wires: [
      ["a.P", "a-load.A"],
      ["a.5V", "a.bleed.A"],
      ["b.5V", "b.bleed.A"],
    ],
  } as unknown as RunPlan;
  s.runReport = {
    warnings: [],
    snapshots: [],
    nets: [],
  } as unknown as RunReport;
  s.boardPower.set("a", {
    supplyId: "s1",
    draw: DRAW.a,
    reset: { phase: "run" },
  } as unknown as BoardPower);
  s.boardPower.set("b", {
    supplyId: "s2",
    draw: DRAW.b,
    reset: { phase: "run" },
  } as unknown as BoardPower);
  s.supplySpecs = order.map((id) => ({
    id,
    voltage: 5,
    rSeries: 0.05,
    currentLimit: 10,
  }));
  const group = { circuit, loads: [], boardMin: 0 };
  s.rails.set("s1", group);
  s.rails.set("s2", group);
  for (let i = 0; i < 3; i++) {
    snapshotDriveModes(s);
    avr.stepMillis();
    solveSupplies(s);
  }
  expect(avr.driveMode(0) === "high", "a's pin drives high");
  const read = (path: string, port: string) =>
    portReading(s, path, port)?.current ?? Number.NaN;
  return {
    warnings: (s.runReport?.warnings ?? []).map((w) => w.path ?? "").sort(),
    pin: read("a", "P"),
    load: read("a-load", "A"),
    supplyA: read("a", "5V"),
    supplyB: read("b", "5V"),
    bleedB: read("b.bleed", "A"),
  };
}

const first = run(["s1", "s2"]);
const second = run(["s2", "s1"]);
console.log(`circuit-owners: ${JSON.stringify(first)}`);

// Every snapshot on the island, once, in both orders.
const want = ["b.bleed", "wire"];
for (const got of [first, second]) {
  expect(
    JSON.stringify(got.warnings) === JSON.stringify(want),
    `warnings ${JSON.stringify(got.warnings)}, want ${JSON.stringify(want)}`
  );
}
for (const key of ["pin", "load", "supplyA", "supplyB", "bleedB"] as const) {
  expect(
    Math.abs(first[key] - second[key]) < 1e-12,
    `${key} depends on supply order: ${first[key]} vs ${second[key]}`
  );
}

// The pin sources its load's current: negative at the board, the same
// amperes into the load.
expect(first.load > 4e-3, `a-load draws ${first.load} A`);
expect(
  Math.abs(first.pin + first.load) < 1e-9,
  `a.P ${first.pin} A is not minus a-load ${first.load} A`
);

// a's 5 V carries its own draw, its bleed, and its pin's current; the span
// to b's pin adds a little. Not b's 30 mA.
const bleedA = 5 / R;
const wantA = DRAW.a + bleedA + first.load;
expect(
  first.supplyA > wantA - 1e-4 && first.supplyA < wantA + 1e-3,
  `a.5V ${first.supplyA} A, want about ${wantA} A`
);
const wantB = DRAW.b + first.bleedB;
expect(
  Math.abs(first.supplyB - wantB) < 5e-4,
  `b.5V ${first.supplyB} A, want about ${wantB} A`
);
console.log(
  `circuit-owners: warnings ${want.join(", ")} once in both supply orders; a.P ${(first.pin * 1e3).toFixed(4)} mA, a.5V ${(first.supplyA * 1e3).toFixed(3)} mA, b.5V ${(first.supplyB * 1e3).toFixed(3)} mA`
);
console.log("circuit-owners.selfcheck ok");
