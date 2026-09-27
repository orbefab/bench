/**
 * MG90S datasheet fit, then a 3 s run of the fixture arm.
 * The fit follows fit.selfcheck.ts: 1 ms steps, stiff rail. Moving
 * current is the mean supply current over the saturated cruise of a
 * 90° no-load step, |ω| within 5% of that move's peak.
 *
 * 4.8 V uses the SG90 check's tolerance: no-load 60° time in
 * 0.10–0.12 s (peak speed 500–600 °/s) and stall torque within ±5%.
 * 6.0 V no-load time, analytical, is within 1% of the page. Stall
 * torque at 6.0 V is within 5% of the 4.8 V torque scaled by 6/4.8.
 * The simulated 6.0 V no-load time uses the same 1.2× window
 * (0.08–0.096 s), and the simulated stall torque is within ±5% of
 * the unclamped 6.0 V law.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { PartFile, RecordingRead } from "@sfab-bench/contract";

import { closeRootWatches } from "./projects";
import { projectReal, readerFor } from "./world/files";
import { attachWorld, readRecording, stepWorld, stopWorld } from "./world/host";
import { compileWorld } from "./world/model";
import { loadWorldV2 } from "./world/parts/load";
import { canonicalJson } from "./world/parts/si";
import { catalogRoot, planWorld } from "./world/plan";
import {
  type MotorLaw,
  noLoadSpeedRad,
  servoElectrical,
  stallCurrent,
  stallTorque,
} from "./world/power";

const fixtureDir = fileURLToPath(
  new URL("../fixtures/mg90s/", import.meta.url)
);
const worldName = "mg90s.world.json";
const KGF_CM_NM = 0.0980665;
const TORQUE_48 = 1.8 * KGF_CM_NM;
const TORQUE_22 = 2.2 * KGF_CM_NM;
const PAGE_SPEED_60 = Math.PI / 3 / 0.08;

function expect(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(label);
}

function num(value: unknown, label: string): number {
  expect(typeof value === "number", label);
  return value as number;
}

const partPath = path.join(catalogRoot(), "parts/sfab/mg90s@1.0.0.json");
const part = JSON.parse(readFileSync(partPath, "utf8")) as PartFile;
const behaviour = part.axes?.behaviour;
const datasheet = behaviour?.["1"]?.variants.datasheet;
const slew = behaviour?.["0"]?.variants.slew;
const lumped = part.axes?.body?.["1"]?.variants.lumped;
const box = part.axes?.visual?.["0"]?.variants.box;
expect(datasheet?.kind === "form" && slew?.kind === "form", "mg90s laws");
expect(lumped?.kind === "lumped" && box?.kind === "box", "mg90s body");
expect(behaviour?.["2"] === undefined, "mg90s has no behaviour class 2");
if (datasheet?.kind !== "form" || slew?.kind !== "form") {
  throw new Error("unreachable");
}
if (lumped?.kind !== "lumped") throw new Error("unreachable");

const law: MotorLaw = {
  k: num(datasheet.params.K, "K"),
  resistance: num(datasheet.params.R, "R"),
  efficiency: num(datasheet.params.efficiency, "efficiency"),
  eSat: num(datasheet.params.eSat, "eSat"),
  quiescent: num(datasheet.params.quiescent, "quiescent"),
};
const torqueLimit = num(part.ratings?.shaft?.torque?.[1], "shaft torque");
const joint = lumped.joint;
expect(joint, "mg90s joint");
if (!joint) throw new Error("unreachable");

const found = projectReal(fixtureDir);
expect(found, "mg90s fixture");
if (!found) throw new Error("unreachable");
const root = found;

const planned = planWorld(root, worldName);
expect(
  planned.ok,
  planned.ok ? "" : planned.errors.map((error) => error.message).join("; ")
);
if (!planned.ok) throw new Error("unreachable");
const servo = planned.plan.parts.find((item) => item.id === "servo");
if (!servo || servo.model !== "mg90s" || !servo.motor) {
  throw new Error(`servo model ${servo?.model ?? "missing"}`);
}
expect(
  servo.motor.k === law.k && servo.motor.resistance === law.resistance,
  "plan uses the MG90S law"
);

const worldFile = path.join(root, worldName);
const opts = { catalogDir: catalogRoot(), assetRoot: root };
const loaded = loadWorldV2(worldFile, opts);
const again = loadWorldV2(worldFile, opts);
const errors = loaded.diagnostics.filter((diag) => diag.severity === "error");
expect(
  errors.length === 0 && loaded.lock !== null,
  errors.map((diag) => diag.message).join("; ") || "no lock"
);
if (!loaded.lock || !again.lock) throw new Error("unreachable");
expect(
  canonicalJson(loaded.lock) === canonicalJson(again.lock),
  "lock is not stable"
);
const locked = loaded.lock.parts.find((row) => row.id === "sfab/mg90s@1.0.0");
if (!locked || locked.sha256.length !== 64 || locked.source !== "catalog") {
  throw new Error("lock does not pin the MG90S");
}
expect(
  loaded.lock.parts.every((row) => row.id !== "sfab/sg90@1.0.0"),
  "MG90S world locked an SG90"
);
console.log(`mg90s plan and lock: ${locked.sha256}`);

const compiled = await compileWorld(planned.plan, readerFor(root, worldName));
expect(
  compiled.ok,
  `compile: ${compiled.ok ? "" : compiled.errors.map((e) => e.message).join("; ")}`
);
if (!compiled.ok) throw new Error("unreachable");

const { mj, model } = compiled;
const data = new mj.MjData(model);
const ctrl = data.ctrl as Float64Array;
const qpos = data.qpos as Float64Array;
const qvel = data.qvel as Float64Array;
const qfrc = data.qfrc_actuator as Float64Array;
const upper = (model.jnt_range as Float64Array)[1] ?? 0;
const rad = (degrees: number) => (degrees * Math.PI) / 180;

expect(
  Math.abs(
    ((model.dof_armature as Float64Array)[0] ?? 0) - (joint.armature ?? 0)
  ) < 1e-12,
  "catalog armature is on the shoulder"
);
expect(
  Math.abs(
    ((model.dof_frictionloss as Float64Array)[0] ?? 0) -
      (joint.frictionloss ?? 0)
  ) < 1e-12,
  "catalog frictionloss is on the shoulder"
);
expect(
  Math.abs(
    ((model.dof_damping as Float64Array)[0] ?? 0) - (joint.damping ?? 0)
  ) < 1e-12,
  "catalog damping is on the shoulder"
);

function run(
  commandDeg: number,
  vRail: number,
  n: number,
  q0: number
): {
  angles: number[];
  peak: number;
  iMotor: number;
  torque: number;
  cruise: number | null;
} {
  mj.mj_resetData(model, data);
  qpos[0] = q0;
  qvel[0] = 0;
  const angles: number[] = [];
  const samples: { w: number; saturated: boolean; supply: number }[] = [];
  let peak = 0;
  let iMotor = 0;
  let torque = 0;
  const command = rad(commandDeg);
  for (let i = 0; i < n; i++) {
    const q = qpos[0] ?? 0;
    const w = qvel[0] ?? 0;
    const elec = servoElectrical({
      law,
      vRail,
      errorRad: command - q,
      omega: w,
      limp: false,
      torqueLimit,
    });
    samples.push({
      w,
      saturated: elec.saturated,
      supply: elec.supplyCurrent,
    });
    ctrl[0] = elec.torque;
    mj.mj_step(model, data);
    angles.push(qpos[0] ?? 0);
    peak = Math.max(peak, Math.abs(qvel[0] ?? 0));
    iMotor = elec.iMotor;
    torque = qfrc[0] ?? 0;
  }
  let sum = 0;
  let count = 0;
  for (const sample of samples) {
    if (!sample.saturated || Math.abs(sample.w) < 0.95 * peak) continue;
    sum += sample.supply;
    count += 1;
  }
  return {
    angles,
    peak,
    iMotor,
    torque,
    cruise: count > 0 ? sum / count : null,
  };
}

const t60 = (omega: number) => Math.PI / 3 / omega;
const noLoad48 = run(140, 4.8, 500, rad(10));
const noLoad6 = run(140, 6, 500, rad(10));
const stall48 = run(180, 4.8, 80, upper);
const stall6 = run(180, 6, 80, upper);
const moving = run(110, 4.8, 500, rad(20));

const time48 = t60(noLoad48.peak);
const time6 = t60(noLoad6.peak);
const tau48 = Math.abs(stall48.torque);
const tau6 = Math.abs(stall6.torque);
const i48 = Math.abs(stall48.iMotor);
const i6 = Math.abs(stall6.iMotor);
const law48 = stallTorque(4.8, law);
const law6 = stallTorque(6, law);
const law66 = stallTorque(6.6, law);
const speed6 = noLoadSpeedRad(6, law.k);
const timeMiss = ((t60(speed6) - 0.08) / 0.08) * 100;
const sellerMiss = ((law6 - TORQUE_22) / TORQUE_22) * 100;
const pageMiss = ((law66 - TORQUE_22) / TORQUE_22) * 100;
const sign = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;

console.log(
  `mg90s 6 V: no-load ${t60(speed6).toFixed(4)} s vs page 0.0800 s (${sign(timeMiss)}); ` +
    `stall torque ${law6.toFixed(4)} N·m, ${sign(sellerMiss)} from a seller 2.2 kgf·cm at 6 V; ` +
    `at 6.6 V the law is ${law66.toFixed(4)} N·m, ${sign(pageMiss)} from the page's 2.2 kgf·cm`
);
console.log(
  `mg90s stall current: 4.8 V ${(i48 * 1000).toFixed(0)} mA, 6 V ${(i6 * 1000).toFixed(0)} mA`
);
console.log(
  `mg90s moving current: ${moving.cruise === null ? "none" : `${(moving.cruise * 1000).toFixed(0)} mA`}`
);

expect(
  time48 >= 0.1 && time48 <= 0.12,
  `4.8 V no-load 60° ${time48.toFixed(4)} s`
);
expect(
  tau48 >= TORQUE_48 * 0.95 && tau48 <= TORQUE_48 * 1.05,
  `4.8 V stall torque ${tau48.toFixed(4)} N·m`
);
expect(
  Math.abs(speed6 - PAGE_SPEED_60) / PAGE_SPEED_60 <= 0.01,
  `6 V analytical speed ${speed6.toFixed(3)} rad/s`
);
expect(
  Math.abs(law6 - law48 * (6 / 4.8)) / law6 <= 0.001,
  "6 V torque is not proportional to 4.8 V"
);
expect(
  Math.abs(law6 - TORQUE_48 * (6 / 4.8)) / (TORQUE_48 * (6 / 4.8)) <= 0.05,
  `6 V law torque ${law6.toFixed(4)} N·m`
);
expect(
  time6 >= 0.08 && time6 <= 0.096,
  `6 V no-load 60° ${time6.toFixed(4)} s`
);
expect(
  tau6 >= law6 * 0.95 && tau6 <= law6 * 1.05,
  `6 V stall torque ${tau6.toFixed(4)} N·m`
);
expect(
  Math.abs(i48 - stallCurrent(4.8, law.resistance)) < 0.02,
  `4.8 V stall current ${i48.toFixed(4)} A`
);
expect(
  Math.abs(i6 - stallCurrent(6, law.resistance)) < 0.02,
  `6 V stall current ${i6.toFixed(4)} A`
);
expect(
  moving.cruise !== null && moving.cruise > 0.02 && moving.cruise < i48,
  `moving current ${moving.cruise} A`
);

console.log(
  `mg90s fit: 4.8 V no-load ${time48.toFixed(3)} s/60°, stall ${tau48.toFixed(4)} N·m; ` +
    `6 V no-load ${time6.toFixed(3)} s/60°, stall ${tau6.toFixed(4)} N·m ` +
    `(rating clamp; unclamped law ${law6.toFixed(4)} N·m)`
);

data.delete();

async function runOnce(): Promise<RecordingRead> {
  const events: { type: string; message?: string }[] = [];
  const attached = await attachWorld(root, worldName, {
    sender: { kind: "loopback", label: "Mac" },
    onEvent(event) {
      if (event.type === "error") {
        events.push({
          type: event.type,
          message:
            event.message ??
            event.errors.map((item) => item.message).join("; "),
        });
      }
    },
  });
  if ("error" in attached) throw new Error(attached.error);
  try {
    const stepped = await stepWorld(root, worldName, 3000, {
      kind: "loopback",
      label: "Mac",
    });
    if ("error" in stepped) throw new Error(stepped.error);
    const read = await readRecording(root, worldName, { from: 0, to: 3 });
    if ("error" in read) throw new Error(read.error);
    const failed = events.find((event) => event.type === "error");
    expect(!failed, failed?.message ?? "world error");
    return read;
  } finally {
    attached.detach();
    await stopWorld(root, worldName);
    closeRootWatches();
  }
}

const first = await runOnce();
const second = await runOnce();
const payload = (read: RecordingRead) =>
  JSON.stringify({ frames: read.frames, events: read.events });
expect(first.frames.length > 100, `mg90s frames ${first.frames.length}`);
expect(payload(first) === payload(second), "mg90s runs are not byte-identical");
console.log(`mg90s run: 3 s, ${first.frames.length} frames, byte-identical`);
console.log("mg90s.selfcheck ok");
