/** Ported from layered-sim E5 mjcf.ts (c34b085): the joint-equality mesh. */

import type { GearTrain } from "@sfab-bench/contract";

import type { CollapsedHinge } from "./gear-train";

/** Hard equality. A time-constant spring does not hold a light gear. */
const SOLREF = "0.002 1";
const SOLIMP = "1 1 0.001 0.5 2";

/**
 * Four (or N) shafts, each on its own hinge, each mesh a joint equality.
 * The load inertia is a body welded to the output. Off-axis inertia is
 * half the spin inertia: the shaft record stores only the spin term, and
 * the hinge motion does not use the transverse values.
 */
export function gearTrainXml(
  train: GearTrain,
  loadInertia: number,
  timestep: number
): string {
  const bodies = train.shafts
    .map((shaft, index) => {
      const spin = positive(shaft.inertia);
      const transverse = Math.max(spin * 0.5, 1e-15);
      const mass = positive(shaft.mass ?? 1e-6);
      const load = shaft.name === train.output ? loadBody(loadInertia) : "";
      return `    <body name="${xmlName(shaft.name)}" pos="0 0 ${n(index * 0.002)}">
      <inertial pos="0 0 0" mass="${n(mass)}" diaginertia="${n(transverse)} ${n(transverse)} ${n(spin)}"/>
      <joint name="${xmlName(shaft.name)}" type="hinge" axis="0 0 1" damping="${n(shaft.damping)}" frictionloss="${n(shaft.frictionloss)}" armature="0"/>${load}
    </body>`;
    })
    .join("\n");
  const rows = train.meshes
    .map((mesh, index) => {
      const signed = -(mesh.teethDriven / mesh.teethDriver);
      return `    <joint name="mesh${index}" joint1="${xmlName(mesh.driver)}" joint2="${xmlName(mesh.driven)}" polycoef="0 ${n(signed)} 0 0 0" solref="${SOLREF}" solimp="${SOLIMP}"/>`;
    })
    .join("\n");
  return shell(
    "gear-train",
    timestep,
    bodies,
    `  <equality>\n${rows}\n  </equality>`
  );
}

/** One output hinge with the collapsed armature, damping and friction. */
export function hingeXml(
  hinge: CollapsedHinge,
  loadInertia: number,
  timestep: number
): string {
  const body = `    <body name="output" pos="0 0 0">
      <inertial pos="0 0 0" mass="1e-6" diaginertia="1e-15 1e-15 1e-15"/>
      <joint name="output" type="hinge" axis="0 0 1" damping="${n(hinge.damping)}" frictionloss="${n(hinge.frictionloss)}" armature="${n(hinge.armature)}"/>${loadBody(loadInertia)}
    </body>`;
  return shell("hinge", timestep, body, "");
}

function loadBody(inertia: number): string {
  const spin = positive(inertia);
  const transverse = Math.max(spin * 0.5, 1e-15);
  return `
      <body name="load">
        <inertial pos="0 0 0" mass="1e-6" diaginertia="${n(transverse)} ${n(transverse)} ${n(spin)}"/>
      </body>`;
}

function shell(
  model: string,
  timestep: number,
  bodies: string,
  extra: string
): string {
  return `<mujoco model="${model}">
  <compiler angle="radian"/>
  <option timestep="${n(timestep)}" integrator="implicitfast" gravity="0 0 0"/>
  <worldbody>
    <body name="case">
      <inertial pos="0 0 0" mass="1e-6" diaginertia="1e-12 1e-12 1e-12"/>
${bodies}
    </body>
  </worldbody>
${extra}
</mujoco>
`;
}

function positive(value: number): number {
  return value > 0 ? value : 1e-15;
}

function xmlName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) {
    throw new Error(`shaft name ${name} is not an XML name`);
  }
  return name;
}

function n(value: number): string {
  if (!Number.isFinite(value))
    throw new Error(`non-finite MJCF number ${value}`);
  return String(value);
}
