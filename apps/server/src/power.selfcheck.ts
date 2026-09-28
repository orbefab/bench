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

import {
  atmega328pSoaWarning,
  type WorldServerMessage,
  type WorldState,
} from "@sfab-bench/contract";

import { BROWNOUT_RESET } from "@sfab-bench/engine-mcu";

import { closeRootWatches } from "./projects";
import {
  attachWorld,
  brownoutBootSnapshot,
  readRecording,
  stopWorld,
} from "./world/host";
import { planWorld } from "./world/plan";
import {
  BOD_ASSERT_V,
  BOD_RELEASE_V,
  displayMotion,
  noLoadSpeedRad,
  RESET_HOLD_MS,
  runningBrownout,
  servoElectrical,
  solveRail,
  stallCurrent,
  stallTorque,
  stepBrownout,
} from "./world/power";
import { readDraft, writeDraft } from "./world/selfcheck-draft";
import { viewOf } from "./world/view";
import { powerFeedsOf } from "./world/wiring";

/**
 * Power budget on sim time. Samples are the state posted for that sim
 * time. Serial text is the chunks that arrived with that state.
 */

const armDir = fileURLToPath(
  new URL("../../../examples/arm/", import.meta.url)
);

function expect(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(label);
}

/** Joint stop from the robot URDF. Not a literal in the check. */
function jointLimitRad(
  urdf: string,
  joint: string
): { lower: number; upper: number } {
  const block = urdf.match(
    new RegExp(`<joint[^>]*name="${joint}"[\\s\\S]*?</joint>`)
  );
  const lower = block?.[0].match(/lower="([^"]+)"/);
  const upper = block?.[0].match(/upper="([^"]+)"/);
  if (!lower?.[1] || !upper?.[1]) throw new Error(`${joint} limit`);
  return { lower: Number(lower[1]), upper: Number(upper[1]) };
}

const holdPlan = planWorld(armDir, "arm.world.json");
expect(
  holdPlan.ok,
  holdPlan.ok ? "" : holdPlan.errors.map((error) => error.message).join("; ")
);
if (!holdPlan.ok) throw new Error("unreachable");
const feeds = powerFeedsOf(holdPlan.plan);
expect(feeds.boards.uno === "usb", `uno feed ${feeds.boards.uno}`);
expect(feeds.parts.servo === "usb", `servo feed ${feeds.parts.servo}`);
expect(
  JSON.stringify(viewOf(holdPlan.plan).wires) ===
    JSON.stringify([
      ["usb.5V", "uno.5V"],
      ["usb.GND", "uno.GND"],
      ["uno.D9", "servo.signal"],
      ["uno.5V", "servo.V+"],
      ["uno.GND", "servo.GND"],
    ]),
  `view wires ${JSON.stringify(viewOf(holdPlan.plan).wires)}`
);

const unwired = structuredClone(holdPlan.plan);
unwired.wires = unwired.wires.filter((wire) => !wire.includes("servo.V+"));
unwired.wires.push(["usb.5V", "uno.5V"]);
const lost = powerFeedsOf(unwired);
expect(lost.parts.servo === null, "an unwired V+ is unpowered");
expect(lost.boards.uno === "usb", "the board stays on usb");
console.log("power nets: usb feeds uno and servo; unwired V+ draws nothing");

/** Frozen at abccd10, the numbers the run used before the catalog tables left. */
const law = {
  k: 0.458,
  resistance: 7.1,
  efficiency: 0.57,
  eSat: 0.3,
  quiescent: 0.01,
};
const boardCurrent = 0.05;
const usbPreset = { voltage: 5, rSeries: 0.5, currentLimit: 0.9 };
const benchRs = 0.05;
const iStall5 = stallCurrent(5, law.resistance);
expect(
  iStall5 >= 0.7 * 0.95 && iStall5 <= 0.7 * 1.05,
  `stall current ${iStall5}`
);
const tau48 = stallTorque(4.8, law);
expect(tau48 >= 0.177 * 0.95 && tau48 <= 0.177 * 1.05, `stall torque ${tau48}`);
const noLoadDeg = (noLoadSpeedRad(4.8, law.k) * 180) / Math.PI;
expect(
  Math.abs(noLoadDeg - 600) < 1,
  `ideal no-load speed ${noLoadDeg.toFixed(2)} °/s`
);

