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

import type { WorldServerMessage, WorldState } from "@sfab-bench/contract";

import { closeRootWatches } from "./projects";
import { projectReal, readerFor } from "./world/files";
import { attachWorld, stopWorld } from "./world/host";
import { compileWorld, JOINT_LIMIT_SOLREF } from "./world/model";
import { planWorld } from "./world/plan";
import { readDraft, writeDraft } from "./world/selfcheck-draft";
import {
  blankTrack,
  commandDegFromPulse,
  PULSE_US_HI,
  PULSE_US_LO,
  SERVO_US_MAX,
  SERVO_US_MIN,
  SIGNAL_GAP_MS,
  trackServo,
} from "./world/servo";
import { servoSignalDrives } from "./world/wiring";

/**
 * Servo drive on sim time. `step(1)` is one millisecond. Samples are the
 * state posted for that sim time, not whichever event arrived last.
 */

const armDir = fileURLToPath(
  new URL("../../../examples/arm/", import.meta.url)
);

function expect(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(label);
}

function deg(rad: number): number {
  return (rad * 180) / Math.PI;
}

async function compileAt(dir: string, name: string) {
  const root = projectReal(dir);
  expect(root, `${name} root`);
  if (!root) throw new Error("unreachable");
  const planned = planWorld(root, name);
  expect(
    planned.ok,
    planned.ok ? "" : planned.errors.map((error) => error.message).join("; ")
  );
  if (!planned.ok) throw new Error("unreachable");
  return compileWorld(planned.plan, readerFor(root, name));
}

function near(us: number, target: number): boolean {
  return Math.abs(us - target) <= 4;
}

const rooted = projectReal(armDir);
expect(rooted, "arm fixture resolves");
if (!rooted) throw new Error("unreachable");
const loaded = planWorld(rooted, "arm.world.json");
expect(
  loaded.ok,
  loaded.ok ? "" : loaded.errors.map((error) => error.message).join("; ")
);
if (!loaded.ok) throw new Error("unreachable");
const hold = loaded.plan;
const drives = servoSignalDrives(hold);
expect(
  drives.length === 1 &&
    drives[0]?.partId === "servo" &&
    drives[0].boardId === "uno" &&
    drives[0].pin === "D9",
  `fixture drive ${JSON.stringify(drives)}`
);

const unwired = structuredClone(hold);
unwired.wires = unwired.wires.filter((wire) => !wire.includes("servo.signal"));
expect(
  servoSignalDrives(unwired).length === 0,
  "an unwired signal is not driven"
);

const hopped = structuredClone(hold);
hopped.wires = hopped.wires.map((wire) => {
  const ends = [wire[0], wire[1]].sort().join("|");
  return ends === "servo.signal|uno.D9"
    ? (["servo.signal", "led.signal"] as [string, string])
    : wire;
});
hopped.wires.push(["led.signal", "uno.D9"]);
expect(
  servoSignalDrives(hopped).length === 0,
  "a hop through another pin is not a direct drive"
);

const analog = structuredClone(hold);
analog.wires = analog.wires.map((wire) => {
  const ends = [wire[0], wire[1]].sort().join("|");
  return ends === "servo.signal|uno.D9"
    ? (["uno.A0", "servo.signal"] as [string, string])
    : wire;
});
const a0 = servoSignalDrives(analog);
expect(
  a0.length === 1 && a0[0]?.boardId === "uno" && a0[0].pin === "A0",
  `A0 drive ${JSON.stringify(a0)}`
);
console.log("wiring: servo → uno.D9, unwired and hopped stay idle, A0 drives");

function closeTo(actual: number | null, expected: number, label: string) {
  expect(
    actual !== null && Math.abs(actual - expected) < 1e-9,
    `${label}: ${actual}`
  );
}

