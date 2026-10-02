/**
 * The HC-SR04 and the distance gauge. Echo width is checked to the
 * cycle. A world with no target and no ranger is not part of this
 * file's physics; the nano run below has neither, and it is compared
 * with itself. The level matrix runs that same gauge with the Nano
 * on its USB snapshot, and once with the sensor at class 0.
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
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  emptySnapshot,
  type LockFile,
  pinBitSet,
  type RecordingRead,
  type RunReport,
  type WorldSender,
} from "@sfab-bench/contract";
import { loadWorldV2, writeLock } from "@sfab-bench/parts";
import { closeRootWatches } from "./projects";
import { runViewerContext } from "./viewer-context";
import {
  attachWorld,
  readRecording,
  stepWorld,
  stopWorld,
  type WorldHandle,
} from "./world/host";
import {
  type LevelTable,
  lockAfterLevels,
  replaceLevels,
} from "./world/level-edit";
import { maxBoardDelta } from "./world/nano-reference";
import { nodeStore } from "./world/node-store";
import { catalogRoot } from "./world/plan";
import { noLoadSpeedRad } from "./world/power";
import { NANO_BOARD_A } from "./world/power-path";
import { worldTools } from "./world-tools";

const sender: WorldSender = { kind: "loopback", label: "Mac" };
const C = 343;
const HZ = 16_000_000;
const FACE = 0.0128;
const CARD_HALF = 0.0025;
const HALF_ANGLE = 0.1308996938995747;
const RAY_STEP = HALF_ANGLE / 5;

const gaugeDir = fileURLToPath(
  new URL("../../../examples/gauge/", import.meta.url)
);
const nanoDir = fileURLToPath(
  new URL("../../../examples/nano/", import.meta.url)
);
const fixtureDir = fileURLToPath(
  new URL("../fixtures/gauge/", import.meta.url)
);

function driveSamples(
  read: RecordingRead
): { fraction: number; d13: "high" | "low" | "input" }[] {
  return read.frames.map((frame) => {
    const pulse = frame.parts.servo?.pulseUs ?? 0;
    const pins = frame.boards.nano?.pins;
    const driving = pins ? pinBitSet(pins.ddr, 13) : false;
    const high = pins ? pinBitSet(pins.level, 13) : false;
    const fraction =
      pulse > 0 ? Math.min(1, Math.max(0, (pulse - 1000) / 1000)) : 0;
    return {
      fraction,
      d13: !driving ? "input" : high ? "high" : "low",
    };
  });
}

function widthS(distanceM: number): number {
  const cycles = Math.max(1, Math.round(((2 * distanceM) / C) * HZ));
  return cycles / HZ;
}

function card(distanceM: number) {
  return {
    id: "card",
    shape: "box" as const,
    size: [0.3, 0.005, 0.3],
    pose: {
      position: [0, FACE + distanceM + CARD_HALF, 0.05] as [
        number,
        number,
        number,
      ],
      rotation: [1, 0, 0, 0] as [number, number, number, number],
    },
  };
}

function pole(x: number) {
  return {
    id: "pole",
    shape: "cylinder" as const,
    size: { radius: 0.004, length: 0.2 },
    pose: {
      position: [x, FACE + 0.5 + 0.003, 0.05] as [number, number, number],
      rotation: [1, 0, 0, 0] as [number, number, number, number],
    },
  };
}

function worldFile(
  part: string,
  sensorLevel: number,
  target: ReturnType<typeof card> | ReturnType<typeof pole> | null
) {
  return {
    version: 2,
    environment: {
      ground: { plane: true },
      gravity: [0, 0, -9.81],
      ...(target ? { targets: [target] } : {}),
    },
    run: {
      seed: 1,
      levels: {
        default: 1,
        types: {
          "arduino-nano": { behaviour: 2 },
          ...(sensorLevel === 0
            ? { "ultrasonic-ranger-4pin": { behaviour: 0 } }
            : {}),
        },
      },
    },
    root: { id: "scene", part },
  };
}

function serialOf(read: RecordingRead): string {
  let text = "";
  for (const event of read.events) {
    if (event.kind === "serial" && event.board === "nano")
      text += event.text ?? "";
  }
  return text;
}

function linesOf(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== "boot");
}

const NANO_SNAPSHOT = "sfab/nano-power-input@1.0.0";
/** `1125300 / count` in the gauge sketch: 1.1 * 1023 * 1000, integer division. */
const VCC_SCALE = 1_125_300;

type GaugeRun = {
  read: RecordingRead;
  report: RunReport;
  hostEnvelope: string[];
  resets: number;
};

function envelopeMessages(report: RunReport): string[] {
  const out: string[] = [];
  for (const row of report.snapshots) {
    for (const message of row.envelope ?? []) out.push(message);
  }
  for (const warning of report.warnings) {
    if (warning.message.includes("envelope")) out.push(warning.message);
  }
  return out;
}