const fixed = boardCurrent + law.quiescent;
const stalled: {
  fraction: number;
  omega: number;
  k: number;
  resistance: number;
}[] = [{ fraction: 1, omega: 0, k: law.k, resistance: law.resistance }];
const usbRail = solveRail({
  vNom: usbPreset.voltage,
  rSeries: usbPreset.rSeries,
  iLimit: usbPreset.currentLimit,
  fixed,
  motors: stalled,
});
expect(
  usbRail.voltage >= 4.6 &&
    usbRail.voltage <= 4.7 &&
    usbRail.current < usbPreset.currentLimit,
  `usb stall rail ${usbRail.voltage} V ${usbRail.current} A`
);
const light = solveRail({
  vNom: usbPreset.voltage,
  rSeries: usbPreset.rSeries,
  iLimit: usbPreset.currentLimit,
  fixed,
  motors: [],
});
expect(
  light.current === fixed &&
    Math.abs(light.voltage - (5 - usbPreset.rSeries * fixed)) < 1e-9,
  `usb under the limit ${light.voltage} V`
);
const benchRail = solveRail({
  vNom: 5,
  rSeries: benchRs,
  iLimit: 0.3,
  fixed,
  motors: stalled,
});
expect(
  Math.abs(benchRail.current - 0.3) < 1e-9 &&
    benchRail.voltage > 1.6 &&
    benchRail.voltage < 1.9,
  `bench stall rail ${benchRail.voltage} V ${benchRail.current} A`
);
console.log(
  `rail: usb stall ${usbRail.voltage.toFixed(3)} V at ${usbRail.current.toFixed(3)} A, ` +
    `bench 0.3 A stall ${benchRail.voltage.toFixed(3)} V`
);

const saturated = servoElectrical({
  law,
  vRail: 5,
  errorRad: 1,
  omega: 0,
  limp: false,
  torqueLimit: 1,
});
expect(
  Math.abs(saturated.supplyCurrent - (law.quiescent + 5 / law.resistance)) <
    1e-9,
  `stall supply ${saturated.supplyCurrent}`
);
const braking = servoElectrical({
  law,
  vRail: 5,
  errorRad: 1,
  omega: 20,
  limp: false,
  torqueLimit: 1,
});
expect(braking.iMotor < 0, "back-EMF above the drive is braking");
expect(
  Math.abs(braking.supplyCurrent - law.quiescent) < 1e-9,
  `braking still drew ${braking.supplyCurrent}`
);
const coast = solveRail({
  vNom: 5,
  rSeries: 0.5,
  iLimit: 0.2,
  fixed: 0.06,
  motors: [{ fraction: 0, omega: 20, k: law.k, resistance: law.resistance }],
});
expect(
  Math.abs(coast.current - 0.06) < 1e-9 && coast.voltage > 4.9,
  `zero fraction rail ${coast.voltage} V ${coast.current} A`
);
const stallNow = {
  limp: false,
  saturated: true,
  errorRad: 1,
  omega: 0,
};
expect(
  displayMotion({ ...stallNow, stallForMs: 19 }) === "moving",
  "19 ms of stall still shows moving"
);
expect(
  displayMotion({ ...stallNow, stallForMs: 20 }) === "stall",
  "20 ms of stall shows stall"
);

const reset = runningBrownout();
const held = stepBrownout(reset, BOD_ASSERT_V - 0.001, 10);
expect(held.assertReset && held.phase === "held", "2.674 V asserts");
expect(
  !stepBrownout(reset, BOD_ASSERT_V, 10).assertReset,
  "2.675 V does not assert"
);
const waiting = stepBrownout(held, BOD_RELEASE_V, 11);
expect(
  waiting.phase === "held" && waiting.releaseAtMs === null,
  "2.725 V stays held"
);
const released = stepBrownout(held, BOD_RELEASE_V + 0.001, 12);
expect(
  released.phase === "delay" && released.releaseAtMs === 12,
  "2.726 V starts the delay"
);
const early = stepBrownout(released, 5, 12 + RESET_HOLD_MS - 1);
expect(!early.reboot && early.phase === "delay", "65 ms is still in reset");
const booted = stepBrownout(released, 5, 12 + RESET_HOLD_MS);
expect(
  booted.reboot && booted.phase === "run",
  "66 ms is the first instruction"
);
const dipped = stepBrownout(released, BOD_ASSERT_V - 0.001, 20);
expect(
  dipped.phase === "held" && dipped.releaseAtMs === null && !dipped.assertReset,
  "a dip during the delay restarts the hold"
);
console.log("brownout: assert 2.675 V, release 2.725 V, hold 66 ms");