closeTo(commandDegFromPulse(SERVO_US_MIN), 0, "544 µs");
closeTo(commandDegFromPulse(1472), 90, "1472 µs");
closeTo(commandDegFromPulse(SERVO_US_MAX), 180, "2400 µs");
expect(commandDegFromPulse(PULSE_US_LO - 1) === null, "399 µs is no signal");
expect(commandDegFromPulse(PULSE_US_HI + 1) === null, "2601 µs is no signal");
expect(commandDegFromPulse(Number.NaN) === null, "NaN is no signal");
closeTo(commandDegFromPulse(PULSE_US_LO), 0, "400 µs clamps to 0");
closeTo(commandDegFromPulse(PULSE_US_HI), 180, "2600 µs clamps to 180");
closeTo(commandDegFromPulse(500), 0, "500 µs clamps to 0");

let track = trackServo({
  track: blankTrack(),
  simTime: 0,
  pulsesUs: [100],
});
expect(
  track.limp && track.track.commandDeg === null,
  "100 µs drops the signal"
);
track = trackServo({
  track: blankTrack(),
  simTime: 0,
  pulsesUs: [1472],
});
expect(!track.limp && track.track.commandDeg === 90, "1472 µs commands 90");
const held = trackServo({
  track: track.track,
  simTime: SIGNAL_GAP_MS / 1000,
  pulsesUs: [],
});
expect(!held.limp, "60 ms still counts as a signal");
const dropped = trackServo({
  track: track.track,
  simTime: SIGNAL_GAP_MS / 1000 + 0.001,
  pulsesUs: [],
});
expect(dropped.limp, "61 ms with no pulse is limp");
let summed = 0;
for (let i = 0; i < SIGNAL_GAP_MS; i++) summed += 0.001;
const summedHeld = trackServo({
  track: track.track,
  simTime: summed,
  pulsesUs: [],
});
expect(!summedHeld.limp, "60 summed 1 ms steps still count as a signal");
console.log("pulse map: 544/1472/2400, out of range is no signal, clamp 0–180");

const rootReal = projectReal(armDir);
expect(rootReal, "arm fixture resolves");
const compiled = await compileAt(armDir, "arm.world.json");
expect(
  compiled.ok,
  `compile: ${compiled.ok ? "" : compiled.errors.map((e) => e.message).join("; ")}`
);
if (!compiled.ok) throw new Error("unreachable");
const range = compiled.model.actuator_forcerange as Float64Array;
expect(
  Math.abs((range[0] ?? Number.NaN) + 0.176) < 1e-6 &&
    Math.abs((range[1] ?? Number.NaN) - 0.176) < 1e-6,
  `torque clamp ${range[0]}, ${range[1]}`
);
const gear = compiled.model.actuator_gear as Float64Array;
const gain = compiled.model.actuator_gainprm as Float64Array;
expect(
  Math.abs((gear[0] ?? 0) - 1) < 1e-12 && Math.abs((gain[0] ?? 0) - 1) < 1e-12,
  `motor gear ${gear[0]} gain ${gain[0]}`
);
const shoulderArmature = (compiled.model.dof_armature as Float64Array)[0] ?? 0;
const shoulderFriction =
  (compiled.model.dof_frictionloss as Float64Array)[0] ?? 0;
