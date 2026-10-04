/**
 * The SG90 run from its four sub-parts (layered-sim step 3). The arm
 * sweeps 10°, 90° and 120° three ways:
 *
 * - S: the whole-servo law (`position-servo@1`) on its lumped body.
 * - C: that law on the gear-train body's rigid collapse.
 * - G: the group. A `dc-motor@1` winding behind the train, a
 *   `potentiometer@1` on the output, and a `servo-control@1` bridge
 *   that reads the wiper.
 *
 * C and G share the joint terms and the motor law, so they agree within
 * the control's one-step sense lag. G against S is the gap a group
 * snapshot has to close (step 4). It is printed, not asserted.
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
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import type { RecordingRead, RunReport } from "@sfab-bench/contract";
import {
  BridgeDriver,
  BridgeMotor,
  DcWinding,
  Engine,
  resistor,
  vSource,
} from "@sfab-bench/engine-circuit";
import { sha256Bytes } from "@sfab-bench/parts";
import { Sim } from "@sfab-bench/sim/sim";
import { projectReal, readerFor, readInside } from "./world/files";
import { packageVersion } from "./world/package-version";
import { nodePlanEnv } from "./world/plan-host";

const armDir = fileURLToPath(
  new URL("../../../examples/arm/", import.meta.url)
);
const catalog = fileURLToPath(
  new URL("../catalog/parts/sfab/", import.meta.url)
);

const RUN_MS = 3000;
/** Output-referred K of the SG90 law, over the gear ratio. */
const RATIO = 82156 / 315;

type Run = {
  joint: number[];
  current: number[];
  report: RunReport | null;
  warnings: string[];
  levels: string[];
};

async function runWorld(project: string, world: string): Promise<Run> {
  const box: { report: RunReport | null } = { report: null };
  const sim = new Sim({
    post(message: { type: string; report?: RunReport }) {
      if (message.type === "state" && message.report)
        box.report = message.report;
    },
    now: () => performance.now(),
    schedule: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clear(handle: unknown) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
    sha256: sha256Bytes,
    versions: {
      mujoco: packageVersion("@mujoco/mujoco", import.meta.url),
      avr8js: packageVersion("avr8js", import.meta.url),
    },
    projectReal,
    readInside,
    readerFor,
    plan: nodePlanEnv,
    keepSerial: false,
  });
  try {
    const loaded = await sim.load({ project, world, generation: 1 });
    if (!loaded.ok) {
      throw new Error(loaded.errors.map((item) => item.message).join("; "));
    }
    await sim.step(RUN_MS);
    const state = sim.state();
    if (!state) throw new Error(`${world} has no state`);
    const body = sim.record({ op: "read", from: 0, to: state.simTime });
    if (body.op !== "read") throw new Error("no recording");
    const read = body.read as RecordingRead;
    const report = box.report;
    return {
      joint: read.frames.map(
        (frame) => ((frame.joints.arm?.shoulder ?? Number.NaN) * 180) / Math.PI
      ),
      current: read.frames.map(
        (frame) => frame.supplies.usb?.current ?? Number.NaN
      ),
      report,
      warnings: (report?.warnings ?? []).map((row) => row.code),
      levels: (report?.levels ?? []).map(
        (row) =>
          `${row.path} ${row.axis} ${row.class ?? "-"}/${row.variant ?? "-"} ${row.impl}${row.reason ? ` (${row.reason})` : ""}`
      ),
    };
  } finally {
    sim.dispose();
  }
}

function worst(a: number[], b: number[]): { delta: number; atMs: number } {
  let delta = 0;
  let atMs = -1;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = Math.abs((a[i] ?? Number.NaN) - (b[i] ?? Number.NaN));
    if (!Number.isFinite(d))
      return { delta: Number.POSITIVE_INFINITY, atMs: i * 10 };
    if (d > delta) {
      delta = d;
      atMs = i * 10;
    }
  }
  return { delta, atMs };
}

function part(
  name: string,
  type: string,
  axes: Record<string, unknown>
): string {
  return JSON.stringify({
    format: "sfab.part@1",
    id: `sfab/${name}@1.0.0`,
    type,
    foreign: false,
    axes,
  });
}

const none = (why: string) => ({
  "0": { default: "none", variants: { none: { kind: "none", omits: [why] } } },
});
const law = (form: string, params: Record<string, number>) => ({
  "1": {
    default: "law",
    variants: { law: { kind: "form", form, params, omits: ["fixture"] } },
  },
});