const brownoutV = 2.7;
const inBand = atmega328pSoaWarning(3.2, brownoutV);
expect(
  inBand?.code === "below-16mhz-soa" &&
    inBand.message ===
      "supply 3.20 V is below the 3.78 V the ATmega328P needs at 16 MHz; real boards may misbehave",
  `soa message ${inBand?.message}`
);
expect(atmega328pSoaWarning(3.78, brownoutV) === null, "3.78 V is in spec");
expect(atmega328pSoaWarning(5, brownoutV) === null, "5 V is in spec");
expect(
  atmega328pSoaWarning(2.7, brownoutV) === null,
  "brownout edge is not SOA"
);
expect(atmega328pSoaWarning(2.5, brownoutV) === null, "brownout is not SOA");
console.log("soa: 3.20 V warns, 2.70 V and 3.78 V do not");

expect(
  BROWNOUT_RESET === "— brownout reset —\n",
  `marker ${JSON.stringify(BROWNOUT_RESET)}`
);

type Waiter = {
  seconds: number;
  resolve: (state: WorldState) => void;
  reject: (err: Error) => void;
};

function openTrace(project: string, worldRel: string) {
  const events: WorldServerMessage[] = [];
  const waiters: Waiter[] = [];
  const fail = (err: Error) => {
    for (const waiter of waiters.splice(0)) waiter.reject(err);
  };
  const attached = attachWorld(project, worldRel, {
    sender: { kind: "loopback", label: "Mac" },
    onEvent(event) {
      events.push(event);
      if (event.type === "error") {
        const text =
          event.message ?? event.errors.map((item) => item.message).join("; ");
        fail(new Error(text || "world error"));
        return;
      }
      if (event.type !== "state") return;
      for (let i = waiters.length - 1; i >= 0; i--) {
        const waiter = waiters[i];
        if (!waiter) continue;
        if (Math.abs(event.state.simTime - waiter.seconds) > 0.0004) continue;
        waiters.splice(i, 1);
        waiter.resolve(event.state);
      }
    },
  });
  return {
    events,
    attached,
    at(seconds: number): Promise<WorldState> {
      const hit = [...events]
        .reverse()
        .find(
          (event) =>
            event.type === "state" &&
            Math.abs(event.state.simTime - seconds) <= 0.0004
        );
      if (hit?.type === "state") return Promise.resolve(hit.state);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex(
            (waiter) => waiter.resolve === resolve
          );
          if (index >= 0) waiters.splice(index, 1);
          const last = [...events]
            .reverse()
            .find((event) => event.type === "state");
          const seen = last?.type === "state" ? last.state.simTime : "none";
          reject(
            new Error(`timed out at ${seconds.toFixed(3)}s, last ${seen}`)
          );
        }, 20000);
        waiters.push({
          seconds,
          resolve: (state) => {
            clearTimeout(timer);
            resolve(state);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        });
      });
    },
  };
}

type Row = {
  state: WorldState;
  serial: Record<string, string>;
};

function serialText(events: WorldServerMessage[], board: string): string {
  let text = "";
  for (const event of events) {
    if (event.type === "serial" && event.board === board) text += event.text;
  }
  return text;
}

async function sample(
  project: string,
  worldRel: string,
  totalMs: number,
  stepMs: number,
  boards: readonly string[],
  beforeStop?: () => void
): Promise<Row[]> {
  const trace = openTrace(project, worldRel);
  const attached = await trace.attached;
  if ("error" in attached) throw new Error(attached.error);
  try {
    const rows: Row[] = [];
    for (let ms = stepMs; ms <= totalMs; ms += stepMs) {
      attached.step(stepMs);
      const state = await trace.at(ms / 1000);
      const serial: Record<string, string> = {};
      for (const board of boards)
        serial[board] = serialText(trace.events, board);
      rows.push({ state, serial });
    }
    beforeStop?.();
    return rows;
  } finally {
    attached.detach();
    await stopWorld(project, worldRel);
    closeRootWatches();
  }
}

function bootCount(text: string | undefined): number {
  return text ? (text.match(/boot/g) ?? []).length : 0;
}