expect(
  Math.abs(shoulderArmature - 0.00005) < 1e-12,
  `armature ${shoulderArmature}`
);
expect(
  Math.abs(shoulderFriction - 0.002) < 1e-12,
  `frictionloss ${shoulderFriction}`
);
const shoulderDamping = (compiled.model.dof_damping as Float64Array)[0] ?? 0;
expect(
  Math.abs(shoulderDamping - 0.0025) < 1e-12,
  `damping ${shoulderDamping}`
);
const jointRange = compiled.model.jnt_actfrcrange as Float64Array;
expect(
  Math.abs((jointRange[0] ?? Number.NaN) + 0.176) < 1e-6 &&
    Math.abs((jointRange[1] ?? Number.NaN) - 0.176) < 1e-6,
  `joint torque clamp ${jointRange[0]}, ${jointRange[1]}`
);
const solref = compiled.model.jnt_solref as Float64Array;
expect(
  Math.abs((solref[0] ?? Number.NaN) - JOINT_LIMIT_SOLREF[0]) < 1e-12 &&
    Math.abs((solref[1] ?? Number.NaN) - JOINT_LIMIT_SOLREF[1]) < 1e-12,
  `limit solref ${solref[0]} ${solref[1]}`
);
const data = new compiled.mj.MjData(compiled.model);
compiled.mj.mj_resetData(compiled.model, data);
const ctrl = data.ctrl as Float64Array;
const qfrc = data.qfrc_actuator as Float64Array;
const qpos = data.qpos as Float64Array;
const upper = (compiled.model.jnt_range as Float64Array)[1] ?? 0;
let maxTorque = 0;
let peakPast = 0;
let restPast = 0;
for (let step = 0; step < 600; step++) {
  ctrl[0] = Math.PI;
  compiled.mj.mj_step(compiled.model, data);
  maxTorque = Math.max(maxTorque, Math.abs(qfrc[0] ?? 0));
  const past = (((qpos[0] ?? 0) - upper) * 180) / Math.PI;
  if (past > peakPast) peakPast = past;
  restPast = past;
}
data.delete();
expect(maxTorque <= 0.176 + 1e-6, `stop torque ${maxTorque}`);
expect(restPast < 0.2, `resting penetration ${restPast}°`);
expect(peakPast < 1, `peak penetration ${peakPast}°`);
console.log(
  `stop: ${maxTorque.toFixed(4)} N·m, rest ${restPast.toFixed(3)}°, peak ${peakPast.toFixed(3)}° solref [${JOINT_LIMIT_SOLREF.join(", ")}]`
);
compiled.model.delete();
compiled.vfs.delete();
console.log("sg90 torque clamp ±0.176 N·m");

const solRoot = mkdtempSync(join(tmpdir(), "sfab-solref-"));
try {
  cpSync(armDir, solRoot, { recursive: true });
  const urdfPath = join(solRoot, "robot/arm.urdf");
  const urdf = readFileSync(urdfPath, "utf8").replace(
    "</joint>",
    '<mujoco><joint solreflimit="0.01 1"/></mujoco></joint>'
  );
  writeFileSync(urdfPath, urdf);
  const rooted = projectReal(solRoot);
  expect(rooted, "temp root resolves");
  if (!rooted) throw new Error("unreachable");
  const authored = await compileAt(solRoot, "arm.world.json");
  expect(
    authored.ok,
    `authored solref compiles: ${authored.ok ? "" : authored.errors.map((item) => item.message).join(" | ")}`
  );
  if (authored.ok) {
    const authoredRef = authored.model.jnt_solref as Float64Array;
    expect(
      Math.abs((authoredRef[0] ?? Number.NaN) - 0.01) < 1e-9 &&
        Math.abs((authoredRef[1] ?? Number.NaN) - 1) < 1e-9,
      `URDF solreflimit kept ${authoredRef[0]} ${authoredRef[1]}`
    );
    authored.model.delete();
    authored.vfs.delete();
    console.log("URDF solreflimit 0.01 1 overrides the default");
  }
} finally {
  rmSync(solRoot, { recursive: true, force: true });
}

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

async function sample(
  project: string,
  worldRel: string,
  totalMs: number,
  stepMs: number
): Promise<{ initial: WorldState; samples: WorldState[] }> {
  const trace = openTrace(project, worldRel);
  const attached = await trace.attached;
  if ("error" in attached) throw new Error(attached.error);
  try {
    const initialEvent = trace.events.find((event) => event.type === "state");
    if (initialEvent?.type !== "state") {
      const failed = trace.events.find((event) => event.type === "error");
      const why =
        failed?.type === "error"
          ? (failed.message ??
            failed.errors.map((item) => item.message).join("; "))
          : "no state event";
      throw new Error(`no initial state: ${why}`);
    }
    const samples: WorldState[] = [];
    for (let ms = stepMs; ms <= totalMs; ms += stepMs) {
      attached.step(stepMs);
      samples.push(await trace.at(ms / 1000));
    }
    return { initial: initialEvent.state, samples };
  } finally {
    attached.detach();
    await stopWorld(project, worldRel);
  }
}

