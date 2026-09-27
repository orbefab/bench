/**
 * Body axis: the SG90 gear train collapses onto one hinge, and a
 * hinge form on the behaviour axis is rejected.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GearTrain, SnapshotFile } from "@sfab-bench/contract";
import { collapse, gearTrainErrors, reflection } from "./world/body/gear-train";
import { writeHingeSnapshot } from "./world/body/hinge-capture";
import { applyLevelEdit } from "./world/level-edit";
import { catalogRoot, planWorld } from "./world/plan";

function expect(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(label);
}

const catalog = catalogRoot();
const sg90 = JSON.parse(
  readFileSync(join(catalog, "parts/sfab/sg90@1.0.0.json"), "utf8")
) as {
  axes: {
    body: {
      "2": { variants: { "gear-train": GearTrain } };
    };
  };
};
const TRAIN = sg90.axes.body["2"].variants["gear-train"];

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

  const snapDir = join(root, "snapshots", "sfab");
  mkdirSync(snapDir, { recursive: true });
  writeFileSync(
    join(snapDir, "wrong-hinge@1.0.0.json"),
    JSON.stringify(hingeFile("other-type"))
  );
  writeFileSync(
    join(partDir, "wrong-body@1.0.0.json"),
    JSON.stringify(
      snapshotBody("sfab/wrong-body@1.0.0", "sfab/wrong-hinge@1.0.0")
    )
  );
  writeFileSync(
    join(root, "wrong-type.world.json"),
    JSON.stringify(partScene("sfab/wrong-body@1.0.0"))
  );
  const wrongType = planWorld(root, "wrong-type.world.json");
  expect(!wrongType.ok, "wrong partType loaded");
  if (wrongType.ok) throw new Error("unreachable");
  const typeMessage = wrongType.errors.map((error) => error.message).join("; ");
  expect(
    typeMessage.includes("partType other-type") &&
      typeMessage.includes("hobby-servo-3wire"),
    typeMessage
  );
  console.log(`reject hinge partType: ${typeMessage}`);

  writeFileSync(
    join(snapDir, "ok-hinge@1.0.0.json"),
    JSON.stringify(hingeFile("hobby-servo-3wire"))
  );
  writeFileSync(
    join(partDir, "ok-body@1.0.0.json"),
    JSON.stringify(snapshotBody("sfab/ok-body@1.0.0", "sfab/ok-hinge@1.0.0"))
  );
  writeFileSync(
    join(root, "ok-hinge.world.json"),
    JSON.stringify(partScene("sfab/ok-body@1.0.0"))
  );
  const hinged = planWorld(root, "ok-hinge.world.json");
  expect(
    hinged.ok,
    hinged.ok ? "" : hinged.errors.map((error) => error.message).join("; ")
  );
  if (!hinged.ok) throw new Error("unreachable");
  const snapRow = hinged.plan.report?.snapshots.find(
    (row) => row.path === "servo"
  );
  expect(snapRow?.axis === "body", `axis ${snapRow?.axis}`);
  expect(snapRow?.ref === "sfab/ok-hinge@1.0.0", `ref ${snapRow?.ref}`);
  const motor = hinged.plan.parts.find((part) => part.id === "servo")?.motor;
  expect(motor?.armature === 0.00037, `armature ${motor?.armature}`);
  console.log(
    `body snapshot ${snapRow?.ref} axis ${snapRow?.axis} quality ${snapRow?.quality} armature ${motor?.armature}`
  );
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

const snapPath = join(catalog, "snapshots/sfab/sg90-hinge@1.0.0.json");
const snap = JSON.parse(readFileSync(snapPath, "utf8")) as SnapshotFile;
expect(snap.quality === "Q2a", `quality ${snap.quality}`);
const hingeParams = snap.params as {
  armature: number;
  damping: number;
  frictionloss: number;
};
console.log(
  `hinge params armature ${hingeParams.armature} damping ${hingeParams.damping} frictionloss ${hingeParams.frictionloss}`
);
const toDeg = 180 / Math.PI;
if (snap.error === "none-available")
  throw new Error("hinge snapshot has no error rows");
for (const row of snap.error) {
  if (row.metric === "step-rise") {
    console.log(`step-rise ${(row.value * 1000).toFixed(3)} ms`);
  } else {
    console.log(`${row.metric} ${(row.value * toDeg).toFixed(4)} deg`);
  }
}
console.log(`quality ${snap.quality}`);

const captureFile = JSON.parse(
  readFileSync(join(catalog, "fixtures/capture.config.json"), "utf8")
) as {
  created: string;
  tool: { name: string; version: string };
  entries: { form?: string }[];
};
const hingeEntry = captureFile.entries.find((row) => row.form === "hinge@1");
expect(hingeEntry, "hinge capture entry");
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
) as { version: string; dependencies: Record<string, string> };
const againDir = mkdtempSync(join(tmpdir(), "sfab-hinge-again-"));
try {
  const againPath = join(againDir, "sg90-hinge@1.0.0.json");
  await writeHingeSnapshot({
    catalog,
    entry: hingeEntry as never,
    created: captureFile.created,
    tool: captureFile.tool,
    bench: {
      version: pkg.version,
      mujoco: pkg.dependencies["@mujoco/mujoco"] ?? "",
      avr8js: pkg.dependencies.avr8js ?? "",
    },
    outFile: againPath,
  });
  const again = readFileSync(againPath);
  expect(again.equals(readFileSync(snapPath)), "second capture differs");
  console.log("second capture byte-identical");
} finally {
  rmSync(againDir, { recursive: true, force: true });
}

function hingeFile(partType: string) {
  return {
    format: "sfab.snapshot@1",
    partType,
    part: "sfab/sg90@1.0.0",
    axis: "body",
    form: "hinge@1",
    ports: { inputs: ["shaft.torque"], outputs: ["shaft.angle"] },
    params: { armature: 0.00037, damping: 0.0025, frictionloss: 0.002 },
    envelope: {
      bounds: { "shaft.speed": [-1, 1], "shaft.torque": [-0.05, 0.05] },
    },
    error: "none-available",
    quality: "Q1",
    provenance: {
      source: "authored",
      bench: { version: "0.2.2" },
      created: "2026-09-27T00:00:00.000Z",
    },
  };
}

function snapshotBody(id: string, ref: string) {
  return {
    format: "sfab.part@1",
    id,
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
          default: "hinge",
          variants: {
            hinge: { kind: "snapshot", ref, omits: ["test"] },
          },
        },
      },
    },
  };
}

function partScene(part: string) {
  return {
    version: 2,
    environment: { ground: { plane: true }, gravity: [0, 0, -9.81] },
    run: { seed: 1, levels: { default: 1 } },
    root: { id: "scene", part: shell(part) },
  };
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