/** The first state posted after `from`, not whichever event is last. */
function stateAfter(
  events: WorldServerMessage[],
  from: number
): Promise<WorldState> {
  const found = () => {
    for (const event of events.slice(from)) {
      if (event.type === "state") return event.state;
    }
    return null;
  };
  const ready = found();
  if (ready) return Promise.resolve(ready);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error("timed out waiting for the state after reload"));
    }, 10000);
    const poll = setInterval(() => {
      const state = found();
      if (!state) return;
      clearInterval(poll);
      clearTimeout(timer);
      resolve(state);
    }, 15);
  });
}

const holdRows = await sample(armDir, "arm.world.json", 3500, 1, ["uno"]);
let holdMin = Infinity;
for (const row of holdRows) {
  const voltage = row.state.boards.uno?.voltage ?? Number.NaN;
  if (voltage < holdMin) holdMin = voltage;
  const board = row.state.boards.uno;
  expect(
    row.state.parts?.servo?.voltage === voltage,
    `servo V+ ${row.state.parts?.servo?.voltage} V is not the board node ${voltage} V`
  );
  expect(voltage >= 4.5, `hold rail ${voltage} V at ${row.state.simTime}`);
  expect(board?.resets === 0, `hold resets ${board?.resets}`);
  expect(board?.brownout !== true, "hold board browned out");
  expect(board?.running === true, "hold board stopped");
}
console.log(`hold minimum voltage ${holdMin.toFixed(3)} V`);

