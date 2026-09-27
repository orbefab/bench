/**
 * Body axis: the SG90 gear train collapses onto one hinge, and a
 * hinge form on the behaviour axis is rejected.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GearTrain } from "@sfab-bench/contract";

import { collapse, gearTrainErrors, reflection } from "./world/body/gear-train";
import { applyLevelEdit } from "./world/level-edit";
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

  writeFileSync(
    join(root, "missing-variant.world.json"),
    JSON.stringify(sg90Scene("no-such"))
  );
  const missing = planWorld(root, "missing-variant.world.json");
  expect(!missing.ok, "missing variant loaded");
  if (missing.ok) throw new Error("unreachable");
  const missingMessage = missing.errors
    .map((error) => error.message)
    .join("; ");
  expect(
    missingMessage.includes("servo") &&
      missingMessage.includes("body") &&
      missingMessage.includes("class 1") &&
      missingMessage.includes("no-such"),
    missingMessage
  );
  console.log(`reject missing variant: ${missingMessage}`);

  writeFileSync(
    join(partDir, "two-body@1.0.0.json"),
    JSON.stringify(twoBody())
  );
  writeFileSync(
    join(root, "named-variant.world.json"),
    JSON.stringify(twoBodyScene())
  );
  const named = planWorld(root, "named-variant.world.json");
  expect(
    named.ok,
    named.ok ? "" : named.errors.map((e) => e.message).join("; ")
  );
  if (!named.ok) throw new Error("unreachable");
  const body = named.plan.report?.levels.find(
    (row) => row.path === "servo" && row.axis === "body"
  );
  expect(body?.variant === "other", `variant ${body?.variant}`);
  expect(
    body?.reason.includes("chose variant other") === true,
    `reason ${body?.reason}`
  );
  console.log(`variant rule: ${body?.variant} · ${body?.reason}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

const replaced = applyLevelEdit(
  {
    default: 1,
    paths: { servo: { body: { class: 1, variant: "collapsed" } } },
  },
  { scope: "path", key: "servo", axis: "body", class: 1 }
);
expect(!("error" in replaced), "level edit");
if ("error" in replaced) throw new Error("unreachable");
expect(
  JSON.stringify(replaced.levels.paths?.servo) === JSON.stringify({ body: 1 }),
  `edit kept the variant ${JSON.stringify(replaced.levels.paths?.servo)}`
);
const kept = applyLevelEdit(
  {
    default: 1,
    paths: { servo: { body: { class: 1, variant: "collapsed" } } },
  },
  { scope: "path", key: "servo", axis: "behaviour", class: 2 }
);
expect(!("error" in kept), "level edit other axis");
if ("error" in kept) throw new Error("unreachable");
expect(
  JSON.stringify(kept.levels.paths?.servo) ===
    JSON.stringify({
      behaviour: 2,
      body: { class: 1, variant: "collapsed" },
    }),
  `edit dropped another axis ${JSON.stringify(kept.levels.paths?.servo)}`
);
console.log(
  "world_set_level: setting a class replaces that axis's variant rule with the class alone"
);

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

function sg90Scene(variant: string) {
  return {
    version: 2,
    environment: { ground: { plane: true }, gravity: [0, 0, -9.81] },
    run: {
      seed: 1,
      levels: {
        default: 1,
        paths: { servo: { body: { class: 1, variant } } },
      },
    },
    root: {
      id: "scene",
      part: shell("sfab/sg90@1.0.0"),
    },
  };
}

function twoBody() {
  return {
    format: "sfab.part@1",
    id: "sfab/two-body@1.0.0",
    type: "hobby-servo-3wire",
    axes: {
      behaviour: {
        "1": {
          default: "datasheet",
          variants: {
            datasheet: {
              kind: "form",
              form: "dc-motor@1",
              params: {
                K: 0.458,
                R: 7.1,
                efficiency: 0.57,
                eSat: 0.3,
                quiescent: 0.01,
              },
              omits: ["test"],
            },
          },
        },
      },
      body: {
        "1": {
          default: "lumped",
          variants: {
            lumped: lumpedBody(),
            other: lumpedBody(),
          },
        },
      },
    },
  };
}

function lumpedBody() {
  return {
    kind: "lumped",
    mass: 0.009,
    com: [0, 0, 0],
    inertia: [1e-6, 1e-6, 1e-6, 0, 0, 0],
    joint: { armature: 5e-5, frictionloss: 0.002, damping: 0.0025 },
    omits: ["test"],
  };
}

function twoBodyScene() {
  return {
    version: 2,
    environment: { ground: { plane: true }, gravity: [0, 0, -9.81] },
    run: {
      seed: 1,
      levels: {
        default: 1,
        paths: { servo: { body: { class: 1, variant: "other" } } },
      },
    },
    root: { id: "scene", part: shell("sfab/two-body@1.0.0") },
  };
}

function shell(part: string) {
  return {
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
                instances: { servo: { part } },
                wires: [],
                expose: {},
              },
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