function serialGroups(read: RecordingRead): {
  readings: string[];
  vcc: number[];
} {
  const readings: string[] = [];
  const vcc: number[] = [];
  let text = "";
  for (const event of read.events) {
    if (event.kind !== "serial" || event.board !== "nano") continue;
    text += event.text ?? "";
    const chunk = text.split(/\r?\n/);
    text = chunk.pop() ?? "";
    for (const line of chunk) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === "boot") continue;
      if (trimmed.startsWith("vcc,")) {
        vcc.push(Number(trimmed.slice(4)));
        continue;
      }
      readings.push(trimmed);
    }
  }
  return { readings, vcc };
}

/** ADC counts whose integer `1125300 / count` is this printed millivolt value. */
function adcCounts(printedMv: number): number[] {
  const counts: number[] = [];
  for (let count = 1; count <= 1023; count++) {
    if (Math.floor(VCC_SCALE / count) === printedMv) counts.push(count);
  }
  return counts;
}

/** Smallest |count| gap between two printed bandgap readings. */
function adcCountGap(a: number, b: number): number {
  const left = adcCounts(a);
  const right = adcCounts(b);
  expect(
    left.length > 0 && right.length > 0,
    `vcc ${a} or ${b} mV is not an ADC reading`
  );
  let best = 1023;
  for (const ca of left) {
    for (const cb of right) best = Math.min(best, Math.abs(ca - cb));
  }
  return best;
}

function railMv(
  low: RecordingRead,
  high: RecordingRead
): { maxAbsMv: number; rmsMv: number } {
  expect(
    low.frames.length === high.frames.length,
    `5V frames ${low.frames.length} vs ${high.frames.length}`
  );
  const err: number[] = [];
  for (let i = 0; i < low.frames.length; i++) {
    const a = low.frames[i]?.boards.nano?.voltage;
    const b = high.frames[i]?.boards.nano?.voltage;
    expect(a !== undefined && b !== undefined, `5V sample ${i}`);
    err.push((b ?? 0) - (a ?? 0));
  }
  const maxAbs = err.reduce((max, item) => Math.max(max, Math.abs(item)), 0);
  let sum = 0;
  for (const item of err) sum += item * item;
  return {
    maxAbsMv: maxAbs * 1000,
    rmsMv: Math.sqrt(sum / err.length) * 1000,
  };
}

function flagMaxDeg(low: RecordingRead, high: RecordingRead): number {
  expect(
    low.frames.length === high.frames.length,
    `flag frames ${low.frames.length} vs ${high.frames.length}`
  );
  let max = 0;
  for (let i = 0; i < low.frames.length; i++) {
    const a = low.frames[i]?.joints.gauge?.servo;
    const b = high.frames[i]?.joints.gauge?.servo;
    expect(a !== undefined && b !== undefined, `flag joint ${i}`);
    const deg = Math.abs((b ?? 0) - (a ?? 0)) * (180 / Math.PI);
    if (deg > max) max = deg;
  }
  return max;
}

function brownoutCount(run: GaugeRun): number {
  let frames = 0;
  for (const frame of run.read.frames) {
    const board = frame.boards.nano;
    if (board?.brownout || board?.brownoutAny) frames += 1;
  }
  let marks = 0;
  for (const event of run.read.events) {
    if (
      (event.kind === "reset" || event.kind === "reboot") &&
      event.board === "nano"
    ) {
      marks += 1;
    }
  }
  return run.resets + frames + marks;
}

