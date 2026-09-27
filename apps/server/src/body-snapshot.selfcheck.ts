/**
 * Body axis: the SG90 gear train collapses onto one hinge, and a
 * hinge form on the behaviour axis is rejected.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GearTrain } from "@sfab-bench/contract";

import { collapse, gearTrainErrors, reflection } from "./world/body/gear-train";
import { planWorld } from "./world/plan";

function expect(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(label);
}

/** E5 disk model and the 70/30, 50/50 split. The catalog stores these. */
const TRAIN: GearTrain = {
  input: "rotor",
  output: "output",
  shafts: [
    {
      name: "rotor",
      mass: 0.0007333759612329867,
      inertia: 5.387068780247043e-9,
      damping: 2.5726492761638665e-8,
      frictionloss: 0.000003834169141632991,
    },
    {
      name: "g1",
      mass: 0.0001484753196829288,
      inertia: 1.616580003354382e-9,
      damping: 0,
      frictionloss: 0,
    },
    {
      name: "g2",
      mass: 0.0001507365153565197,
      inertia: 1.689375384633888e-9,
      damping: 0,
      frictionloss: 0,
    },
    {
      name: "g3",
      mass: 0.0001574427566115979,
      inertia: 1.7770781240122473e-9,
      damping: 0,
      frictionloss: 0,
    },
    {
      name: "output",
      mass: 0.00010063047486217586,
      inertia: 1.397366434978325e-9,
      damping: 0.00075,
      frictionloss: 0.001,
    },
  ],
  meshes: [
    { driver: "rotor", driven: "g1", teethDriver: 9, teethDriven: 47 },
    { driver: "g1", driven: "g2", teethDriver: 10, teethDriven: 38 },
    { driver: "g2", driven: "g3", teethDriver: 8, teethDriven: 32 },
    { driver: "g3", driven: "output", teethDriver: 7, teethDriven: 23 },
  ],
};

const CATALOG_DAMPING = 0.0025;
const CATALOG_FRICTION = 0.002;

const lumped = collapse(TRAIN);
const rows = reflection(TRAIN);
expect(
  Math.abs(lumped.damping - CATALOG_DAMPING) < 1e-15,
  `damping ${lumped.damping}`
);
expect(
  Math.abs(lumped.frictionloss - CATALOG_FRICTION) < 1e-15,
  `frictionloss ${lumped.frictionloss}`
);
console.log(`SG90 collapse N ${lumped.ratio.toFixed(3)}`);
for (const row of rows) {
  console.log(
    `${row.name} n ${row.speedRatio.toFixed(3)} ` +
      `inertia ${row.inertia.toExponential(6)} ` +
      `reflected ${row.reflectedInertia.toExponential(6)} ` +
      `damping ${row.reflectedDamping.toExponential(6)} ` +
      `friction ${row.reflectedFriction.toExponential(6)}`
  );
}
console.log(`armature ${lumped.armature.toExponential(6)}`);
console.log(
  `damping ${lumped.damping} matches catalog ${CATALOG_DAMPING} within 1e-15`
);
console.log(
  `frictionloss ${lumped.frictionloss} matches catalog ${CATALOG_FRICTION} within 1e-15`
);

const idle: GearTrain = {
  ...TRAIN,
  shafts: [
    ...TRAIN.shafts,
    { name: "idle", inertia: 1e-9, damping: 0, frictionloss: 0 },
  ],
};
const idleErrors = gearTrainErrors("sfab/sg90@1.0.0", idle);
expect(idleErrors.length === 1, idleErrors.join("; "));
console.log(`reject unreached shaft: ${idleErrors[0]}`);

const root = mkdtempSync(join(tmpdir(), "sfab-hinge-"));
try {
  const partDir = join(root, "parts", "sfab");
  mkdirSync(partDir, { recursive: true });
  writeFileSync(
    join(partDir, "bad-servo@1.0.0.json"),
    JSON.stringify(badServo("hinge@1"))
  );
  writeFileSync(
    join(root, "hinge-behaviour.world.json"),
    JSON.stringify(scene())
  );
  const planned = planWorld(root, "hinge-behaviour.world.json");
  expect(!planned.ok, "hinge@1 on behaviour loaded");
  if (planned.ok) throw new Error("unreachable");
  const message = planned.errors.map((error) => error.message).join("; ");
  expect(message.includes("hinge@1 is a body-axis form"), message);
  console.log(`reject hinge@1 on behaviour: ${message}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

function badServo(form: string) {
  return {
    format: "sfab.part@1",
    id: "sfab/bad-servo@1.0.0",
    type: "hobby-servo-3wire",
    axes: {
      behaviour: {
        "1": {
          default: "bad",
          variants: {
            bad: {
              kind: "form",
              form,
              params: { armature: 1e-5, damping: 0, frictionloss: 0 },
              omits: ["test"],
            },
          },
        },
      },
    },
  };
}

function scene() {
  return {
    version: 2,
    environment: { ground: { plane: true }, gravity: [0, 0, -9.81] },
    run: { seed: 1, levels: { default: 1 } },
    root: {
      id: "scene",
      part: {
        format: "sfab.part@1",
        id: "sfab/scene@1.0.0",
        type: { format: "sfab.part-type@1", id: "scene", ports: {} },
        axes: {
          behaviour: {
            "1": {
              default: "net",
              variants: {
                net: {
                  kind: "composite",
                  omits: [],
                  netlist: {
                    instances: {
                      servo: { part: "sfab/bad-servo@1.0.0" },
                    },
                    wires: [],
                    expose: {},
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}
