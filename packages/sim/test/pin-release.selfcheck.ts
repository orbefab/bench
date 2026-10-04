/**
 * The session's rail solve charges each stamped pin in its drive mode for
 * the part of the step it held it, from the board's mode-change events. A
 * pin driven from input to low to high, then released to its pull-up
 * halfway through the step, drives a 1 kΩ load for that half only: the
 * frame mean sits between the driven and pull-up nodes, and the next step
 * is the pull-up alone. Before the mode events, an input → driven change
 * was dropped and the release was not an edge at all.
 */
import { ok as expect } from "node:assert/strict";
import { AvrBoard, requireChipSpec } from "@sfab-bench/engine-mcu";
import { assemble } from "avr8js/dist/esm/utils/assembler.js";
import type { BoardStamp } from "../src/circuit-stamp";
import type { RunPlan } from "../src/plan";
import { createRailCircuit } from "../src/rail-circuit";
import { snapshotDriveModes } from "../src/session/boards";
import { solveSupplies } from "../src/session/solve";
import { type BoardPower, createState } from "../src/session/state";
import type { SimHost } from "../src/sim";

const chip = requireChipSpec("atmega328p");

// 2 + 2 cycles to drive PB0 high, about 8000 cycles of loop (half of a
// 1 ms step at 16 MHz), then release to the pull-up.
const source = `
  sbi 0x04, 0
  sbi 0x05, 0
  ldi r24, 0xd0
  ldi r25, 0x07
wait:
  sbiw r24, 1
  brne wait
  cbi 0x04, 0
done:
  rjmp done
`;
const assembled = assemble(source);
expect(
  assembled.errors.length === 0,
  `assembler: ${assembled.errors.join("; ")}`
);
const program = new Uint8Array(chip.flashBytes).fill(0xff);
program.set(assembled.bytes);

const stamp: BoardStamp = {
  netlist: true,
  boardNode: "vcc",
  vbusNode: null,
  regulatorNode: null,
  resetNode: null,
  ledAlias: null,
  ledPin: null,
  resetFraction: 0.9,
  portNodes: { P: "p", VCC: "vcc" },
  parts: [
    {
      path: "load",
      form: "resistor@1",
      typeId: "resistor",
      params: { R: 1000 },
      nodes: { A: "p", B: "0" },
    },
  ],
  pins: [{ port: "P", bit: 0, node: "p" }],
} as unknown as BoardStamp;

const circuit = createRailCircuit({
  vNom: 5,
  rSeries: 0.05,
  iLimit: 10,
  motors: [],
  stamp,
  feed: "header",
});
const avr = new AvrBoard("b", chip, ["PB0"]);
avr.load(program);

const host = { post() {} } as unknown as SimHost;
const s = createState(host);
s.boards = [avr];
s.boardPower.set("b", {
  supplyId: "supply",
  draw: 0,
  reset: { phase: "run" },
} as unknown as BoardPower);
s.runPlan = {
  boards: [{ id: "b", stamp }],
  supplies: [{ id: "supply" }],
  parts: [],
  wires: [],
} as unknown as RunPlan;
s.supplySpecs = [{ id: "supply", voltage: 5, rSeries: 0.05, currentLimit: 10 }];
s.rails.set("supply", { circuit, loads: [], boardMin: 0 });

/** One master step as the session runs it: start modes, CPU, solve. */
function step(): { mean: number; lo: number; hi: number; end: number } {
  snapshotDriveModes(s);
  avr.stepMillis();
  solveSupplies(s);
  const frame = circuit.takePinFrame().get("p");
  const end = circuit.pinVolts("b")[0]?.volts ?? Number.NaN;
  return {
    mean: frame?.v ?? Number.NaN,
    lo: frame?.lo ?? Number.NaN,
    hi: frame?.hi ?? Number.NaN,
    end,
  };
}

solveSupplies(s);
circuit.takePinFrame();
const first = step();
const modes = avr.modeChanges.map((change) => change.mode).join(" → ");
expect(modes === "low → high → pullup", `mode changes ${modes}`);
expect(avr.driveMode(0) === "pullup", "the step ends released");
const held = step();
expect(avr.modeChanges.length === 0, "the second step changes nothing");

// The driven node is the supply over roh + 1 kΩ; the pull-up node is the
// supply over rpu + 1 kΩ. Halfway between, give or take the loop's cycles.
const driven = first.hi;
const pulled = held.mean;
expect(driven > 4.5, `driven node ${driven} V`);
expect(pulled > 0.05 && pulled < 0.3, `pull-up node ${pulled} V`);
expect(
  Math.abs(first.end - pulled) < 1e-9,
  `the step ends at the pull-up node: ${first.end} vs ${pulled}`
);
expect(
  Math.abs(held.lo - held.hi) < 1e-9,
  "the held step has one mode: no band"
);
const share = (first.mean - pulled) / (driven - pulled);
expect(
  share > 0.45 && share < 0.55,
  `driven for ${share.toFixed(4)} of the step, want about half`
);
console.log(
  `pin-release: driven ${driven.toFixed(4)} V for ${share.toFixed(4)} of the step, then pull-up ${pulled.toFixed(4)} V`
);
console.log("pin-release.selfcheck ok");