function assertGaugeMatrix(
  mixA: GaugeRun,
  mixB: GaugeRun,
  mixBAgain: GaugeRun,
  mixC: GaugeRun,
  pack: (read: RecordingRead) => string
): void {
  const nano2 = {
    class: 2,
    variant: "circuits",
    reason: "type rule arduino-nano",
  };
  const nano1 = {
    class: 1,
    variant: "avr8js",
    reason: "type rule arduino-nano",
  };
  const sensor1 = { class: 1, variant: "datasheet", reason: "default" };
  const sensor0 = {
    class: 0,
    variant: "ideal",
    reason: "type rule ultrasonic-ranger-4pin",
  };
  expectMix("A", mixA, nano2, sensor1, false);
  expectMix("B", mixB, nano1, sensor1, true);
  expectMix("C", mixC, nano1, sensor0, true);

  const aSerial = serialGroups(mixA.read);
  const bSerial = serialGroups(mixB.read);
  const cSerial = serialGroups(mixC.read);
  const same = (left: string[], right: string[]) =>
    left.length === right.length && left.every((line, i) => line === right[i]);
  expect(
    same(aSerial.readings, bSerial.readings),
    "mix B readings differ from A"
  );
  expect(
    same(aSerial.readings, cSerial.readings),
    "mix C readings differ from A"
  );
  console.log(
    `readings: ${aSerial.readings.length} us,d_cm,angle lines identical across A, B and C`
  );

  const restMin = (label: string, lines: number[]) => {
    expect(lines.length > 0, `${label} has no vcc line`);
    return { rest: lines[0] ?? 0, min: Math.min(...lines) };
  };
  const aVcc = restMin("A", aSerial.vcc);
  const bVcc = restMin("B", bSerial.vcc);
  const cVcc = restMin("C", cSerial.vcc);
  expect(
    bSerial.vcc.length === aSerial.vcc.length,
    `mix B vcc lines ${bSerial.vcc.length} vs ${aSerial.vcc.length}`
  );
  expect(
    cSerial.vcc.length === aSerial.vcc.length,
    `mix C vcc lines ${cSerial.vcc.length} vs ${aSerial.vcc.length}`
  );
  let bGap = 0;
  let cGap = 0;
  let bWorst = "";
  let cWorst = "";
  for (let i = 0; i < aSerial.vcc.length; i++) {
    const a = aSerial.vcc[i] ?? 0;
    const b = bSerial.vcc[i] ?? 0;
    const c = cSerial.vcc[i] ?? 0;
    const bg = adcCountGap(a, b);
    const cg = adcCountGap(a, c);
    if (bg > bGap) {
      bGap = bg;
      bWorst = `${b} mV vs ${a} mV at ${i}`;
    }
    if (cg > cGap) {
      cGap = cg;
      cWorst = `${c} mV vs ${a} mV at ${i}`;
    }
  }
  const rail = railMv(mixA.read, mixB.read);
  const bNote = bGap === 0 ? "identical" : bWorst;
  const cNote = cGap === 0 ? "identical" : cWorst;
  console.log(
    `supply: A rest ${aVcc.rest} mV min ${aVcc.min} mV; ` +
      `B rest ${bVcc.rest} mV min ${bVcc.min} mV; ` +
      `C rest ${cVcc.rest} mV min ${cVcc.min} mV; ` +
      `vcc counts B vs A max ${bGap} (${bNote}), C vs A max ${cGap} (${cNote}); ` +
      `5V B vs A max-abs ${rail.maxAbsMv.toFixed(3)} mV, rms ${rail.rmsMv.toFixed(3)} mV`
  );
  // Mix B keeps the sensor, so the bandgap stays within one count of A.
  // Mix C's class-0 sensor draws no current. Two counts is the gap that holds.
  expect(bGap <= 1, `mix B vcc count gap ${bGap} (${bWorst})`);
  expect(cGap <= 2, `mix C vcc count gap ${cGap} (${cWorst})`);
  expect(
    rail.maxAbsMv <= 10,
    `5V B vs A max-abs ${rail.maxAbsMv.toFixed(3)} mV`
  );

  const flag = flagMaxDeg(mixA.read, mixB.read);
  expect(flag <= 0.5, `flag B vs A ${flag.toFixed(3)} deg`);
  console.log(`flag: B vs A max ${flag.toFixed(3)} deg`);

  const reportEnvelope = (run: GaugeRun) => envelopeMessages(run.report);
  expect(
    reportEnvelope(mixB).length === 0 && mixB.hostEnvelope.length === 0,
    `mix B envelope report ${reportEnvelope(mixB).join("; ")} host ${mixB.hostEnvelope.join("; ")}`
  );
  expect(
    reportEnvelope(mixC).length === 0 && mixC.hostEnvelope.length === 0,
    `mix C envelope report ${reportEnvelope(mixC).join("; ")} host ${mixC.hostEnvelope.join("; ")}`
  );
  expect(brownoutCount(mixA) === 0, `mix A brownout ${brownoutCount(mixA)}`);
  expect(brownoutCount(mixB) === 0, `mix B brownout ${brownoutCount(mixB)}`);
  expect(brownoutCount(mixC) === 0, `mix C brownout ${brownoutCount(mixC)}`);
  console.log("clean: no envelope warnings in B or C, no brownout resets");

  expect(
    pack(mixB.read) === pack(mixBAgain.read),
    "mix B runs are not byte-identical"
  );
  console.log("repeatable: mix B byte-identical");
}

