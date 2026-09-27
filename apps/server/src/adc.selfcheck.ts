/**
 * AVCC is the board node from the previous millisecond. The supply line
 * is the sketch's own `1125300 / count` on that node.
 */

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { RecordingRead, WorldState } from "@sfab-bench/contract";

import { closeRootWatches } from "./projects";
import { BANDGAP_V } from "./world/board-adc";
import { adcCount } from "./world/circuit/adc";
import {
  attachWorld,
  readAdcTrace,
  readRecording,
  stopWorld,
} from "./world/host";
import { planWorld } from "./world/plan";
import type { AdcSampleStamp, AdcTrace } from "./world/worker";

const nanoDir = fileURLToPath(
  new URL("../../../examples/nano/", import.meta.url)
);
const adcDir = fileURLToPath(new URL("../fixtures/adc/", import.meta.url));
const vccHex = join(nanoDir, "firmware/vcc/vcc.hex");

/** R2's class-2 rest node, servo limp. A holding servo sits below it. */
const LIMP_V = 4.7133;

function expect(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(label);
}

function serialOf(read: RecordingRead, board: string): string {
  let text = "";
  for (const event of read.events) {
    if (event.kind === "serial" && event.board === board) text += event.text;
  }
  return text;
}

function vccLines(text: string): number[] {
  return [...text.matchAll(/vcc,(\d+)/g)].map((match) => Number(match[1]));
}

function sketchMv(count: number): number {
  return Math.trunc(1125300 / count);
}

function nodeAt(trace: AdcTrace, board: string, ms: number): number {
  const stamp = trace.nodes.find((item) => item.ms === ms);
  const voltage = stamp?.boards[board];
  expect(voltage !== undefined, `no ${board} node at ${ms} ms`);
  return voltage;
}

function bandgap(trace: AdcTrace, board: string): AdcSampleStamp[] {
  return trace.samples.filter(
    (sample) =>
      sample.board === board &&
      sample.mux === "bandgap" &&
      sample.ref === "avcc"
  );
}

/** Each printed line is the sketch's arithmetic on the lagged node. */
function assertSupply(
  text: string,
  trace: AdcTrace,
  board: string
): { lines: number[]; rest: number; min: number; max: number; restV: number } {
  const lines = vccLines(text);
  const samples = bandgap(trace, board);
  expect(lines.length > 0, `${board} printed no vcc line`);
  expect(
    lines.length === samples.length,
    `${board} vcc lines ${lines.length}, samples ${samples.length}`
  );
  const restLines: number[] = [];
  let restV = 0;
  for (let i = 0; i < lines.length; i++) {
    const sample = samples[i];
    const line = lines[i];
    expect(sample !== undefined && line !== undefined, "vcc pair");
    if (!sample || line === undefined) continue;
    const voltage = nodeAt(trace, board, sample.ms - 1);
    expect(
      sample.vRef === voltage,
      `${board} ref ${sample.vRef} is not the node ${voltage} at ${sample.ms - 1} ms`
    );
    const count = adcCount(BANDGAP_V, voltage);
    expect(
      sample.count === count,
      `${board} count ${sample.count} is not floor(1.1/${voltage}·1024) = ${count}`
    );
    expect(
      line === sketchMv(count),
      `${board} printed ${line}, sketch would print ${sketchMv(count)}`
    );
    if (sample.ms < 1100) {
      restLines.push(line);
      restV = voltage;
    }
  }
  expect(restLines.length > 0, `${board} has no rest reading before the sweep`);
  const rest = Math.max(...restLines);
  const min = Math.min(...lines);
  const max = Math.max(...lines);
  return { lines, rest, min, max, restV };
}

async function runWorld(
  project: string,
  world: string,
  ms: number
): Promise<{ read: RecordingRead; trace: AdcTrace }> {
  const planned = planWorld(project, world);
  if (!planned.ok) {
    throw new Error(planned.errors.map((item) => item.message).join("; "));
  }
  const seen: { state: WorldState | null; failed: string | null } = {
    state: null,
    failed: null,
  };
  const attached = await attachWorld(
    project,
    world,
    {
      sender: { kind: "loopback", label: "Mac" },
      onEvent(event) {
        if (event.type === "error") {
          seen.failed =
            event.message ??
            event.errors.map((item) => item.message).join("; ");
        }
        if (event.type === "state") seen.state = event.state;
      },
    },
    { adcTrace: true }
  );
  if ("error" in attached) throw new Error(attached.error);
  try {
    attached.step(ms);
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (seen.failed) throw new Error(seen.failed);
      const simTime = seen.state?.simTime ?? -1;
      if (simTime >= ms / 1000 - 1e-3) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const state = seen.state;
    if (!state || state.simTime < ms / 1000 - 1e-3) {
      throw new Error(
        `${world} timed out at ${state ? state.simTime : "no state"} s`
      );
    }
    const read = await readRecording(project, world, {
      from: 0,
      to: ms / 1000,
    });
    if ("error" in read) throw new Error(read.error);
    const trace = await readAdcTrace(project, world);
    if ("error" in trace) throw new Error(trace.error);
    return { read, trace };
  } finally {
    attached.detach();
    await stopWorld(project, world);
    closeRootWatches();
  }
}