const stallRows = await sample(
  armDir,
  "arm-stall.world.json",
  2000,
  1,
  ["uno"],
  () => {
    const snap = brownoutBootSnapshot(armDir, "arm-stall.world.json", "uno");
    expect(snap, "brownout reboot did not snapshot registers");
    if (!snap) return;
    expect(
      snap.regs.DDRB === 0 &&
        snap.regs.PORTB === 0 &&
        snap.regs.SREG === 0 &&
        snap.regs.TCCR1A === 0 &&
        snap.regs.TCCR1B === 0,
      `reset regs ${JSON.stringify(snap.regs)}`
    );
    expect(
      snap.regs.UCSR0A === 0x20 && snap.regs.UCSR0C === 0x06,
      `usart ${snap.regs.UCSR0A.toString(16)} ${snap.regs.UCSR0C.toString(16)}`
    );
    expect(
      snap.pins.ddr === 0 && snap.pins.level === 0,
      `pins before the first instruction ddr ${snap.pins.ddr} level ${snap.pins.level}`
    );
    console.log(
      "brownout reboot: DDRB=PORTB=SREG=TCCR1A=TCCR1B=0, UCSR0A=0x20, UCSR0C=0x06, pins undriven"
    );
  }
);
const benchOf = (row: Row) => row.state.boards.uno;
const sagAt = stallRows.find(
  (row) => (benchOf(row)?.voltage ?? 5) < BOD_ASSERT_V
);
const resetAt = stallRows.find(
  (row) => row.state.boards.uno?.brownout === true
);
const recoveryAt = stallRows.find(
  (row) =>
    row.state.boards.uno?.brownout === true &&
    (row.state.boards.uno.resets ?? 0) === 0 &&
    (benchOf(row)?.voltage ?? 0) > BOD_RELEASE_V
);
const rebootAt = stallRows.find(
  (row) => (row.state.boards.uno?.resets ?? 0) >= 1
);
const secondBoot = stallRows.find((row) => bootCount(row.serial.uno) >= 2);
expect(sagAt, "rail never fell below 2.675 V");
const startAngle = stallRows[0]?.state.joints.arm?.shoulder ?? 0;
const shoulder = jointLimitRad(
  readFileSync(join(armDir, "robot/arm.urdf"), "utf8"),
  "shoulder"
);
let benchMin = Infinity;
let armPeak = 0;
let armAt = 0;
let angleLo = Number.POSITIVE_INFINITY;
let angleHi = Number.NEGATIVE_INFINITY;
for (const row of stallRows) {
  const voltage = benchOf(row)?.voltage ?? 5;
  const terminal = row.state.supplies?.bench?.voltage;
  expect(
    terminal === voltage,
    `bench terminal ${terminal} V is not the board node ${voltage} V`
  );
  if (voltage < benchMin) benchMin = voltage;
  const angle = row.state.joints.arm?.shoulder ?? startAngle;
  if (angle < angleLo) angleLo = angle;
  if (angle > angleHi) angleHi = angle;
  const moved = Math.abs(((angle - startAngle) * 180) / Math.PI);
  if (moved > armPeak) {
    armPeak = moved;
    armAt = row.state.simTime;
  }
}
// Each assert step's torque leaves a velocity that coasts while the
// winding is open, so the shoulder walks a few degrees. It does not
// reach the stop. 5.74° at 2 s on this fit.
const limitDeg = (shoulder.upper * 180) / Math.PI;
expect(
  angleLo >= shoulder.lower && angleHi < shoulder.upper,
  `shoulder ${angleLo.toFixed(4)}..${angleHi.toFixed(4)} rad reached the stop ${shoulder.lower}..${shoulder.upper}`
);
// The capacitors hold the board node during the brownout.
expect(
  Math.abs(benchMin - 2.099) <= 0.02,
  `bench rail minimum ${benchMin.toFixed(3)} V`
);
console.log(
  `arm peak ${armPeak.toFixed(3)}° at ${armAt.toFixed(3)} s, limit ${limitDeg.toFixed(3)}°`
);
expect(resetAt && recoveryAt && rebootAt, "reset did not recover and reboot");
if (!resetAt || !recoveryAt || !rebootAt) throw new Error("unreachable");
const holdMs = Math.round(
  (rebootAt.state.simTime - recoveryAt.state.simTime) * 1000
);
expect(Math.abs(holdMs - RESET_HOLD_MS) <= 1, `reset hold ${holdMs} ms`);
for (const row of stallRows) {
  if (row.state.simTime < resetAt.state.simTime) continue;
  if (row.state.simTime >= rebootAt.state.simTime) break;
  const pins = row.state.boards.uno?.pins;
  expect(
    row.state.boards.uno?.brownout === true &&
      pins?.ddr === 0 &&
      pins.level === 0,
    `driven during reset at ${row.state.simTime}`
  );
}
expect(
  rebootAt.serial.uno?.includes("— brownout reset —"),
  `marker missing in ${JSON.stringify(rebootAt.serial.uno)}`
);
expect(secondBoot, "firmware did not print boot a second time");
expect(
  (secondBoot?.state.simTime ?? 9) <= 2,
  `second boot at ${secondBoot?.state.simTime}`
);
console.log(
  `demo 2: min ${benchMin.toFixed(3)} V, ` +
    `reset ${resetAt.state.simTime.toFixed(3)} s, ` +
    `reboot ${holdMs} ms after ${recoveryAt.state.simTime.toFixed(3)} s, arm ${armPeak.toFixed(2)}°`
);
console.log(
  `milestone-1 arm-stall before: brownout 0.060 s, reset 0.130 s, bench minimum 1.704 V, shoulder peak 6.359°`
);
console.log(
  `milestone-1 arm-stall after: brownout ${sagAt?.state.simTime.toFixed(3)} s, ` +
    `reset ${resetAt.state.simTime.toFixed(3)} s, ` +
    `reboot ${rebootAt.state.simTime.toFixed(3)} s, ` +
    `bench minimum ${benchMin.toFixed(3)} V, ` +
    `shoulder peak ${armPeak.toFixed(3)}° at ${armAt.toFixed(3)} s, limit ${limitDeg.toFixed(3)}°`
);

