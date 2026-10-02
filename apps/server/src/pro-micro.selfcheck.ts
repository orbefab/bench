/**
 * SparkFun Pro Micro, ATmega32U4 at 5 V / 16 MHz.
 *
 * The example boots past the PLL wait (Serial1 ticks only happen from
 * loop), the RX LED current toggles, the pin list is the header, and
 * timer 4 and USB CDC are each named once. A weak RAW rail uses this
 * chip's brownout, not the ATmega328P's.
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

import { adcCount, type WorldViewNode } from "@sfab-bench/contract";
import {
  AvrBoard,
  INTERNAL_2V56_V,
  requireChipSpec,
} from "@sfab-bench/engine-mcu";

import { closeRootWatches } from "./projects";
import { headlessSim } from "./run";
import { planWorld } from "./world/plan";
import { viewOf } from "./world/view";

const project = fileURLToPath(
  new URL("../../../examples/pro-micro/", import.meta.url)
);
const world = "parts/sfab/pro-micro-blink@1.0.0.json";

/** Header names, Nano style: Arduino pin numbers, not the silkscreen. */
const HEADER = [
  "D0",
  "D1",
  "D2",
  "D3",
  "D4",
  "D5",
  "D6",
  "D7",
  "D8",
  "D9",
  "D10",
  "D14",
  "D15",
  "D16",
  "A0",
  "A1",
  "A2",
  "A3",
];

/**
 * ATmega328P brownout assert. The mid rail sits under this and over the
 * 32U4 assert, so a pass is this chip's threshold.
 */
const ATMEGA328P_ASSERT_V = 2.675;

const chip = requireChipSpec("atmega32u4");

function flat(nodes: readonly WorldViewNode[]): WorldViewNode[] {
  return nodes.flatMap((node) => [node, ...flat(node.children)]);
}

function same(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((name, i) => name === right[i])
  );
}

const planned = planWorld(project, world);
if (!planned.ok) {
  throw new Error(planned.errors.map((item) => item.message).join("; "));
}
const board = planned.plan.boards.find((item) => item.id === "promicro");
expect(board, "the example has a promicro board");
if (!board) throw new Error("unreachable");

expect(board.chip === "atmega32u4", "chip is the 32U4");
expect(same(board.pinOrder, HEADER), `pin list ${board.pinOrder.join(" ")}`);
expect(
  board.driveOrder?.slice(-2).join() === "RXLED,TXLED",
  "RX and TX LEDs are driven after the header"
);
expect(
  board.pinOrder.includes("RXLED") === false &&
    board.pinOrder.includes("TXLED") === false,
  "the onboard LEDs are not header pins"
);
expect(board.adcLabels?.[7] === "A0", "A0 is ADC7, no MUX5");
expect(board.adcLabels?.[8] === "D4", "D4 is ADC8, through MUX5");
expect(board.adcLabels?.[9] === undefined, "ADC9 (PD6) is not on the header");
expect(board.voltagePin === "VCC" && board.vinFeed, "RAW feeds the regulator");
expect(board.resetPort === "RST", "reset is the RST header");
expect(board.brownoutVoltage === 2.6, "running brownout is the 2.6 V typical");
expect(
  board.brownoutAssertVoltage === 2.575 &&
    board.brownoutReleaseVoltage === 2.625,
  `thresholds ${board.brownoutAssertVoltage} / ${board.brownoutReleaseVoltage}`
);
expect(board.resetHoldMs === 65, `reset hold ${board.resetHoldMs} ms`);
expect(board.minOperatingVoltage === 4.5, "16 MHz needs 4.5 V");

const view = viewOf(planned.plan);
const nodes = flat(view.tree.nodes);
expect(
  nodes.some(
    (node) => node.id === "promicro.mcu" && node.type === "atmega32u4"
  ),
  "the tree shows the mcu under the board"
);
expect(
  same(view.boards.find((item) => item.id === "promicro")?.pins ?? [], HEADER),
  "the view pin list is the header"
);
const behaviour = nodes
  .find((node) => node.id === "promicro")
  ?.levels.find((axis) => axis.axis === "behaviour");
const offered = (behaviour?.options ?? []).map(
  (option) => `${option.class}:${option.variant}:${option.runnable}`
);
expect(
  offered.includes("1:avr8js:true") && offered.includes("2:circuits:true"),
  `level picker ${offered.join(" ")}`
);