function expectMix(
  label: string,
  run: GaugeRun,
  nano: { class: number; variant: string; reason: string },
  sensor: { class: number; variant: string; reason: string },
  snapshot: boolean
): void {
  const nanoRow = behaviourRow(run.report, "nano");
  const sensorRow = behaviourRow(run.report, "sensor");
  expect(
    nanoRow.class === nano.class &&
      nanoRow.variant === nano.variant &&
      nanoRow.reason === nano.reason,
    `${label} nano ${nanoRow.class} ${nanoRow.variant} ${nanoRow.reason}`
  );
  expect(
    sensorRow.class === sensor.class &&
      sensorRow.variant === sensor.variant &&
      sensorRow.reason === sensor.reason,
    `${label} sensor ${sensorRow.class} ${sensorRow.variant} ${sensorRow.reason}`
  );
  const snaps = run.report.snapshots.filter((row) => row.ref === NANO_SNAPSHOT);
  if (snapshot) {
    expect(
      snaps.length === 1 && snaps[0]?.quality === "Q1",
      `${label} snapshot ${snaps.map((row) => `${row.ref} ${row.quality}`).join(",")}`
    );
  } else {
    expect(
      run.report.snapshots.length === 0,
      `${label} snapshots ${run.report.snapshots.map((row) => row.ref).join(",")}`
    );
  }
  console.log(
    `levels ${label}: nano behaviour ${nanoRow.class} ${nanoRow.variant}, ${nanoRow.reason}` +
      (snapshot
        ? `, snapshot ${NANO_SNAPSHOT} ${snaps[0]?.quality}`
        : ", snapshots none") +
      `; sensor behaviour ${sensorRow.class} ${sensorRow.variant}, ${sensorRow.reason}`
  );
}

function behaviourRow(report: RunReport, part: string) {
  const row = report.levels.find(
    (item) => item.path === part && item.axis === "behaviour"
  );
  if (!row) throw new Error(`no behaviour level for ${part}`);
  return row;
}

async function run(
  root: string,
  world: string,
  ms: number
): Promise<{
  read: RecordingRead;
  echoS: number | null;
  current: number;
  voltage: number;
}> {
  const events: { type: string; message?: string }[] = [];
  const attached = await attachWorld(root, world, {
    sender,
    onEvent(event) {
      if (event.type === "error") {
        events.push({ type: event.type, message: event.message });
      }
    },
  });
  if ("error" in attached) throw new Error(attached.error);
  const handle: WorldHandle = attached;
  try {
    const stepped = await stepWorld(root, world, ms, sender);
    if ("error" in stepped) throw new Error(stepped.error);
    const read = await readRecording(root, world, { from: 0, to: ms / 1000 });
    if ("error" in read) throw new Error(read.error);
    const failed = events.find((event) => event.type === "error");
    expect(!failed, failed?.message ?? "world error");
    const sensor = stepped.state.parts?.sensor;
    return {
      read,
      echoS: sensor?.echoS ?? null,
      current: sensor?.current ?? -1,
      voltage: sensor?.voltage ?? -1,
    };
  } finally {
    handle.detach();
    await stopWorld(root, world);
    closeRootWatches();
  }
}

function sketchAngle(us: number): { d: string; angle: number } {
  const d = us / 58;
  let cm = Math.trunc(d);
  if (cm < 2) cm = 2;
  if (cm > 100) cm = 100;
  const angle = Math.trunc(((cm - 2) * 180) / 98);
  return { d: d.toFixed(2), angle };
}

const root = mkdtempSync(path.join(tmpdir(), "sfab-gauge-"));
cpSync(fixtureDir, root, { recursive: true });
const gaugeRoot = mkdtempSync(path.join(tmpdir(), "sfab-gauge-world-"));
cpSync(gaugeDir, gaugeRoot, { recursive: true });
const nanoRoot = mkdtempSync(path.join(tmpdir(), "sfab-gauge-nano-"));
cpSync(nanoDir, nanoRoot, { recursive: true });