// The stamps. A bridge into a bare winding (`K/N` at `N·ω`) draws what
// the whole-servo bridge motor draws (`K` at `ω`): motoring, braking
// (back-EMF above the drive, the supply side opens), and reversed.
{
  const K = 0.458;
  const R = 7.1;
  const rail = () => [
    vSource("vs", "src", "0", { kind: "dc", value: 5 }),
    resistor("rs", "src", "vp", 0.5),
  ];
  for (const [ratio, omega] of [
    [0.6, 2],
    [0.6, 9],
    [-0.8, -3],
    [-0.3, 4],
  ] as const) {
    const lumped = new BridgeMotor("m", "vp", R, 0, K);
    lumped.s = ratio;
    lumped.omega = omega;
    const a = new Engine([...rail(), lumped], { method: "be", h: 1e-4 });
    a.operatingPoint();
    const driver = new BridgeDriver("d", "vp", "0", "a", "b", null);
    driver.s = ratio;
    driver.connected = true;
    const winding = new DcWinding("w", "a", "b", R, 0, K / RATIO);
    winding.omega = RATIO * omega;
    const b = new Engine([...rail(), driver, winding], {
      method: "be",
      h: 1e-4,
    });
    b.operatingPoint();
    const label = `s ${ratio} ω ${omega}`;
    const iA = a.branchCurrent("m");
    const iB = b.branchCurrent("w");
    const supplyA = a.branchCurrent("vs");
    const supplyB = b.branchCurrent("vs");
    console.log(
      `stamp ${label}: winding ${(iA * 1000).toFixed(3)} / ${(iB * 1000).toFixed(3)} mA, supply ${(supplyA * 1000).toFixed(3)} / ${(supplyB * 1000).toFixed(3)} mA`
    );
    expect(Math.abs(iA - iB) < 1e-9, `${label}: winding ${iA} vs ${iB}`);
    expect(
      Math.abs(supplyA - supplyB) < 1e-9,
      `${label}: supply ${supplyA} vs ${supplyB}`
    );
  }
}

const sg90 = JSON.parse(readFileSync(join(catalog, "sg90@1.0.0.json"), "utf8"));
const trainBody = sg90.axes.body["2"];
const servoLaw = sg90.axes.behaviour["1"].variants.datasheet.params as Record<
  string,
  number
>;