type Row = {
  t: number;
  angle: number;
  pulse: number | null;
  command: number | null;
  running: boolean;
  fault: string | undefined;
};

function rows(
  samples: WorldState[],
  robot: string,
  joint: string,
  part: string,
  board: string
): Row[] {
  return samples.map((state) => {
    const cpu = state.boards[board];
    const signal = state.parts?.[part];
    return {
      t: state.simTime,
      angle: deg(state.joints[robot]?.[joint] ?? Number.NaN),
      pulse: signal?.pulseUs ?? null,
      command: signal?.commandDeg ?? null,
      running: cpu?.running === true,
      fault: cpu?.fault,
    };
  });
}

function fullHolds(
  samples: Row[]
): { start: number; end: number; rows: Row[] }[] {
  const starts: number[] = [];
  let prev: number | null = null;
  for (let i = 0; i < samples.length; i++) {
    const command = samples[i]?.command ?? null;
    if (command === null) {
      prev = null;
      continue;
    }
    if (prev === null || Math.abs(command - prev) > 2) starts.push(i);
    prev = command;
  }
  const holds: { start: number; end: number; rows: Row[] }[] = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i];
    const to = starts[i + 1];
    if (from === undefined) continue;
    const start = samples[from]?.t;
    if (start === undefined) continue;
    const end =
      to === undefined
        ? (samples[samples.length - 1]?.t ?? start) + 0.001
        : (samples[to]?.t ?? start);
    if (end - start < 0.9 || end - start > 1.15) continue;
    holds.push({
      start,
      end,
      rows: samples.filter((row) => row.t >= start && row.t < end),
    });
  }
  return holds;
}

const TARGETS = [
  { deg: 10, us: 647 },
  { deg: 90, us: 1472 },
  { deg: 120, us: 1781 },
] as const;