try {
  const distances = [0.05, 0.1, 0.2, 0.5, 1, 2];
  // countPulseASM counts in 16-cycle steps, and the core turns that into
  // microseconds as width + 1. Timer0's millis interrupt is not counted,
  // so a long echo reads short by a few microseconds per 1024 us.
  let quantum = 0;
  for (const distance of distances) {
    writeFileSync(
      path.join(root, "ping.world.json"),
      `${JSON.stringify(worldFile("sfab/ping-scene@1.0.0", 1, card(distance)), null, 2)}\n`
    );
    const ran = await run(root, "ping.world.json", 250);
    const lines = linesOf(serialOf(ran.read));
    const last = lines[lines.length - 1] ?? "";
    const us = Number(last);
    const expected = widthS(distance);
    expect(
      ran.echoS !== null && Math.abs(ran.echoS - expected) < 0.5 / HZ,
      `echo ${ran.echoS} s at ${distance} m, expected ${expected}`
    );
    const expectedUs = expected * 1e6;
    const gap = us - expectedUs;
    if (Math.abs(gap) > Math.abs(quantum)) quantum = gap;
    const interruptBudget = 8 * (expectedUs / 1024) + 2;
    expect(
      gap <= 2 && gap >= -interruptBudget,
      `sketch ${us} vs part ${expectedUs.toFixed(3)} at ${distance} m`
    );
    console.log(
      `echo ${distance} m: part ${expectedUs.toFixed(3)} us, sketch ${us}`
    );
  }
  console.log(
    `pulseIn: 1 us steps, core adds 1 us, millis ISR pulls a long echo short. Largest gap ${quantum.toFixed(3)} us`
  );

  for (const distance of [0.01, 4.5]) {
    writeFileSync(
      path.join(root, "ping.world.json"),
      `${JSON.stringify(worldFile("sfab/ping-scene@1.0.0", 1, card(distance)), null, 2)}\n`
    );
    const ran = await run(root, "ping.world.json", 250);
    const last = linesOf(serialOf(ran.read)).at(-1);
    expect(last === "-1", `no echo at ${distance} m printed ${last}`);
    console.log(`no echo at ${distance} m: ${last}`);
  }

  async function beam(level: number, xs: number[]): Promise<number[]> {
    const hit: number[] = [];
    for (const x of xs) {
      writeFileSync(
        path.join(root, "beam.world.json"),
        `${JSON.stringify(worldFile("sfab/ping-scene@1.0.0", level, pole(x)), null, 2)}\n`
      );
      const ran = await run(root, "beam.world.json", 250);
      const last = linesOf(serialOf(ran.read)).at(-1);
      if (level === 0 && x === 0) {
        console.log(`class 0 on axis: sketch ${last} us`);
        expect(Number(last) > 0, `class 0 on axis printed ${last}`);
      }
      if (last !== undefined && last !== "-1") hit.push(x);
    }
    return hit;
  }

  const edgeX = 0.5 * Math.tan(HALF_ANGLE);
  const outsideX = 0.5 * Math.tan(HALF_ANGLE + RAY_STEP);
  const class1 = await beam(1, [0, edgeX, outsideX]);
  const lastX = class1[class1.length - 1] ?? -1;
  const lastAngle = Math.atan2(lastX, 0.5);
  console.log(
    `beam class 1 last offset ${lastX} m, ${(lastAngle * 180) / Math.PI} deg, hits ${class1.join(",")}`
  );
  expect(
    class1.includes(0) && Math.abs(lastAngle - HALF_ANGLE) <= RAY_STEP + 1e-6,
    `class 1 beam edge ${lastAngle} rad`
  );
  const class0 = await beam(0, [0, edgeX]);
  console.log(`beam class 0 hits ${class0.join(",") || "none"}`);
  expect(
    class0.length === 1 && class0[0] === 0,
    `class 0 beam ${class0.join(",")}`
  );

  writeFileSync(
    path.join(root, "edges.world.json"),
    `${JSON.stringify(worldFile("sfab/edges-scene@1.0.0", 1, null), null, 2)}\n`
  );
  const edges = await run(root, "edges.world.json", 200);
  const edgeLines = linesOf(serialOf(edges.read));
  console.log(`edges: ${edgeLines.join(" | ")}`);
  const edge = (name: string) => {
    const line = edgeLines.find((item) => item.startsWith(`${name},`));
    expect(line, `missing ${name}`);
    return Number(line?.split(",")[1]);
  };
  expect(edge("short") === 0, `8 us trigger returned ${edge("short")}`);
  expect(
    edges.echoS !== null && Math.abs(edges.echoS - 0.038) < 0.5 / HZ,
    `timeout echo ${edges.echoS} s`
  );
  const timeoutUs = edge("timeout");
  const timeoutBudget = 8 * (38000 / 1024) + 2;
  expect(
    timeoutUs - 38000 <= 2 && timeoutUs - 38000 >= -timeoutBudget,
    `timeout ${timeoutUs} us, expected 38000`
  );
  const again = edge("retrigger");
  expect(edge("extra") === 0, "the second trigger did not run");
  // pulseIn does not count the Timer2 ISR that pulses Trig. That ISR is
  // digitalWrite plus delayMicroseconds(10), about 24 us, so the second
  // reading is shorter by that and still the same 38 ms echo.
  expect(
    Math.abs(again - timeoutUs) <= 40,
    `retrigger ${again} us changed the timeout ${timeoutUs}`
  );
  console.log(`timeout ${timeoutUs} us, retrigger ${again} us`);

  writeFileSync(
    path.join(root, "open.world.json"),
    `${JSON.stringify(worldFile("sfab/open-scene@1.0.0", 1, card(0.1)), null, 2)}\n`
  );
  const open = await run(root, "open.world.json", 250);
  const openLast = linesOf(serialOf(open.read)).at(-1);
  expect(
    openLast === "-1" && open.current === 0,
    `unpowered ${openLast} current ${open.current}`
  );
  console.log(`unpowered: ${openLast}, current ${open.current} A`);

  writeFileSync(
    path.join(root, "bench.world.json"),
    `${JSON.stringify(worldFile("sfab/bench-scene@1.0.0", 1, card(0.1)), null, 2)}\n`
  );
  const bench = await run(root, "bench.world.json", 250);
  const benchUs = Number(linesOf(serialOf(bench.read)).at(-1));
  expect(
    benchUs > 0 && bench.current > 0 && bench.voltage > 4,
    `bench supply ${benchUs} us, ${bench.voltage} V, ${bench.current} A`
  );
  console.log(
    `bench supply: sketch ${benchUs} us, ${bench.voltage.toFixed(3)} V, current ${bench.current} A`
  );

  const gaugeWorldPath = path.join(
    gaugeRoot,
    "parts/sfab/gauge-usb@1.0.0.json"
  );
  const gaugeLockPath = path.join(
    gaugeRoot,
    "parts/sfab/gauge-usb@1.0.0.lock.json"
  );
  const gaugeWorldText = readFileSync(gaugeWorldPath, "utf8");
  const gaugeLockText = readFileSync(gaugeLockPath, "utf8");
  const gaugeLock = JSON.parse(gaugeLockText) as LockFile;

  function levelsFor(nano: 1 | 2, sensor: 0 | 1): LevelTable {
    const types: NonNullable<LevelTable["types"]> = {
      "arduino-nano": { behaviour: nano },
    };
    if (sensor === 0) types["ultrasonic-ranger-4pin"] = { behaviour: 0 };
    return { default: 1, types };
  }

  // The committed world is mix A. Other mixes rewrite only `run.levels`
  // in the temp copy, and the lock gains the snapshot the class-1 Nano runs.
  function writeGaugeLevels(nano: 1 | 2, sensor: 0 | 1): void {
    if (nano === 2 && sensor === 1) {
      writeFileSync(gaugeWorldPath, gaugeWorldText);
      writeFileSync(gaugeLockPath, gaugeLockText);
      return;
    }
    const text = replaceLevels(gaugeWorldText, levelsFor(nano, sensor));
    const temp = path.join(gaugeRoot, ".gauge-usb.level-edit.json");
    writeFileSync(temp, text);
    try {
      const loaded = loadWorldV2(temp, {
        store: nodeStore,
        catalogDir: catalogRoot(),
        assetRoot: gaugeRoot,
      });
      const errors = loaded.diagnostics.filter(
        (diag) => diag.severity === "error"
      );
      if (errors.length > 0 || !loaded.lock) {
        throw new Error(
          errors.map((diag) => diag.message).join("; ") ||
            "gauge world did not load"
        );
      }
      const decided = lockAfterLevels(gaugeLock, loaded.lock, [
        "sfab/gauge-usb@1.0.0",
      ]);
      if ("error" in decided) throw new Error(decided.error);
      writeLock(nodeStore, gaugeLockPath, decided.lock);
      writeFileSync(gaugeWorldPath, text);
    } finally {
      rmSync(temp, { force: true });
    }
  }

  async function gaugeOnce(
    nanoBehaviour: 1 | 2 = 2,
    sensorBehaviour: 0 | 1 = 1
  ): Promise<GaugeRun> {
    writeGaugeLevels(nanoBehaviour, sensorBehaviour);
    const events: { type: string; message?: string }[] = [];
    let report: RunReport | null = null;
    const hostEnvelope: string[] = [];
    const attached = await attachWorld(
      gaugeRoot,
      "parts/sfab/gauge-usb@1.0.0.json",
      {
        sender,
        onEvent(event) {
          if (event.type === "error") {
            events.push({ type: event.type, message: event.message });
          }
          if (event.type === "state" && event.report) {
            report = event.report;
            hostEnvelope.length = 0;
            hostEnvelope.push(...envelopeMessages(event.report));
          }
        },
      }
    );
    if ("error" in attached) throw new Error(attached.error);
    try {
      const stepped = await stepWorld(
        gaugeRoot,
        "parts/sfab/gauge-usb@1.0.0.json",
        7000,
        sender
      );
      if ("error" in stepped) throw new Error(stepped.error);
      const read = await readRecording(
        gaugeRoot,
        "parts/sfab/gauge-usb@1.0.0.json",
        {
          from: 0,
          to: 7,
        }
      );
      if ("error" in read) throw new Error(read.error);
      const failed = events.find((event) => event.type === "error");
      expect(!failed, failed?.message ?? "gauge world error");
      expect(report, "gauge run produced no report");
      for (const warning of stepped.state.boards.nano?.warnings ?? []) {
        if (warning.message.includes("envelope")) {
          hostEnvelope.push(warning.message);
        }
      }
      return {
        read,
        report,
        hostEnvelope,
        resets: stepped.state.boards.nano?.resets ?? 0,
      };
    } finally {
      attached.detach();
      await stopWorld(gaugeRoot, "parts/sfab/gauge-usb@1.0.0.json");
      closeRootWatches();
    }
  }

  const started = performance.now();
  const gaugeRun = await gaugeOnce();
  const gauge = gaugeRun.read;
  const elapsedMs = performance.now() - started;
  if (process.env.BENCH_TIMINGS === "1")
    console.log(
      `INFO gauge world: ${((elapsedMs / 7000) * 1000).toFixed(1)} us wall per simulated ms`
    );
  let held = 0;
  const readings: { t: number; us: number; d: number; angle: number }[] = [];
  const vcc: number[] = [];
  let text = "";
  const stamps: { t: number; line: string }[] = [];
  for (const event of gauge.events) {
    if (event.kind !== "serial" || event.board !== "nano") continue;
    text += event.text ?? "";
    const chunk = text.split(/\r?\n/);
    text = chunk.pop() ?? "";
    for (const line of chunk) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === "boot") continue;
      stamps.push({ t: event.t, line: trimmed });
    }
  }
  for (const stamp of stamps) {
    if (stamp.line.startsWith("vcc,")) {
      vcc.push(Number(stamp.line.slice(4)));
      continue;
    }
    const parts = stamp.line.split(",");
    expect(parts.length === 3, `serial ${stamp.line}`);
    const us = Number(parts[0]);
    const dText = parts[1] ?? "";
    const angle = Number(parts[2]);
    if (us === 0) {
      expect(
        dText === "-1" && angle === held,
        `hold ${stamp.line} after ${held}`
      );
    } else {
      const sketch = sketchAngle(us);
      expect(
        dText === sketch.d && angle === sketch.angle,
        `${stamp.line} vs ${sketch.d},${sketch.angle}`
      );
      held = angle;
    }
    readings.push({ t: stamp.t, us, d: us === 0 ? -1 : Number(dText), angle });
  }
  expect(vcc.length > 0, "no vcc line");
  const rest = vcc[0] ?? 0;
  const vccMin = Math.min(...vcc);
  console.log(`vcc rest ${rest} mV, minimum ${vccMin} mV, lines ${vcc.length}`);

  function angleNear(t: number, angle: number) {
    const frames = gauge.frames.filter(
      (frame) => frame.t >= t && frame.t <= t + 0.5
    );
    const hit = frames.some((frame) => {
      const q = frame.joints.gauge?.servo;
      return (
        q !== undefined &&
        Math.abs(q - (angle * Math.PI) / 180) <= (2 * Math.PI) / 180
      );
    });
    expect(hit, `flag not within 2 deg of ${angle} by ${t + 0.5} s`);
  }
  for (const t of [1, 2.5, 4]) {
    const reading = readings.find((item) => item.t >= t && item.us > 0);
    expect(reading, `no reading after ${t}`);
    if (reading) angleNear(t, reading.angle);
  }
  const afterLeave = readings.filter((item) => item.t >= 5.5);
  expect(afterLeave.length > 0, "no reading after the card leaves");
  const heldAngle = readings
    .filter((item) => item.t < 5.5 && item.us > 0)
    .at(-1)?.angle;
  expect(
    afterLeave.every((item) => item.us === 0 && item.angle === heldAngle),
    `angle did not hold at ${heldAngle}`
  );

  let peak = 0;
  let peakV = 0;
  for (let i = 1; i < gauge.frames.length; i++) {
    const frame = gauge.frames[i];
    const prev = gauge.frames[i - 1];
    if (!frame || !prev || frame.t < 2.5 || frame.t > 3.2) continue;
    const q = frame.joints.gauge?.servo;
    const pq = prev.joints.gauge?.servo;
    if (q === undefined || pq === undefined) continue;
    const dt = frame.t - prev.t;
    if (!(dt > 0)) continue;
    const speed = Math.abs(q - pq) / dt;
    if (speed > peak) {
      peak = speed;
      peakV = frame.parts.servo?.voltage ?? 0;
    }
  }
  const noload = noLoadSpeedRad(peakV, 0.458);
  console.log(
    `flag peak ${peak.toFixed(3)} rad/s, no-load ${noload.toFixed(3)} at ${peakV.toFixed(3)} V`
  );
  expect(peak >= 0.8 * noload, `peak ${peak} is under 80% of ${noload}`);

  for (const frame of gauge.frames) {
    const reading = [...readings].reverse().find((item) => item.t <= frame.t);
    const prior = [...readings]
      .reverse()
      .find((item) => item.t <= frame.t - 0.01 + 1e-9);
    if (!reading || !prior) continue;
    const on = reading.us > 0 && reading.d < 15;
    const was = prior.us > 0 && prior.d < 15;
    // The frame that contains the threshold write mixes both currents.
    if (on !== was) continue;
    const led = frame.boards.nano?.ledCurrent ?? 0;
    expect(
      on ? led > 1e-4 : led < 1e-5,
      `D13 ${led} A at ${frame.t} s, d ${reading.d}`
    );
  }

  const againGauge = (await gaugeOnce()).read;
  const pack = (read: RecordingRead) =>
    JSON.stringify({ frames: read.frames, events: read.events });
  expect(pack(gauge) === pack(againGauge), "gauge runs are not byte-identical");
  expect(
    !pack(gauge).includes(gaugeRoot),
    "gauge run depends on the temp path"
  );
  console.log(`gauge run: 7 s, ${gauge.frames.length} frames, byte-identical`);
  const gaugeDelta = maxBoardDelta(driveSamples(gauge), {
    vNom: 5,
    rSeries: 0.5,
    iLimit: 0.9,
    fixed: NANO_BOARD_A + 0.01,
    motors: [{ resistance: 7.1, k: 0.458 }],
  });
  expect(gaugeDelta <= 1e-6, `gauge mix A board delta ${gaugeDelta} V`);
  console.log(
    `nano netlist vs reference: gauge mix A ${gaugeDelta.toExponential(2)} V`
  );

  const mixA = gaugeRun;
  const mixB = await gaugeOnce(1, 1);
  const mixBAgain = await gaugeOnce(1, 1);
  const mixC = await gaugeOnce(1, 0);
  assertGaugeMatrix(mixA, mixB, mixBAgain, mixC, pack);

  writeFileSync(
    path.join(root, "move.world.json"),
    `${JSON.stringify(worldFile("sfab/ping-scene@1.0.0", 1, card(0.5)), null, 2)}\n`
  );
  await runViewerContext(
    { root, file: "", snapshot: emptySnapshot(), show: () => {} },
    async () => {
      const attached = await attachWorld(root, "move.world.json", {
        sender,
        onEvent() {},
      });
      if ("error" in attached) throw new Error(attached.error);
      try {
        const first = await stepWorld(root, "move.world.json", 250, sender);
        if ("error" in first) throw new Error(first.error);
        const moved = await worldTools.world_move_target.execute?.(
          {
            world: "move.world.json",
            id: "card",
            position: [0, FACE + 0.2 + CARD_HALF, 0.05],
          },
          {} as never
        );
        expect(
          moved && !("error" in (moved as object)),
          `move ${JSON.stringify(moved)}`
        );
        const second = await stepWorld(root, "move.world.json", 250, sender);
        if ("error" in second) throw new Error(second.error);
        const read = await readRecording(root, "move.world.json", {
          from: 0,
          to: 1,
        });
        if ("error" in read) throw new Error(read.error);
        const us = Number(linesOf(serialOf(read)).at(-1));
        const cm = us / 58;
        console.log(`move to 0.20 m: sketch ${us} us, ${cm.toFixed(2)} cm`);
        expect(Math.abs(cm - 20) < 1, `moved distance ${cm} cm`);
        const moveEvent = read.events.find(
          (event) => event.kind === "move-target"
        );
        expect(moveEvent?.kind === "move-target", "move was not recorded");
      } finally {
        attached.detach();
        await stopWorld(root, "move.world.json");
        closeRootWatches();
      }
    }
  );

  async function nanoOnce(): Promise<string> {
    const attached = await attachWorld(
      nanoRoot,
      "parts/sfab/nano-servo-usb@1.0.0.json",
      {
        sender,
        onEvent() {},
      }
    );
    if ("error" in attached) throw new Error(attached.error);
    try {
      const stepped = await stepWorld(
        nanoRoot,
        "parts/sfab/nano-servo-usb@1.0.0.json",
        200,
        sender
      );
      if ("error" in stepped) throw new Error(stepped.error);
      const read = await readRecording(
        nanoRoot,
        "parts/sfab/nano-servo-usb@1.0.0.json",
        {
          from: 0,
          to: 0.2,
        }
      );
      if ("error" in read) throw new Error(read.error);
      return JSON.stringify({ frames: read.frames, events: read.events });
    } finally {
      attached.detach();
      await stopWorld(nanoRoot, "parts/sfab/nano-servo-usb@1.0.0.json");
      closeRootWatches();
    }
  }
  const nanoA = await nanoOnce();
  const nanoB = await nanoOnce();
  expect(nanoA === nanoB, "nano world is not byte-identical");
  console.log("nano world without a target or a sensor: byte-identical");
  console.log("gauge.selfcheck ok");
} finally {
  await stopWorld(root, "ping.world.json");
  await stopWorld(gaugeRoot, "parts/sfab/gauge-usb@1.0.0.json");
  await stopWorld(nanoRoot, "parts/sfab/nano-servo-usb@1.0.0.json");
  closeRootWatches();
  rmSync(root, { recursive: true, force: true });
  rmSync(gaugeRoot, { recursive: true, force: true });
  rmSync(nanoRoot, { recursive: true, force: true });
}