const dir = mkdtempSync(join(tmpdir(), "sfab-servo-group-"));
try {
  cpSync(armDir, dir, { recursive: true });
  const parts = join(dir, "parts/sfab");
  const put = (name: string, text: string) =>
    writeFileSync(join(parts, `${name}@1.0.0.json`), text);

  put(
    "grp-motor",
    part("grp-motor", "dc-motor-terminals", {
      behaviour: law("dc-motor@1", {
        K: (servoLaw.K ?? 0) / RATIO,
        R: servoLaw.R ?? 0,
        efficiency: servoLaw.efficiency ?? 0,
      }),
      body: none("rotor is in the gear train"),
      visual: none("fixture"),
    })
  );
  put(
    "grp-control",
    part("grp-control", "servo-control-ic", {
      behaviour: law("servo-control@1", {
        eSat: servoLaw.eSat ?? 0,
        // The law's quiescent less the pot's 1 mA.
        quiescent: (servoLaw.quiescent ?? 0) - 0.001,
        travel: Math.PI,
      }),
      body: none("fixture"),
      visual: none("fixture"),
    })
  );
  put(
    "grp-pot",
    part("grp-pot", "potentiometer", {
      behaviour: law("potentiometer@1", { R: 5000, travel: Math.PI }),
      body: none("fixture"),
      visual: none("fixture"),
    })
  );
  put(
    "grp-gears",
    part("grp-gears", "gear-train", {
      body: { "2": trainBody },
      visual: none("fixture"),
    })
  );
  const group = structuredClone(sg90);
  group.id = "sfab/grp-servo@1.0.0";
  const instances =
    group.axes.behaviour["2"].variants.netlist.netlist.instances;
  for (const [key, child] of Object.entries(instances) as [
    string,
    { part: string },
  ][]) {
    child.part = `sfab/grp-${key === "gears" ? "gears" : key}@1.0.0`;
  }
  put("grp-servo", JSON.stringify(group));

  const scene = JSON.parse(
    readFileSync(join(parts, "arm-scene@1.0.0.json"), "utf8")
  );
  scene.id = "sfab/grp-scene@1.0.0";
  scene.axes.behaviour["2"].variants.netlist.netlist.instances.servo.part =
    "sfab/grp-servo@1.0.0";
  put("grp-scene", JSON.stringify(scene));

  const bench = JSON.parse(
    readFileSync(join(parts, "arm-bench@1.0.0.json"), "utf8")
  );
  const world = (
    name: string,
    sceneId: string,
    levels: unknown,
    timestep: number
  ) => {
    const copy = structuredClone(bench);
    copy.id = `sfab/${name}@1.0.0`;
    copy.play.levels = levels;
    copy.play.timestep = timestep;
    copy.axes.behaviour["2"].variants.netlist.netlist.instances.scene.part =
      sceneId;
    put(name, JSON.stringify(copy));
    return `parts/sfab/${name}@1.0.0.json`;
  };
  const worlds = (timestep: number) => {
    const us = Math.round(timestep * 1e6);
    return {
      s: world(
        `grp-s-${us}us`,
        "sfab/arm-scene@1.0.0",
        { default: 1 },
        timestep
      ),
      c: world(
        `grp-c-${us}us`,
        "sfab/arm-scene@1.0.0",
        { default: 1, paths: { servo: { body: 2 } } },
        timestep
      ),
      g: world(
        `grp-g-${us}us`,
        "sfab/grp-scene@1.0.0",
        {
          default: 1,
          paths: { servo: { behaviour: 2 }, "servo.gears": { body: 2 } },
        },
        timestep
      ),
    };
  };

  const coarse = worlds(0.001);
  const s = await runWorld(dir, coarse.s);
  const c = await runWorld(dir, coarse.c);
  const g = await runWorld(dir, coarse.g);
  for (const [label, run] of [
    ["S", s],
    ["C", c],
    ["G", g],
  ] as const) {
    const at = (ms: number) => run.joint[ms / 10]?.toFixed(3);
    console.log(
      `${label} joint @1s ${at(990)}° @2s ${at(1990)}° @3s ${at(2990)}°; warnings ${run.warnings.join(",") || "none"}`
    );
  }
  for (const row of [
    "servo behaviour 1/datasheet form position-servo@1",
    "servo body 1/lumped lumped",
  ]) {
    expect(
      s.levels.some((line) => line.startsWith(row)),
      `S has ${row}`
    );
  }
  expect(
    c.levels.some((line) => line.startsWith("servo body 2/gear-train")),
    "C runs the gear-train body"
  );
  for (const row of [
    "servo behaviour 2/netlist composite",
    "servo.motor behaviour 1/law form dc-motor@1",
    "servo.pot behaviour 1/law form potentiometer@1",
    "servo.control behaviour 1/law form servo-control@1",
    "servo.gears body 2/gear-train gear-train",
  ]) {
    expect(
      g.levels.some((line) => line.startsWith(row)),
      `G has ${row}`
    );
  }
  expect(
    JSON.stringify(g.warnings) === JSON.stringify(s.warnings),
    `G warnings ${g.warnings.join(",")} vs S ${s.warnings.join(",")}`
  );
  expect(
    (g.report?.degraded ?? []).length === 0,
    `G degraded: ${(g.report?.degraded ?? []).map((row) => row.message).join(" | ")}`
  );
  for (const [deg, ms] of [
    [10, 990],
    [90, 1990],
    [120, 2990],
  ] as const) {
    const got = g.joint[ms / 10] ?? Number.NaN;
    expect(Math.abs(got - deg) < 0.5, `G holds ${deg}° at ${ms} ms: ${got}`);
  }

  // G reads its wiper one master step late. The gap with C is that lag:
  // first order in the step, so it halves when the step halves.
  const gc = worst(g.joint, c.joint);
  const gcI = worst(g.current, c.current);
  const fine = worlds(0.0005);
  const gcFine = worst(
    (await runWorld(dir, fine.g)).joint,
    (await runWorld(dir, fine.c)).joint
  );
  const order = gcFine.delta / gc.delta;
  console.log(
    `G vs C: joint max|Δ| ${gc.delta.toFixed(3)}° at ${gc.atMs} ms (1 ms step), ${gcFine.delta.toFixed(3)}° at ${gcFine.atMs} ms (0.5 ms), ratio ${order.toFixed(3)}; usb current max|Δ| ${(gcI.delta * 1000).toFixed(2)} mA`
  );
  expect(gc.delta < 0.4, `G vs C joint ${gc.delta}° at ${gc.atMs} ms`);
  expect(
    order > 0.4 && order < 0.6,
    `G vs C does not halve with the step: ratio ${order}`
  );

  // The group snapshot's target (step 4). Recorded, not asserted.
  const gs = worst(g.joint, s.joint);
  const gsI = worst(g.current, s.current);
  console.log(
    `G vs S: joint max|Δ| ${gs.delta.toFixed(3)}° at ${gs.atMs} ms; usb current max|Δ| ${(gsI.delta * 1000).toFixed(2)} mA at ${gsI.atMs} ms`
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