const usbRoot = mkdtempSync(join(tmpdir(), "sfab-power-usb-"));
try {
  cpSync(armDir, usbRoot, { recursive: true });
  const usbWorld = readDraft(usbRoot, "arm-stall.world.json");
  usbWorld.supplies = [
    {
      id: "usb",
      kind: "usb",
      voltage: usbPreset.voltage,
      currentLimit: usbPreset.currentLimit,
      rSeries: usbPreset.rSeries,
    },
  ];
  usbWorld.wires = usbWorld.wires.map((wire) => [
    wire[0].replace(/^bench\./, "usb."),
    wire[1].replace(/^bench\./, "usb."),
  ]);
  writeDraft(usbRoot, "usb-stall.world.json", usbWorld);
  const usbRows = await sample(usbRoot, "usb-stall.world.json", 2000, 1, [
    "uno",
  ]);
  let usbMin = Infinity;
  for (const row of usbRows) {
    const voltage = row.state.boards.uno?.voltage ?? Number.NaN;
    if (voltage < usbMin) usbMin = voltage;
    expect(
      row.state.boards.uno?.brownout !== true,
      "usb stall reset the board"
    );
    expect(
      (row.state.boards.uno?.resets ?? 0) === 0,
      "usb stall counted a reset"
    );
  }
  // The board card is the 5V node. One stalled SG90 on the USB cable
  // sits at 4.494 V: the terminal is 5 − I·0.5 Ω, and the fuse plus the
  // switch drop about I·(0.15 + 0.06) Ω. Still above brownout.
  expect(Math.abs(usbMin - 4.494279) <= 1e-4, `usb stall minimum ${usbMin} V`);
  const blocked = usbRows.filter((row) => row.state.simTime >= 1.5);
  expect(blocked.length > 100, "usb stall tail");
  expect(
    blocked.every((row) => row.state.parts?.servo?.state === "stall"),
    `usb blocked joint shows ${blocked.at(-1)?.state.parts?.servo?.state}`
  );
  const steady = blocked.at(-1);
  const terminal = steady?.state.supplies?.usb?.voltage ?? Number.NaN;
  const amps = steady?.state.supplies?.usb?.current ?? Number.NaN;
  const node = steady?.state.boards.uno?.voltage ?? Number.NaN;
  expect(
    Math.abs(terminal - (usbPreset.voltage - amps * usbPreset.rSeries)) <= 1e-9,
    `usb terminal ${terminal} V at ${amps} A`
  );
  expect(Math.abs(node - 4.5067) <= 1e-4, `usb board node ${node} V`);
  expect(
    steady?.state.parts?.servo?.voltage === node,
    `servo V+ ${steady?.state.parts?.servo?.voltage} V is not the board node`
  );
  const usbCurrent = amps;
  console.log(
    `usb stall: minimum ${usbMin.toFixed(3)} V at ${usbCurrent.toFixed(3)} A, no reset in 2 s, stalled against the stop`
  );
} finally {
  rmSync(usbRoot, { recursive: true, force: true });
}

function twoArm(root: string, sharedRail: boolean): string {
  const world = readDraft(root, "arm.world.json");
  const robot = world.robots[0];
  const uno = world.boards[0];
  const servo = world.parts[0];
  const supply = world.supplies[0];
  if (!robot || !uno || !servo?.drives || !supply) {
    throw new Error("fixture shape");
  }
  world.robots = [
    { ...robot, id: "hold-arm" },
    {
      ...robot,
      id: "stall-arm",
      pose: { position: [0.3, 0, 0], rotation: [1, 0, 0, 0] },
    },
  ];
  world.boards = [
    {
      ...uno,
      id: "hold",
      firmware: "firmware/hold/hold.hex",
      source: "firmware/hold/hold.ino",
    },
    {
      ...uno,
      id: "stall",
      firmware: "firmware/stall/stall.hex",
      source: "firmware/stall/stall.ino",
      pose: { position: [0.4, 0, 0.006], rotation: [1, 0, 0, 0] },
    },
  ];
  world.parts = [
    {
      ...servo,
      id: "hold-servo",
      drives: { robot: "hold-arm", joint: "shoulder" },
    },
    {
      ...servo,
      id: "stall-servo",
      drives: { robot: "stall-arm", joint: "shoulder" },
    },
  ];
  const name = sharedRail ? "shared.world.json" : "split.world.json";
  if (sharedRail) {
    world.supplies = [
      {
        ...supply,
        id: "bench",
        kind: "bench",
        voltage: 5,
        currentLimit: 0.3,
        rSeries: benchRs,
      },
    ];
    world.wires = [
      ["bench.5V", "hold.5V"],
      ["bench.GND", "hold.GND"],
      ["bench.5V", "stall.5V"],
      ["bench.GND", "stall.GND"],
      ["hold.D9", "hold-servo.signal"],
      ["hold.5V", "hold-servo.V+"],
      ["hold.GND", "hold-servo.GND"],
      ["stall.D9", "stall-servo.signal"],
      ["stall.5V", "stall-servo.V+"],
      ["stall.GND", "stall-servo.GND"],
    ];
  } else {
    world.supplies = [
      { ...supply, id: "usb-hold" },
      {
        ...supply,
        id: "bench-stall",
        kind: "bench",
        voltage: 5,
        currentLimit: 0.3,
        rSeries: benchRs,
      },
    ];
    world.wires = [
      ["usb-hold.5V", "hold.5V"],
      ["usb-hold.GND", "hold.GND"],
      ["hold.D9", "hold-servo.signal"],
      ["hold.5V", "hold-servo.V+"],
      ["hold.GND", "hold-servo.GND"],
      ["bench-stall.5V", "stall.5V"],
      ["bench-stall.GND", "stall.GND"],
      ["stall.D9", "stall-servo.signal"],
      ["stall.5V", "stall-servo.V+"],
      ["stall.GND", "stall-servo.GND"],
    ];
  }
  writeDraft(root, name, world);
  return name;
}

