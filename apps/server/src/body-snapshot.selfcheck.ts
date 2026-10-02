/**
 * Body axis: the SG90 gear train collapses onto one hinge, and a
 * hinge form on the behaviour axis is rejected.
 */

import { ok as expect } from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  GearTrain,
  RecordedFrame,
  RecordingRead,
  RunReport,
  SnapshotFile,
  WorldState,
} from "@sfab-bench/contract";

import { collapse, reflection } from "@sfab-bench/engine-body";
import { applyLevelEdit } from "@sfab-bench/parts";
import { levelCard } from "../../web/src/lib/level-card";
import { closeRootWatches } from "./projects";
import { writeHingeSnapshot } from "./world/body/hinge-capture";
import { attachWorld, readRecording, stopWorld } from "./world/host";
import { catalogRoot, planWorld } from "./world/plan";

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
const SKETCH_MS = 3000;

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

const root = mkdtempSync(join(tmpdir(), "sfab-hinge-"));
try {
  const partDir = join(root, "parts", "sfab");
  mkdirSync(partDir, { recursive: true });
  writeFileSync(
    join(partDir, "idle-train@1.0.0.json"),
    JSON.stringify(idleTrainPart())
  );
  writeFileSync(
    join(root, "idle-train.world.json"),
    JSON.stringify(partScene("sfab/idle-train@1.0.0"))
  );
  const idle = planWorld(root, "idle-train.world.json");
  expect(idle.ok, "unreached shaft did not run");
  if (!idle.ok) throw new Error("unreachable");
  const idleHit = (idle.plan.degraded ?? []).find(
    (row) => row.message.includes("idle") && row.message.includes("not reached")
  );
  expect(idleHit, "no unreached-shaft diagnostic");
  console.log(`degraded ${idleHit.path}: ${idleHit.message}`);

  writeFileSync(
    join(partDir, "bad-servo@1.0.0.json"),
    JSON.stringify(badServo("hinge@1"))
  );
  writeFileSync(
    join(root, "hinge-behaviour.world.json"),
    JSON.stringify(scene())
  );
  const planned = planWorld(root, "hinge-behaviour.world.json");
  expect(planned.ok, "hinge@1 on behaviour did not run");
  if (!planned.ok) throw new Error("unreachable");
  const hingeHit = (planned.plan.degraded ?? []).find((row) =>
    row.message.includes("hinge@1 is a body-axis form")
  );
  expect(hingeHit, "no hinge behaviour diagnostic");
  console.log(`degraded ${hingeHit.path}: ${hingeHit.message}`);

  writeFileSync(
    join(root, "missing-variant.world.json"),
    JSON.stringify(sg90Scene("no-such"))
  );
  const missing = planWorld(root, "missing-variant.world.json");
  expect(missing.ok, "missing variant did not run");
  if (!missing.ok) throw new Error("unreachable");
  const missingHit = (missing.plan.degraded ?? []).find(
    (row) => row.path === "servo" && row.message.includes("variant no-such")
  );
  expect(missingHit, "no missing-variant diagnostic");
  console.log(`degraded ${missingHit.path}: ${missingHit.message}`);

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
  expect(wrongType.ok, "wrong partType did not run");
  if (!wrongType.ok) throw new Error("unreachable");
  const typeHit = (wrongType.plan.degraded ?? []).find(
    (row) =>
      row.message.includes("partType other-type") &&
      row.message.includes("hobby-servo-3wire")
  );
  expect(typeHit, "no partType diagnostic");
  console.log(`degraded ${typeHit.path}: ${typeHit.message}`);

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
const speedBox = snap.envelope.bounds["shaft.speed"];
const torqueBox = snap.envelope.bounds["shaft.torque"];
console.log(
  `covered box shaft.speed ${speedBox?.[0]}..${speedBox?.[1]} rad/s, shaft.torque ${torqueBox?.[0]}..${torqueBox?.[1]} N·m`
);

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

const nanoSrc = fileURLToPath(
  new URL("../../../examples/nano/", import.meta.url)
);
const e10Dir = mkdtempSync(join(tmpdir(), "sfab-e10-"));
try {
  cpSync(nanoSrc, e10Dir, { recursive: true });
  const collapsedPlan = planWorld(
    e10Dir,
    "parts/sfab/nano-servo-collapsed@1.0.0.json"
  );
  expect(
    collapsedPlan.ok,
    collapsedPlan.ok
      ? ""
      : collapsedPlan.errors.map((error) => error.message).join("; ")
  );
  if (!collapsedPlan.ok) throw new Error("unreachable");
  const card = levelCard(collapsedPlan.plan.report ?? null, "servo");
  expect(
    card?.snapshot?.ref === "body sfab/sg90-hinge@1.0.0" &&
      card.snapshot.quality === "Q2a",
    `card ${card?.snapshot?.ref} ${card?.snapshot?.quality}`
  );
  console.log(
    `inspector body row: ${card?.snapshot?.ref} · ${card?.snapshot?.quality}`
  );

  const fitted = await runSketch(
    e10Dir,
    "parts/sfab/nano-servo-usb@1.0.0.json"
  );
  const collapsed = await runSketch(
    e10Dir,
    "parts/sfab/nano-servo-collapsed@1.0.0.json"
  );
  const repeat = await runSketch(
    e10Dir,
    "parts/sfab/nano-servo-collapsed@1.0.0.json"
  );
  expect(
    JSON.stringify(collapsed.read.frames) ===
      JSON.stringify(repeat.read.frames),
    "collapsed repeat differs"
  );
  console.log("E10 collapsed repeat byte-identical");

  const fittedSweep = firstSweep(fitted.read.frames);
  const collapsedSweep = firstSweep(collapsed.read.frames);
  const fittedRise = riseMs(fittedSweep);
  const collapsedRise = riseMs(collapsedSweep);
  console.log(
    `E10 flag 10–90% rise fitted ${msText(fittedRise)} ms, collapsed ${msText(collapsedRise)} ms, linear between 10 ms frames`
  );
  const collapsedWarnings = collapsed.report?.warnings ?? [];
  expect(
    collapsedWarnings.length === 0,
    `collapsed envelope warning ${collapsedWarnings.map((row) => row.message).join(" | ")}`
  );
  const angleDelta = maxAbsDelta(fittedSweep.angle, collapsedSweep.angle);
  console.log(
    `E10 max-abs angle Δ ${((angleDelta * 180) / Math.PI).toFixed(4)} deg`
  );
  console.log(
    `E10 peak supply fitted ${ma(fittedSweep.frames)} mA, collapsed ${ma(collapsedSweep.frames)} mA`
  );
  console.log(
    `E10 5V min fitted ${volts(fittedSweep.frames)} V, collapsed ${volts(collapsedSweep.frames)} V`
  );
  console.log(
    `E10 brownout fitted ${brownout(fittedSweep.frames)}, collapsed ${brownout(collapsedSweep.frames)}`
  );
  console.log(
    `E10 warnings fitted ${warnText(fitted.report)}, collapsed ${warnText(collapsed.report)}`
  );

  const trainWorld = JSON.parse(
    readFileSync(
      join(e10Dir, "parts/sfab/nano-servo-collapsed@1.0.0.json"),
      "utf8"
    )
  ) as {
    run?: { levels: { paths: { servo: { body: unknown } } } };
    play?: { levels: { paths: { servo: { body: unknown } } } };
  };
  const trainLevels = trainWorld.play?.levels ?? trainWorld.run?.levels;
  if (!trainLevels) throw new Error("collapsed servo has no levels");
  trainLevels.paths.servo.body = 2;
  writeFileSync(
    join(e10Dir, "nano-servo-train.world.json"),
    JSON.stringify(trainWorld)
  );
  const train = await runSketch(e10Dir, "nano-servo-train.world.json");
  const jointDelta = maxAbsDelta(
    flagAngles(collapsed.read.frames),
    flagAngles(train.read.frames)
  );
  expect(jointDelta === 0, `class 2 vs collapsed joint trace Δ ${jointDelta}`);
  console.log(`class 2 vs collapsed joint trace Δ ${jointDelta}`);
} finally {
  rmSync(e10Dir, { recursive: true, force: true });
  closeRootWatches();
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

function idleTrainPart() {
  return {
    format: "sfab.part@1",
    id: "sfab/idle-train@1.0.0",
    type: "hobby-servo-3wire",
    axes: {
      behaviour: {
        "1": {
          default: "law",
          variants: {
            law: {
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
        "2": {
          default: "gear-train",
          variants: {
            "gear-train": {
              kind: "gear-train",
              input: TRAIN.input,
              output: TRAIN.output,
              shafts: [
                ...TRAIN.shafts,
                { name: "idle", inertia: 1e-9, damping: 0, frictionloss: 0 },
              ],
              meshes: TRAIN.meshes,
              omits: ["unreached shaft"],
            },
          },
        },
      },
    },
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

async function runSketch(
  project: string,
  world: string
): Promise<{ read: RecordingRead; report: RunReport | null }> {
  const planned = planWorld(project, world);
  if (!planned.ok) {
    throw new Error(planned.errors.map((error) => error.message).join("; "));
  }
  const seen: {
    state: WorldState | null;
    failed: string | null;
    report: RunReport | null;
  } = { state: null, failed: null, report: planned.plan.report ?? null };
  const attached = await attachWorld(project, world, {
    sender: { kind: "loopback", label: "Mac" },
    onEvent(event) {
      if (event.type === "error") {
        seen.failed =
          event.message ?? event.errors.map((item) => item.message).join("; ");
      }
      if (event.type === "state") {
        seen.state = event.state;
        if (event.report) seen.report = event.report;
      }
    },
  });
  if ("error" in attached) throw new Error(attached.error);
  try {
    attached.step(SKETCH_MS);
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (seen.failed) throw new Error(seen.failed);
      if ((seen.state?.simTime ?? -1) >= SKETCH_MS / 1000 - 1e-3) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const state = seen.state;
    if (!state || state.simTime < SKETCH_MS / 1000 - 1e-3) {
      throw new Error(
        `${world} timed out at ${state ? state.simTime : "no state"} s`
      );
    }
    const read = await readRecording(project, world, {
      from: 0,
      to: SKETCH_MS / 1000,
    });
    if ("error" in read) throw new Error(read.error);
    return { read, report: seen.report };
  } finally {
    attached.detach();
    await stopWorld(project, world);
  }
}

function flagAngles(frames: RecordedFrame[]): number[] {
  return frames.map((frame) => frame.joints.flag?.hinge ?? Number.NaN);
}

function firstSweep(frames: RecordedFrame[]): {
  frames: RecordedFrame[];
  angle: number[];
  t: number[];
} {
  let initial = -1;
  for (let i = 0; i < frames.length; i++) {
    if (frames[i]?.parts.servo?.commandDeg != null) {
      initial = i;
      break;
    }
  }
  const first = frames[initial]?.parts.servo?.commandDeg;
  if (initial < 0 || first == null) {
    throw new Error("the sketch never commanded the servo");
  }
  let start = -1;
  for (let i = initial + 1; i < frames.length; i++) {
    const command = frames[i]?.parts.servo?.commandDeg;
    if (command != null && Math.abs(command - first) > 5) {
      start = i;
      break;
    }
  }
  const target = frames[start]?.parts.servo?.commandDeg;
  if (start < 0 || target == null) {
    throw new Error("the sketch has no second target");
  }
  let end = frames.length;
  for (let i = start + 1; i < frames.length; i++) {
    const command = frames[i]?.parts.servo?.commandDeg;
    if (command != null && Math.abs(command - target) > 5) {
      end = i;
      break;
    }
  }
  const slice = frames.slice(start, end);
  return {
    frames: slice,
    angle: slice.map((frame) => frame.joints.flag?.hinge ?? Number.NaN),
    t: slice.map((frame) => frame.t),
  };
}

function riseMs(sweep: { angle: number[]; t: number[] }): number | null {
  const { angle, t } = sweep;
  if (angle.length < 2) return null;
  const a0 = angle[0] ?? 0;
  const a1 = angle[angle.length - 1] ?? a0;
  const span = a1 - a0;
  if (Math.abs(span) < 1e-6) return null;
  const lo = a0 + 0.1 * span;
  const hi = a0 + 0.9 * span;
  let tLo: number | null = null;
  let tHi: number | null = null;
  for (let i = 1; i < angle.length; i++) {
    const prev = angle[i - 1] ?? 0;
    const cur = angle[i] ?? prev;
    if (tLo === null && crossed(prev, cur, lo, span)) {
      tLo = lerpTime(t[i - 1] ?? 0, t[i] ?? 0, prev, cur, lo);
    }
    if (tHi === null && crossed(prev, cur, hi, span)) {
      tHi = lerpTime(t[i - 1] ?? 0, t[i] ?? 0, prev, cur, hi);
    }
  }
  if (tLo === null || tHi === null) return null;
  return (tHi - tLo) * 1000;
}

function crossed(
  prev: number,
  cur: number,
  target: number,
  span: number
): boolean {
  return span > 0
    ? prev < target && cur >= target
    : prev > target && cur <= target;
}

function lerpTime(
  t0: number,
  t1: number,
  a0: number,
  a1: number,
  level: number
): number {
  const span = a1 - a0;
  const frac = span === 0 ? 0 : (level - a0) / span;
  return t0 + frac * (t1 - t0);
}

function msText(value: number | null): string {
  return value === null ? "unavailable" : value.toFixed(1);
}

function maxAbsDelta(left: number[], right: number[]): number {
  const n = Math.max(left.length, right.length);
  let worst = 0;
  for (let i = 0; i < n; i++) {
    const a = left[i];
    const b = right[i];
    if (a === undefined || b === undefined) return Number.POSITIVE_INFINITY;
    worst = Math.max(worst, Math.abs(a - b));
  }
  return worst;
}

function ma(frames: RecordedFrame[]): string {
  let peak = 0;
  for (const frame of frames) {
    peak = Math.max(peak, frame.supplies.usb?.maxCurrent ?? 0);
  }
  return (peak * 1000).toFixed(1);
}

function volts(frames: RecordedFrame[]): string {
  let low = Number.POSITIVE_INFINITY;
  for (const frame of frames) {
    low = Math.min(low, frame.boards.nano?.minVoltage ?? low);
  }
  return Number.isFinite(low) ? low.toFixed(3) : "unavailable";
}

function brownout(frames: RecordedFrame[]): string {
  return frames.some((frame) => frame.boards.nano?.brownoutAny === true)
    ? "yes"
    : "none";
}

function warnText(report: RunReport | null): string {
  const lines = report?.warnings.map((row) => row.message) ?? [];
  return lines.length > 0 ? lines.join(" | ") : "none";
}
