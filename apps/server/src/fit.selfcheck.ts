import { fileURLToPath } from "node:url";

import { projectReal, readerFor } from "./world/files";
import { compileWorld } from "./world/model";
import { planWorld } from "./world/plan";
import { type MotorLaw, servoElectrical } from "./world/power";

/**
 * SG90 fit on the fixture arm, 1 ms steps, stiff rail (the supply
 * resistance is not in this file). Moving current is the mean supply
 * current over the saturated cruise of a 90° no-load step: |ω| within
 * 5% of that move's peak, drive saturated.
 */

const armDir = fileURLToPath(
  new URL("../../../examples/arm/", import.meta.url)
);

function expect(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(label);
}

/** Frozen at abccd10, the numbers the run used before the catalog tables left. */
const motor = {
  k: 0.458,
  resistance: 7.1,
  efficiency: 0.57,
  eSat: 0.3,
  quiescent: 0.01,
  armature: 0.00005,
  frictionloss: 0.002,
  damping: 0.0025,
};
const torqueLimit = 0.176;

const root = projectReal(armDir);
expect(root, "arm fixture");
if (!root) throw new Error("unreachable");
const planned = planWorld(root, "arm.world.json");
expect(
  planned.ok,
  planned.ok ? "" : planned.errors.map((error) => error.message).join("; ")
);
if (!planned.ok) throw new Error("unreachable");
const compiled = await compileWorld(
  planned.plan,
  readerFor(root, "arm.world.json")
);
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
const applied = data.qfrc_applied as Float64Array;
const upper = (model.jnt_range as Float64Array)[1] ?? 0;
const deg = (rad: number) => (rad * 180) / Math.PI;
const rad = (degrees: number) => (degrees * Math.PI) / 180;
const law: MotorLaw = motor;

expect(
  Math.abs(((model.dof_armature as Float64Array)[0] ?? 0) - motor.armature) <
    1e-12,
  "catalog armature is on the shoulder"
);
expect(
  Math.abs(
    ((model.dof_frictionloss as Float64Array)[0] ?? 0) - motor.frictionloss
  ) < 1e-12,
  "catalog frictionloss is on the shoulder"
);
expect(
  Math.abs(((model.dof_damping as Float64Array)[0] ?? 0) - motor.damping) <
    1e-12,
  "catalog damping replaces the URDF damper"
);

function run(
  commandDeg: number,
  vRail: number,
  n: number,
  q0: number,
  load = 0
): {
  angles: number[];
  peak: number;
  iMotor: number;
  torque: number;
  /** Mean supply current while saturated and within 5% of peak speed. */
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
    applied[0] = load;
    mj.mj_step(model, data);
    angles.push(qpos[0] ?? 0);
    peak = Math.max(peak, Math.abs(qvel[0] ?? 0));
    iMotor = elec.iMotor;
    torque = qfrc[0] ?? 0;
  }
  applied[0] = 0;
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

function rise1090(
  angles: number[],
  q0: number,
  command: number
): number | null {
  const span = command - q0;
  let i10 = -1;
  let i90 = -1;
  for (let i = 0; i < angles.length; i++) {
    const progress = ((angles[i] ?? q0) - q0) / span;
    if (i10 < 0 && progress >= 0.1) i10 = i;
    if (i90 < 0 && progress >= 0.9) {
      i90 = i;
      break;
    }
  }
  if (i10 < 0 || i90 < 0) return null;
  return i90 - i10;
}

function timeTo90(
  angles: number[],
  q0: number,
  command: number
): number | null {
  const span = command - q0;
  for (let i = 0; i < angles.length; i++) {
    if (((angles[i] ?? q0) - q0) / span >= 0.9) return i + 1;
  }
  return null;
}

function overshootDeg(angles: number[], command: number): number {
  let max = 0;
  for (const angle of angles) {
    const past = deg(angle - command);
    if (past > max) max = past;
  }
  return max;
}

const noLoad = run(140, 4.8, 500, rad(10));
const speed = deg(noLoad.peak);
expect(speed >= 500 && speed <= 600, `no-load speed ${speed.toFixed(1)} °/s`);

const stall = run(180, 5, 80, upper);
const iStall = Math.abs(stall.iMotor);
expect(
  iStall >= 0.7 * 0.95 && iStall <= 0.7 * 1.05,
  `stall current ${iStall.toFixed(4)} A`
);

const stall48 = run(180, 4.8, 80, upper);
const tau = Math.abs(stall48.torque);
expect(
  tau >= 0.177 * 0.95 && tau <= 0.177 * 1.05,
  `stall torque ${tau.toFixed(4)} N·m`
);

const step5 = run(45, 5, 400, rad(40));
const step10 = run(50, 5, 400, rad(40));
const step20 = run(60, 5, 500, rad(40));
const step45 = run(85, 5, 600, rad(40));
const step90 = run(110, 5, 500, rad(20));
const r5 = rise1090(step5.angles, rad(40), rad(45));
const r10 = rise1090(step10.angles, rad(40), rad(50));
const t90 = timeTo90(step90.angles, rad(20), rad(110));
expect(r5 !== null && r5 >= 40 && r5 <= 75, `5° rise ${r5} ms`);
expect(r10 !== null && r10 >= 40 && r10 <= 75, `10° rise ${r10} ms`);
expect(t90 !== null && t90 >= 130 && t90 <= 200, `90° to 90% ${t90} ms`);

const o5 = overshootDeg(step5.angles, rad(45));
const o10 = overshootDeg(step10.angles, rad(50));
const o20 = overshootDeg(step20.angles, rad(60));
const o45 = overshootDeg(step45.angles, rad(85));
expect(
  o5 <= 1 && o10 <= 1 && o20 <= 1 && o45 <= 1,
  `overshoot ${o5} ${o10} ${o20} ${o45}`
);

const iMove = step90.cruise;
expect(
  iMove !== null && iMove >= 0.1 && iMove <= 0.25,
  `moving current ${iMove} A`
);

const held = run(60, 5, 400, rad(60));
const qHold = held.angles.at(-1) ?? rad(60);
const sag44 = deg(
  rad(60) - (run(60, 5, 500, qHold, -0.044).angles.at(-1) ?? qHold)
);
const sag88 = deg(
  rad(60) - (run(60, 5, 500, qHold, -0.088).angles.at(-1) ?? qHold)
);

data.delete();
console.log(
  `fit: E_sat ${motor.eSat} rad, frictionloss ${motor.frictionloss} N·m, damping ${motor.damping} N·m·s/rad, armature ${motor.armature} kg·m²`
);
console.log(
  `fit: no-load ${speed.toFixed(1)} °/s, stall ${iStall.toFixed(3)} A, torque ${tau.toFixed(4)} N·m, ` +
    `rise 5° ${r5} ms, 10° ${r10} ms, 90° ${t90} ms, ` +
    `overshoot ${o5.toFixed(2)}/${o10.toFixed(2)}/${o20.toFixed(2)}/${o45.toFixed(2)}°, ` +
    `cruise supply ${iMove?.toFixed(3)} A`
);
console.log(
  `holding: sag ${sag44.toFixed(2)}° under 0.044 N·m, ${sag88.toFixed(2)}° under 0.088 N·m`
);
console.log("fit.selfcheck ok");