const splitRoot = mkdtempSync(join(tmpdir(), "sfab-power-split-"));
const sharedRoot = mkdtempSync(join(tmpdir(), "sfab-power-shared-"));
try {
  cpSync(armDir, splitRoot, { recursive: true });
  cpSync(armDir, sharedRoot, { recursive: true });
  const splitName = twoArm(splitRoot, false);
  const split = await sample(splitRoot, splitName, 2000, 1, ["hold", "stall"]);
  let holdMin = Infinity;
  for (const row of split) {
    const voltage = row.state.boards.hold?.voltage ?? Number.NaN;
    if (voltage < holdMin) holdMin = voltage;
    const board = row.state.boards.hold;
    expect(board?.resets === 0 && board.brownout !== true, "split hold reset");
  }
  // A step from rest is the ω = 0 stall point on the USB cable, 4.509 V
  // at the board node. The class-1 terminal is about 4.64 V; the fuse and
  // the switch take the rest. 4.9 is the cruise rail and does not cover
  // that sample.
  expect(holdMin >= 4.5, `split hold rail ${holdMin} V`);
  const stallSide = split.find(
    (row) => (row.state.boards.stall?.resets ?? 0) >= 1
  );
  const stallSag = split.find(
    (row) => (row.state.boards.stall?.voltage ?? 5) < BOD_ASSERT_V
  );
  expect(stallSag, "stall supply never sagged");
  expect(stallSide, "stall board never reset");
  expect(
    stallSide?.serial.stall?.includes("— brownout reset —"),
    "stall marker missing"
  );
  expect(bootCount(stallSide?.serial.stall) >= 2, "stall did not boot again");
  console.log(
    `two supplies: hold stays ${holdMin.toFixed(2)} V, stall resets at ${stallSide?.state.simTime.toFixed(3)} s`
  );

  const sharedName = twoArm(sharedRoot, true);
  const shared = await sample(sharedRoot, sharedName, 2000, 1, [
    "hold",
    "stall",
  ]);
  // Both boards and both servos sit on one 5 V / 0.3 A bench rail.
  // The stall servo's current pulls that rail through brownout, so the
  // hold board resets even though its own servo is not stalled.
  const sharedSag = shared.find(
    (row) => (row.state.boards.hold?.voltage ?? 5) < BOD_ASSERT_V
  );
  const holdReset = shared.find(
    (row) => (row.state.boards.hold?.resets ?? 0) >= 1
  );
  const stallReset = shared.find(
    (row) => (row.state.boards.stall?.resets ?? 0) >= 1
  );
  expect(sharedSag, "shared rail never sagged");
  expect(holdReset, "hold board on the shared rail never reset");
  expect(stallReset, "stall board on the shared rail never reset");
  expect(
    holdReset.serial.hold?.includes("— brownout reset —"),
    "hold marker missing"
  );
  console.log(
    `shared rail: hold resets at ${holdReset.state.simTime.toFixed(3)} s, stall at ${stallReset.state.simTime.toFixed(3)} s`
  );

  const reloadRoot = mkdtempSync(join(tmpdir(), "sfab-power-reload-"));
  try {
    cpSync(armDir, reloadRoot, { recursive: true });
    const trace = openTrace(reloadRoot, "arm-stall.world.json");
    const attached = await trace.attached;
    if ("error" in attached) throw new Error(attached.error);
    try {
      let browned: WorldState | undefined;
      for (let ms = 1; ms <= 2000; ms++) {
        attached.step(1);
        const state = await trace.at(ms / 1000);
        if (state.boards.uno?.brownout === true) {
          browned = state;
          break;
        }
      }
      expect(browned, "never saw a brownout to reload during");
      if (!browned) throw new Error("unreachable");
      const brownedRail = browned.supplies?.bench;
      const brownedPart = browned.parts?.servo;
      expect(
        browned.boards.uno?.brownout === true &&
          (brownedRail?.voltage ?? 5) < BOD_ASSERT_V,
        `brownout sample ${browned.boards.uno?.brownout} ${brownedRail?.voltage} V ${brownedPart?.state} ${brownedPart?.current} A`
      );
      const hexPath = join(reloadRoot, "firmware/stall/stall.hex");
      const from = trace.events.length;
      writeFileSync(hexPath, readFileSync(hexPath));
      const published = await stateAfter(trace.events, from);
      const rail = published.supplies?.bench;
      const part = published.parts?.servo;
      const board = published.boards.uno;
      const quiescent = law.quiescent;
      const draw = boardCurrent + quiescent;
      expect(
        published.simTime.toFixed(3) === browned.simTime.toFixed(3),
        `reload moved sim to ${published.simTime}`
      );
      expect(rail, "reload dropped the supply");
      expect(
        part?.state === "idle" &&
          Math.abs((part.current ?? -1) - quiescent) < 1e-9,
        "servo stays at quiescent current"
      );
      if (!rail) throw new Error("unreachable");
      // The capacitors hold the board node, so the step that opens the
      // stall is not the ideal-terminal formula (4.997 V from 0.060 A).
      expect(
        rail.current + 1e-9 >= draw &&
          Math.abs(rail.voltage - 4.996) <= 0.02 &&
          Math.abs(rail.current - 0.082) <= 0.02,
        `rail ${rail.voltage} V at ${rail.current} A, draw ${draw} A`
      );
      expect(
        board?.brownout === false && board.running === true,
        `running ${board?.running} brownout ${board?.brownout} at ${rail.voltage} V`
      );
      console.log(
        `hex reload during brownout: ${rail.voltage.toFixed(2)} V, ${rail.current} A, running ${board?.running}, brownout ${board?.brownout}`
      );
    } finally {
      attached.detach();
      await stopWorld(reloadRoot, "arm-stall.world.json");
    }
  } finally {
    rmSync(reloadRoot, { recursive: true, force: true });
  }
  const soaRoot = mkdtempSync(join(tmpdir(), "sfab-soa-"));
  try {
    cpSync(join(armDir, "firmware/hold/hold.hex"), join(soaRoot, "idle.hex"));
    writeDraft(soaRoot, "soa.world.json", {
      environment: { ground: { plane: true } },
      robots: [],
      boards: [
        {
          id: "uno",
          chip: "atmega328p",
          firmware: "idle.hex",
          pose: { position: [0, 0, 0], rotation: [1, 0, 0, 0] },
          size: [0.07, 0.05, 0.01],
        },
      ],
      supplies: [
        {
          id: "usb",
          kind: "weak",
          voltage: 5,
          currentLimit: 1,
          rSeries: 36,
        },
      ],
      parts: [],
      wires: [
        ["usb.5V", "uno.5V"],
        ["usb.GND", "uno.GND"],
      ],
    });
    const trace = openTrace(soaRoot, "soa.world.json");
    const attached = await trace.attached;
    if ("error" in attached) throw new Error(attached.error);
    try {
      attached.step(20);
      const state = await trace.at(0.02);
      const voltage = state.supplies?.usb?.voltage ?? Number.NaN;
      const warning = state.boards.uno?.warnings?.[0];
      expect(Math.abs(voltage - 3.2) < 1e-9, `soa rail ${voltage}`);
      expect(state.boards.uno?.running === true, "soa board stopped");
      expect(state.boards.uno?.brownout !== true, "soa board browned out");
      expect(
        warning?.code === "below-16mhz-soa" &&
          warning.message.includes("3.20 V"),
        `soa warning ${JSON.stringify(warning)}`
      );
      const read = await readRecording(soaRoot, "soa.world.json", {
        from: 0,
        to: 0.02,
      });
      if ("error" in read) throw new Error(read.error);
      expect(
        read.frames.some((frame) => frame.boards.uno?.belowSoa === true),
        "recording dropped the out-of-SOA window"
      );
      console.log(
        `soa runtime: ${voltage.toFixed(2)} V, ${warning?.code}, recorded`
      );
    } finally {
      attached.detach();
      await stopWorld(soaRoot, "soa.world.json");
    }
  } finally {
    rmSync(soaRoot, { recursive: true, force: true });
  }
} finally {
  rmSync(splitRoot, { recursive: true, force: true });
  rmSync(sharedRoot, { recursive: true, force: true });
  closeRootWatches();
}

console.log("power.selfcheck ok");