const sim = headlessSim();
let ticks = 0;
let ledOn = 0;
let ledOff = 0;
try {
  const loaded = await sim.load({ project, world, generation: 1 });
  if (!loaded.ok) {
    throw new Error(loaded.errors.map((item) => item.message).join("; "));
  }
  await sim.step(1500);
  const state = sim.state();
  expect(state, "the run produced state");
  if (!state) throw new Error("unreachable");
  const live = state.boards.promicro;
  expect(live, "promicro is in the state");
  if (!live) throw new Error("unreachable");
  expect(
    live.running && !live.brownout,
    "the 9 V RAW rail leaves the CPU running"
  );
  expect((live.voltage ?? 0) > 4.5, `board node ${live.voltage} V`);

  const text = sim
    .drainSerial()
    .map((chunk) => chunk.text)
    .join("");
  ticks = text.split(/\r?\n/).filter((line) => line === "tick").length;
  expect(ticks >= 3, `Serial1 ticks ${ticks}: ${JSON.stringify(text)}`);

  const warnings = live.warnings ?? [];
  const diagnostics = state.diagnostics ?? [];
  expect((chip.gaps ?? []).length === 2, "the 32U4 names two gaps");
  for (const gap of chip.gaps ?? []) {
    const named = diagnostics.filter((row) => row.code === gap.code);
    const shown = warnings.filter((row) => row.message === gap.message);
    expect(named.length === 1, `${gap.code} diagnostic ${named.length}`);
    expect(
      shown.length === 1 && shown[0]?.code === "degraded",
      `${gap.code} warning ${shown.length}`
    );
  }

  const body = sim.record({ op: "read", from: 0, to: state.simTime });
  if (body.op !== "read") throw new Error("no recording");
  for (const frame of body.read.frames) {
    const current = frame.boards.promicro?.ledCurrent ?? 0;
    if (current > 0.001) ledOn += 1;
    if (current < 0.0002) ledOff += 1;
  }
  expect(ledOn > 0 && ledOff > 0, `RX LED on ${ledOn} off ${ledOff}`);
} finally {
  sim.dispose();
}