function field(text: string, name: string): number {
  const match = text.match(new RegExp(`${name},(\\d+)`));
  expect(match?.[1] !== undefined, `missing ${name} in ${text}`);
  return Number(match?.[1]);
}

function one(trace: AdcTrace, mux: string, ref: string): AdcSampleStamp {
  const found = trace.samples.filter(
    (sample) =>
      sample.board === "nano" && sample.mux === mux && sample.ref === ref
  );
  expect(found.length === 1, `${mux}/${ref} samples: ${found.length}`);
  const sample = found[0];
  expect(sample, mux);
  return sample;
}

function writeUno(dir: string): void {
  mkdirSync(join(dir, "firmware/vcc"), { recursive: true });
  mkdirSync(join(dir, "parts/sfab"), { recursive: true });
  cpSync(vccHex, join(dir, "firmware/vcc/vcc.hex"));
  writeFileSync(
    join(dir, "parts/sfab/uno-vcc-scene@1.0.0.json"),
    `{
  "format": "sfab.part@1",
  "id": "sfab/uno-vcc-scene@1.0.0",
  "type": "assembly",
  "foreign": false,
  "axes": {
    "behaviour": {
      "2": {
        "default": "netlist",
        "variants": {
          "netlist": {
            "kind": "composite",
            "omits": ["no snapshot of this assembly"],
            "netlist": {
              "instances": {
                "uno": {
                  "part": "sfab/uno-r3@1.0.0",
                  "params": { "firmware": "firmware/vcc/vcc.hex" }
                },
                "usb": { "part": "sfab/usb-port-500ma@1.0.0" }
              },
              "wires": [
                ["usb.5V", "uno.5V"],
                ["usb.GND", "uno.GND"]
              ],
              "expose": {}
            }
          }
        }
      }
    },
    "body": { "0": { "default": "none", "variants": { "none": { "kind": "none", "omits": ["assembly adds no body"] } } } },
    "visual": { "0": { "default": "none", "variants": { "none": { "kind": "none", "omits": ["assembly adds no visual"] } } } }
  }
}
`
  );
  writeFileSync(
    join(dir, "uno-vcc.world.json"),
    `{
  "version": 2,
  "environment": { "ground": { "plane": true }, "gravity": [0, 0, -9.81] },
  "run": { "seed": 1, "levels": { "default": 1 } },
  "root": { "id": "scene", "part": "sfab/uno-vcc-scene@1.0.0" }
}
`
  );
}

const limpCount = adcCount(BANDGAP_V, LIMP_V);
const limpMv = sketchMv(limpCount);