function nearestTarget(us: number): (typeof TARGETS)[number] | null {
  let best: (typeof TARGETS)[number] | null = null;
  let err = Infinity;
  for (const target of TARGETS) {
    const delta = Math.abs(us - target.us);
    if (delta < err) {
      err = delta;
      best = target;
    }
  }
  return best !== null && err <= 4 ? best : null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

const traced = await sample(armDir, "arm.world.json", 3500, 1);
const arm = rows(traced.samples, "arm", "shoulder", "servo", "uno");
expect(
  arm.every((row) => row.running && row.fault === undefined),
  "the hold board faulted or reset"
);
const holds = fullHolds(arm);
const commandSketch = arm
  .filter((_row, index) => index % 200 === 0)
  .map(
    (row) =>
      `${row.t.toFixed(2)}:${row.command === null ? "-" : row.command.toFixed(0)}/${row.pulse === null ? "-" : Math.round(row.pulse)}/${row.angle.toFixed(1)}`
  )
  .join(" ");
expect(
  holds.length >= 3,
  `expected 3 holds, saw ${holds.length}; ${commandSketch}`
);
const windows: { us: number; maxErr: number; command: number }[] = [];
for (let i = 0; i < 3; i++) {
  const slot = holds[i];
  if (!slot) throw new Error("hold missing");
  const pulses = slot.rows
    .map((row) => row.pulse)
    .filter((pulse): pulse is number => pulse !== null);
  const mid = median(pulses);
  const target = nearestTarget(mid);
  expect(target, `hold ${i} pulse ${mid} is not 647, 1472, or 1781`);
  if (!target) throw new Error("unreachable");
  expect(
    target.deg === TARGETS[i]?.deg,
    `hold ${i} is ${target.deg}°, want ${TARGETS[i]?.deg}`
  );
  const tail = slot.rows.filter((row) => row.t >= slot.end - 0.2);
  expect(tail.length >= 100, `hold ${i} tail has ${tail.length} samples`);
  let maxErr = 0;
  for (const row of tail) {
    expect(
      row.pulse !== null && near(row.pulse, target.us),
      `tail pulse ${row.pulse}`
    );
    expect(row.command !== null, "tail has no command");
    const err = Math.abs(row.angle - (row.command ?? 0));
    if (err > maxErr) maxErr = err;
  }
  const tailAngles = tail.map((row) => row.angle.toFixed(1)).join(",");
  expect(
    maxErr <= 2,
    `hold ${target.deg}° last 200 ms error ${maxErr.toFixed(3)}° angles ${tailAngles}`
  );
  windows.push({ us: mid, maxErr, command: target.deg });
}
console.log(
  `hold: pulses ${windows.map((item) => item.us.toFixed(1)).join(", ")} µs; ` +
    `last-200ms max error ${windows.map((item) => item.maxErr.toFixed(3)).join(", ")}°`
);

const up = holds[1];
const from = holds[0];
if (!up || !from) throw new Error("80° move missing");
const fromCommand = from.rows[0]?.command ?? Number.NaN;
const toCommand = up.rows[0]?.command ?? Number.NaN;
const delta = toCommand - fromCommand;
expect(Math.abs(delta - 80) < 3, `move span ${delta}°`);
let overshoot = 0;
let withinMs = Number.POSITIVE_INFINITY;
for (const row of up.rows) {
  const past = Math.sign(delta) * (row.angle - (row.command ?? toCommand));
  if (past > overshoot) overshoot = past;
  if (Math.abs(row.angle - (row.command ?? toCommand)) <= 1) {
    withinMs = Math.min(withinMs, (row.t - up.start) * 1000);
  }
}
expect(overshoot < 3, `overshoot ${overshoot.toFixed(3)}°`);
expect(withinMs < 300, `within 1° at ${withinMs.toFixed(1)} ms`);
console.log(
  `motor: 80° move overshoot ${overshoot.toFixed(3)}°, ` +
    `within 1° at ${withinMs.toFixed(1)} ms`
);

const pairRoot = mkdtempSync(join(tmpdir(), "sfab-servo-pair-"));
const limpRoot = mkdtempSync(join(tmpdir(), "sfab-servo-limp-"));
try {
  cpSync(armDir, pairRoot, { recursive: true });
  const pair = readDraft(pairRoot, "arm.world.json");
  const armRobot = pair.robots[0];
  const uno = pair.boards[0];
  const servo = pair.parts[0];
  if (!armRobot || !uno || !servo?.drives) throw new Error("fixture shape");
  pair.robots = [
    { ...armRobot, id: "hold-arm" },
    {
      ...armRobot,
      id: "stall-arm",
      pose: {
        position: [0.3, 0, 0],
        rotation: [1, 0, 0, 0],
      },
    },
  ];
  pair.boards = [
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
      pose: {
        position: [0.4, 0, 0.006],
        rotation: [1, 0, 0, 0],
      },
    },
  ];
  pair.parts = [
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
  // Both arms share this supply so the test can see them disagree.
  // The limit is high enough that a stall does not sag the rail: this
  // case is the mechanical split. Shared-rail brownout is power.selfcheck.
  const shared = pair.supplies[0];
  if (!shared) throw new Error("fixture supply");
  shared.kind = "bench";
  shared.currentLimit = 2;
  pair.wires = [
    ["usb.5V", "hold.5V"],
    ["usb.GND", "hold.GND"],
    ["usb.5V", "stall.5V"],
    ["usb.GND", "stall.GND"],
    ["hold.D9", "hold-servo.signal"],
    ["hold.5V", "hold-servo.V+"],
    ["hold.GND", "hold-servo.GND"],
    ["stall.D9", "stall-servo.signal"],
    ["stall.5V", "stall-servo.V+"],
    ["stall.GND", "stall-servo.GND"],
  ];
  writeDraft(pairRoot, "pair.world.json", pair);
  const both = await sample(pairRoot, "pair.world.json", 3500, 10);
  const holdRows = rows(
    both.samples,
    "hold-arm",
    "shoulder",
    "hold-servo",
    "hold"
  );
  const stallRows = rows(
    both.samples,
    "stall-arm",
    "shoulder",
    "stall-servo",
    "stall"
  );
  expect(
    holdRows.every((row) => row.running && !row.fault) &&
      stallRows.every((row) => row.running && !row.fault),
    "a paired board faulted"
  );
  const pairHolds = fullHolds(holdRows);
  expect(pairHolds.length >= 3, `paired holds ${pairHolds.length}`);
  for (let i = 0; i < 3; i++) {
    const slot = pairHolds[i];
    const target = TARGETS[i];
    if (!slot || !target) throw new Error("paired hold missing");
    const tail = slot.rows.filter((row) => row.t >= slot.end - 0.2);
    let maxErr = 0;
    for (const row of tail) {
      expect(
        row.pulse !== null && near(row.pulse, target.us),
        `paired pulse ${row.pulse}`
      );
      const err = Math.abs(row.angle - (row.command ?? 0));
      if (err > maxErr) maxErr = err;
    }
    expect(maxErr <= 2, `paired ${target.deg}° error ${maxErr.toFixed(3)}°`);
  }
  const late = stallRows.filter((row) => row.t >= 2);
  expect(late.length > 10, "stall tail");
  let stallMin = Infinity;
  let stallMax = -Infinity;
  for (const row of late) {
    if (row.angle < stallMin) stallMin = row.angle;
    if (row.angle > stallMax) stallMax = row.angle;
    expect(
      row.pulse !== null && near(row.pulse, 2400),
      `stall pulse ${row.pulse}`
    );
    expect(
      row.command !== null && Math.abs(row.command - 180) < 1,
      `stall command ${row.command}`
    );
  }
  expect(
    stallMin >= 148 && stallMax <= 152,
    `stall arm ${stallMin.toFixed(2)}–${stallMax.toFixed(2)}°`
  );
  const differed = both.samples.some((state) => {
    const a = state.parts?.["hold-servo"];
    const b = state.parts?.["stall-servo"];
    if (!a || !b || a.pulseUs === null || b.pulseUs === null) return false;
    if (a.commandDeg === null || b.commandDeg === null) return false;
    return (
      Math.abs(a.pulseUs - b.pulseUs) > 100 &&
      Math.abs(a.commandDeg - b.commandDeg) > 20
    );
  });
  expect(differed, "the two servos never disagreed");
  console.log(
    `two arms: hold follows 10/90/120, stall stays ${stallMin.toFixed(2)}–${stallMax.toFixed(2)}°`
  );

  cpSync(armDir, limpRoot, { recursive: true });
  const limp = readDraft(limpRoot, "arm.world.json");
  limp.wires = limp.wires.map((wire) => {
    const ends = [wire[0], wire[1]].sort().join("|");
    return ends === "servo.signal|uno.D9"
      ? (["uno.D8", "servo.signal"] as [string, string])
      : wire;
  });
  writeDraft(limpRoot, "limp.world.json", limp);
  const quiet = await sample(limpRoot, "limp.world.json", 2000, 100);
  const start = deg(quiet.initial.joints.arm?.shoulder ?? Number.NaN);
  const limpRows = rows(quiet.samples, "arm", "shoulder", "servo", "uno");
  let moved = 0;
  for (const row of limpRows) {
    expect(row.pulse === null && row.command === null, "D8 produced a pulse");
    const err = Math.abs(row.angle - start);
    if (err > moved) moved = err;
  }
  expect(moved < 0.05, `limp joint moved ${moved.toFixed(4)}° from ${start}`);
  console.log(
    `limp: D8 never pulses, shoulder stays within ${moved.toFixed(4)}°`
  );
} finally {
  rmSync(pairRoot, { recursive: true, force: true });
  rmSync(limpRoot, { recursive: true, force: true });
  closeRootWatches();
}

console.log("servo.selfcheck ok");