/** Copy the example and set the bench voltage. The lock is not copied. */
async function runRaw(volts: number, ms: number) {
  const dir = mkdtempSync(join(tmpdir(), "sfab-pro-micro-"));
  try {
    cpSync(project, dir, { recursive: true });
    const worldFile = join(dir, world);
    const doc = JSON.parse(readFileSync(worldFile, "utf8")) as {
      axes: {
        behaviour: {
          "2": {
            variants: {
              netlist: {
                netlist: { instances: { bench: { params: { V: number } } } };
              };
            };
          };
        };
      };
    };
    doc.axes.behaviour["2"].variants.netlist.netlist.instances.bench.params.V =
      volts;
    writeFileSync(worldFile, `${JSON.stringify(doc, null, 2)}\n`);
    rmSync(`${worldFile.replace(/\.json$/, "")}.lock.json`, { force: true });
    const run = headlessSim();
    try {
      const loaded = await run.load({
        project: dir,
        world,
        generation: 1,
      });
      if (!loaded.ok) {
        throw new Error(loaded.errors.map((item) => item.message).join("; "));
      }
      await run.step(ms);
      const state = run.state();
      if (!state) throw new Error(`RAW ${volts} V produced no state`);
      const live = state.boards.promicro;
      if (!live) throw new Error(`RAW ${volts} V has no board`);
      const body = run.record({ op: "read", from: 0, to: state.simTime });
      if (body.op !== "read")
        throw new Error(`RAW ${volts} V has no recording`);
      const events = body.read.events.filter(
        (event) => event.kind === "reset" || event.kind === "reboot"
      );
      return { live, events };
    } finally {
      run.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const weak = await runRaw(2, 200);
expect(
  (weak.live.voltage ?? 0) < 2.575 && (weak.live.voltage ?? 0) > 0.5,
  `weak RAW board node ${weak.live.voltage} V`
);
expect(weak.live.brownout === true, "weak RAW holds the 32U4 in reset");
expect((weak.live.resets ?? 0) === 0, "a held sag does not count a reboot");
expect(
  weak.events.some((event) => event.kind === "reset") &&
    weak.events.every((event) => event.kind !== "reboot"),
  `weak RAW events ${weak.events.map((event) => event.kind).join(" ")}`
);
expect(
  (weak.live.warnings ?? []).every((row) => row.code !== "below-16mhz-soa"),
  "SOA stays quiet while the rail is under the brownout assert"
);

// 3.6 V on RAW drops about 1 V in the AMS1117 stand-in, so the 5 V node
// sits near 2.59 V: above this chip's 2.575 V assert, below the 328P's.
const mid = await runRaw(3.6, 200);
const midVoltage = mid.live.voltage ?? 0;
expect(
  midVoltage > 2.575 && midVoltage < ATMEGA328P_ASSERT_V,
  `mid RAW node ${midVoltage} V is not between the two asserts`
);
expect(mid.live.brownout !== true, "the 32U4 stays running in that band");
expect(
  mid.events.every((event) => event.kind !== "reset"),
  "the 328P threshold would have reset this rail"
);

// Channel 7 is A0 (PF7), no MUX5. Channel 8 is D4 (PD4), MUX5 set.
// ADMUX 0x47 then 0x40 with ADCSRB MUX5, then 0xC7 against the 2.56 V ref.
// Assembled with avr8js; padded with 0xFF to the 32 KiB flash.
const image = new Uint8Array(chip.flashBytes);
image.fill(0xff);
image.set([
  0x07, 0xe4, 0x00, 0x93, 0x7c, 0x00, 0x00, 0xe0, 0x00, 0x93, 0x7b, 0x00, 0x07,
  0xec, 0x00, 0x93, 0x7a, 0x00, 0x00, 0x91, 0x7a, 0x00, 0x06, 0xfd, 0xfc, 0xcf,
  0x10, 0x91, 0x78, 0x00, 0x20, 0x91, 0x79, 0x00, 0x00, 0xe4, 0x00, 0x93, 0x7c,
  0x00, 0x08, 0xe0, 0x00, 0x93, 0x7b, 0x00, 0x07, 0xec, 0x00, 0x93, 0x7a, 0x00,
  0x00, 0x91, 0x7a, 0x00, 0x06, 0xfd, 0xfc, 0xcf, 0x30, 0x91, 0x78, 0x00, 0x40,
  0x91, 0x79, 0x00, 0x07, 0xec, 0x00, 0x93, 0x7c, 0x00, 0x00, 0xe0, 0x00, 0x93,
  0x7b, 0x00, 0x07, 0xec, 0x00, 0x93, 0x7a, 0x00, 0x00, 0x91, 0x7a, 0x00, 0x06,
  0xfd, 0xfc, 0xcf, 0x50, 0x91, 0x78, 0x00, 0x60, 0x91, 0x79, 0x00, 0xff, 0xcf,
]);
const channels: number[] = [];
const avr = new AvrBoard("adc", chip, []);
avr.setAnalog({
  supply: () => 5,
  aref: () => 0,
  channel(index) {
    channels.push(index);
    if (index === 7) return { voltage: 2.5, rSource: 0, mux: "A0" };
    if (index === 8) return { voltage: 1, rSource: 0, mux: "D4" };
    return { voltage: 0, rSource: 0, mux: `adc${index}` };
  },
});
avr.load(image);
expect(avr.running, avr.fault ?? "ADC program did not load");
for (let ms = 0; ms < 30; ms += 1) avr.stepMillis();
const word = (lo: number, hi: number) => (lo ?? 0) + ((hi ?? 0) << 8);
const count7 = word(avr.peekByte(17) ?? -1, avr.peekByte(18) ?? -1);
const count8 = word(avr.peekByte(19) ?? -1, avr.peekByte(20) ?? -1);
const countRef = word(avr.peekByte(21) ?? -1, avr.peekByte(22) ?? -1);
expect(channels.includes(7) && channels.includes(8), `channels ${channels}`);
expect(count7 === adcCount(2.5, 5), `ADC7 ${count7}`);
expect(count8 === adcCount(1, 5), `ADC8 ${count8}`);
expect(countRef === adcCount(2.5, INTERNAL_2V56_V), `2.56 V ref ${countRef}`);

closeRootWatches();
console.log(
  `pro-micro: header ${HEADER.length}, Serial1 ticks ${ticks}, ` +
    `RX LED on ${ledOn} off ${ledOff}, gaps timer4 and usb-cdc, ` +
    `brownout assert 2.575 V release 2.625 V hold 65 ms`
);