/** A run that never asked for the trace. */
async function assertTraceOff(project: string, world: string): Promise<void> {
  const seen: { state: WorldState | null; failed: string | null } = {
    state: null,
    failed: null,
  };
  const attached = await attachWorld(project, world, {
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
  try {
    attached.step(50);
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (seen.failed) throw new Error(seen.failed);
      if ((seen.state?.simTime ?? -1) >= 0.05 - 1e-3) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(
      (seen.state?.simTime ?? -1) >= 0.05 - 1e-3,
      "trace-off run did not start"
    );
    const trace = await readAdcTrace(project, world);
    expect(
      "error" in trace && trace.error === "ADC trace is off",
      `adc query without the option: ${"error" in trace ? trace.error : "a trace"}`
    );
    console.log("ADC trace off: query errors");
  } finally {
    attached.detach();
    await stopWorld(project, world);
    closeRootWatches();
  }
}

{
  await assertTraceOff(nanoDir, "nano-vcc-usb.world.json");

  const first = await runWorld(nanoDir, "nano-vcc-usb.world.json", 3000);
  const second = await runWorld(nanoDir, "nano-vcc-usb.world.json", 3000);
  expect(
    JSON.stringify(first.read) === JSON.stringify(second.read),
    "supply-line recordings are not byte-identical"
  );
  expect(
    JSON.stringify(first.trace) === JSON.stringify(second.trace),
    "supply-line ADC traces are not byte-identical"
  );
  const text = serialOf(first.read, "nano");
  const supply = assertSupply(text, first.trace, "nano");
  expect(supply.min < supply.rest, "the sweep did not dip the rail");
  expect(
    supply.restV < LIMP_V,
    `rest node ${supply.restV} V is not under the limp ${LIMP_V} V`
  );
  console.log(
    `Nano class 2, USB, 3 s: vcc rest ${supply.rest} mV, min ${supply.min} mV, max ${supply.max} mV`
  );
  console.log(
    `rest node ${supply.restV.toFixed(6)} V; R2 limp ${LIMP_V} V prints ${limpMv} mV, this holding rest prints ${supply.rest} mV`
  );

  const class1Dir = mkdtempSync(join(tmpdir(), "sfab-vcc-"));
  try {
    cpSync(nanoDir, class1Dir, { recursive: true });
    writeFileSync(
      join(class1Dir, "nano-vcc-class1.world.json"),
      `{
  "version": 2,
  "environment": { "ground": { "plane": true }, "gravity": [0, 0, -9.81] },
  "run": { "seed": 1, "levels": { "default": 1, "types": { "hobby-servo-3wire": { "behaviour": 1 } }, "paths": { "nano": { "behaviour": 1 } } } },
  "root": { "id": "scene", "part": "sfab/nano-vcc-scene@1.0.0" }
}
`
    );
    const class1 = await runWorld(
      class1Dir,
      "nano-vcc-class1.world.json",
      3000
    );
    const low = assertSupply(
      serialOf(class1.read, "nano"),
      class1.trace,
      "nano"
    );
    expect(
      Math.abs(low.rest - supply.rest) <= 50,
      `class 1 rest ${low.rest} mV is not within 50 mV of class 2 ${supply.rest} mV`
    );
    console.log(
      `Nano class 1 rest ${low.rest} mV, min ${low.min} mV; class 2 rest ${supply.rest} mV, min ${supply.min} mV`
    );
  } finally {
    rmSync(class1Dir, { recursive: true, force: true });
  }

  const unoDir = mkdtempSync(join(tmpdir(), "sfab-uno-vcc-"));
  try {
    writeUno(unoDir);
    const uno = await runWorld(unoDir, "uno-vcc.world.json", 1000);
    const read = assertSupply(serialOf(uno.read, "uno"), uno.trace, "uno");
    console.log(
      `Uno on USB, same image: vcc rest ${read.rest} mV, node ${read.restV.toFixed(4)} V`
    );
  } finally {
    rmSync(unoDir, { recursive: true, force: true });
  }

  const channels = await runWorld(adcDir, "channels.world.json", 500);
  const again = await runWorld(adcDir, "channels.world.json", 500);
  expect(
    JSON.stringify(channels.trace) === JSON.stringify(again.trace),
    "channel traces are not byte-identical"
  );
  const channelText = serialOf(channels.read, "nano");
  expect(
    channelText.includes("done"),
    `channels serial did not finish: ${channelText}`
  );
  const gnd = one(channels.trace, "A0", "avcc");
  const v5 = one(channels.trace, "A1", "avcc");
  const high = one(channels.trace, "A2", "avcc");
  const pull = one(channels.trace, "A3", "avcc");
  const bg = one(channels.trace, "bandgap", "avcc");
  const z = one(channels.trace, "gnd", "avcc");
  const iref = one(channels.trace, "A1", "bandgap");
  const bgV = nodeAt(channels.trace, "nano", bg.ms - 1);
  const bgCount = adcCount(BANDGAP_V, bgV);
  expect(
    gnd.count === 0 && field(channelText, "gnd") === 0,
    `A0 on GND is ${gnd.count}`
  );
  expect(
    v5.count === 1023 && field(channelText, "v5") === 1023,
    `A1 on 5V is ${v5.count}`
  );
  expect(
    high.count === 1023 && field(channelText, "high") === 1023,
    `OUTPUT HIGH is ${high.count}`
  );
  expect(
    pull.count === 1023 && field(channelText, "pull") === 1023,
    `INPUT_PULLUP is ${pull.count}`
  );
  expect(
    z.count === 0 && field(channelText, "z") === 0,
    `MUX 15 is ${z.count}`
  );
  expect(
    iref.count === 1023 && field(channelText, "iref") === 1023,
    `A1 against 1.1 V is ${iref.count}`
  );
  expect(bg.vRef === bgV, `bandgap ref ${bg.vRef} node ${bgV}`);
  expect(
    bg.count === bgCount && field(channelText, "bg") === bgCount,
    `bandgap ${bg.count} is not floor(1.1/${bgV}·1024) = ${bgCount}`
  );
  console.log(
    `channels: A0 0, A1 1023, 1.1 V ref 1023, bandgap ${bgCount}, MUX 15 0, OUTPUT HIGH 1023, INPUT_PULLUP 1023`
  );
}
