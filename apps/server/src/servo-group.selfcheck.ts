/**
 * The SG90 run from its four sub-parts (layered-sim step 3). The arm
 * sweeps 10°, 90° and 120° three ways:
 *
 * - S: the whole-servo law (`position-servo@1`) on its lumped body. Its
 *   class-1 default is `group`, the snapshot captured from G.
 * - C: that law on the gear-train body's rigid collapse.
 * - G: the catalog SG90 at behaviour class 2, its four children. A
 *   `dc-motor@1` winding behind the `gears` train, a `potentiometer@1`
 *   on the output, and a `servo-control@1` bridge that reads the wiper.
 *
 * C and G share the joint terms and the motor law, so they agree within
 * the control's one-step sense lag. That gap is the snapshot's stated
 * error. G against S adds the lumped body's fitted armature; it is
 * printed, not asserted.
 */

import { deepStrictEqual, ok as expect } from "node:assert/strict";
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
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import type { RecordingRead, RunReport } from "@sfab-bench/contract";
import { collapse } from "@sfab-bench/engine-body";
import {
  BridgeDriver,
  BridgeMotor,
  DcWinding,
  Engine,
  resistor,
  vSource,
} from "@sfab-bench/engine-circuit";
import { sha256Bytes } from "@sfab-bench/parts";
import { planWorld } from "@sfab-bench/sim";
import { Sim } from "@sfab-bench/sim/sim";
import { captureFromConfig } from "./capture";
import { projectReal, readerFor, readInside } from "./world/files";
import { packageVersion } from "./world/package-version";
import { catalogRoot, nodePlanEnv } from "./world/plan-host";

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
  /** The servo's own row: V+ current, V+ against GND, shaft torque. */
  part: { current: number; voltage: number; torque: number }[];
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
      part: read.frames.map((frame) => {
        const row = frame.parts.servo;
        return {
          current: row?.current ?? Number.NaN,
          voltage: row?.voltage ?? Number.NaN,
          torque: row?.torqueNm ?? Number.NaN,
        };
      }),
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

// The gears child carries the servo's class-2 train: one collapse.
{
  const read = (name: string) =>
    JSON.parse(readFileSync(join(catalog, `${name}@1.0.0.json`), "utf8"));
  const onServo = collapse(read("sg90").axes.body["2"].variants["gear-train"]);
  const onGears = collapse(
    read("sg90-gears").axes.body["1"].variants["gear-train"]
  );
  deepStrictEqual(onGears, onServo);
  console.log(
    `collapse: gears child = servo class 2, ratio ${onServo.ratio.toFixed(4)}, armature ${onServo.armature.toExponential(4)} kg·m²`
  );
}

const dir = mkdtempSync(join(tmpdir(), "sfab-servo-group-"));
try {
  cpSync(armDir, dir, { recursive: true });
  const parts = join(dir, "parts/sfab");
  const bench = JSON.parse(
    readFileSync(join(parts, "arm-bench@1.0.0.json"), "utf8")
  );
  const world = (name: string, levels: unknown, timestep: number) => {
    const copy = structuredClone(bench);
    copy.id = `sfab/${name}@1.0.0`;
    copy.play.levels = levels;
    copy.play.timestep = timestep;
    writeFileSync(join(parts, `${name}@1.0.0.json`), JSON.stringify(copy));
    return `parts/sfab/${name}@1.0.0.json`;
  };
  const worlds = (timestep: number) => {
    const us = Math.round(timestep * 1e6);
    return {
      s: world(`grp-s-${us}us`, { default: 1 }, timestep),
      c: world(
        `grp-c-${us}us`,
        { default: 1, paths: { servo: { body: 2 } } },
        timestep
      ),
      g: world(
        `grp-g-${us}us`,
        { default: 1, paths: { servo: { behaviour: 2 } } },
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
    "servo behaviour 1/group snapshot sfab/sg90-servo@1.0.0",
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
    "servo.control behaviour 1/model form servo-control@1",
    "servo.gears body 1/gear-train gear-train",
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

  // G records the servo's row at its own ports, as C does: the current
  // its parts draw from V+, V+ against GND, and the shaft torque. Held
  // still, G draws the pot's V/R where the law draws a fixed 1 mA.
  const part = (run: Run, key: "current" | "voltage" | "torque") =>
    run.part.map((row) => row[key]);
  const partI = worst(part(g, "current"), part(c, "current"));
  const partV = worst(part(g, "voltage"), part(c, "voltage"));
  const partT = worst(part(g, "torque"), part(c, "torque"));
  console.log(
    `G vs C at the servo's ports: V+ current max|Δ| ${(partI.delta * 1000).toFixed(2)} mA at ${partI.atMs} ms, V+ ${(partV.delta * 1000).toFixed(2)} mV, torque ${(partT.delta * 1000).toFixed(2)} mN·m`
  );
  expect(partI.delta < 0.02, `G vs C V+ current ${partI.delta} A`);
  expect(partV.delta < 0.02, `G vs C V+ ${partV.delta} V`);
  for (const ms of [990, 1990, 2990]) {
    const i = ms / 10;
    const held = Math.abs(
      (g.part[i]?.current ?? Number.NaN) - (c.part[i]?.current ?? Number.NaN)
    );
    expect(held < 1e-4, `G vs C held current at ${ms} ms: ${held} A`);
  }

  // The lumped body's armature is fitted to the datasheet speed, not to
  // the train. Recorded, not asserted: a bench measurement decides it.
  const gs = worst(g.joint, s.joint);
  const gsI = worst(g.current, s.current);
  console.log(
    `G vs S: joint max|Δ| ${gs.delta.toFixed(3)}° at ${gs.atMs} ms; usb current max|Δ| ${(gsI.delta * 1000).toFixed(2)} mA at ${gsI.atMs} ms`
  );

  // The class-1 default is the snapshot captured from G. Its params are
  // the authored law's, reduced from the four children, so it runs bit
  // for bit as `datasheet`. Its stated error is G vs C at the servo's
  // ports, and a second capture writes the same bytes.
  const snapFile = join(catalogRoot(), "snapshots/sfab/sg90-servo@1.0.0.json");
  const snap = JSON.parse(readFileSync(snapFile, "utf8")) as {
    params: Record<string, number>;
    error: { metric: string; quantity: string; value: number }[];
  };
  const stated = (metric: string, quantity: string) =>
    snap.error.find((row) => row.metric === metric && row.quantity === quantity)
      ?.value ?? Number.NaN;
  const d = await runWorld(
    dir,
    world(
      "grp-d-1000us",
      {
        default: 1,
        paths: { servo: { behaviour: { class: 1, variant: "datasheet" } } },
      },
      0.001
    )
  );
  deepStrictEqual(s.joint, d.joint);
  deepStrictEqual(s.current, d.current);
  deepStrictEqual(s.part, d.part);
  const row = s.report?.snapshots.find(
    (item) => item.ref === "sfab/sg90-servo@1.0.0"
  );
  expect(
    row?.quality === "Q2a" && !row.stale,
    `S snapshot row ${JSON.stringify(row)}`
  );
  const angleErr = Math.abs(
    stated("free-run-max-abs", "shaft.angle") - (gc.delta * Math.PI) / 180
  );
  const currentErr = Math.abs(
    stated("free-run-max-abs", "V+.current") - partI.delta
  );
  expect(angleErr < 1e-8, `stated angle error off by ${angleErr} rad`);
  expect(currentErr < 1e-8, `stated current error off by ${currentErr} A`);
  const config = JSON.parse(
    readFileSync(join(catalogRoot(), "fixtures/capture.config.json"), "utf8")
  ) as { entries: { id: string }[] };
  const entry = config.entries.find(
    (item) => item.id === "sfab/sg90-servo@1.0.0"
  );
  expect(entry, "group capture entry");
  const againDir = mkdtempSync(join(tmpdir(), "sfab-group-again-"));
  try {
    const again = join(againDir, "sg90-servo@1.0.0.json");
    await captureFromConfig({
      config: { ...config, entries: [entry] } as never,
      outFile: again,
    });
    expect(
      readFileSync(again).equals(readFileSync(snapFile)),
      "second group capture differs"
    );
  } finally {
    rmSync(againDir, { recursive: true, force: true });
  }
  console.log(
    `group snapshot: ${Object.entries(snap.params)
      .map(([key, value]) => `${key} ${value}`)
      .join(
        ", "
      )}; runs as datasheet bit for bit; states shaft.angle ${stated("free-run-max-abs", "shaft.angle")} rad, V+.current ${stated("free-run-max-abs", "V+.current")} A; second capture byte-identical`
  );

  // A child edit, or an edit of the servo's own body (the snapshot side
  // runs it), makes the capture stale. A snapshot on the wrong axis, or of
  // another part type, does not run as the law.
  const sWorld = coarse.s;
  const report = () => {
    const planned = planWorld(dir, sWorld, nodePlanEnv);
    if (!planned.ok) {
      throw new Error(planned.errors.map((item) => item.message).join("; "));
    }
    return planned.plan;
  };
  const potFile = join(parts, "sg90-pot@1.0.0.json");
  const pot = readFileSync(join(catalog, "sg90-pot@1.0.0.json"), "utf8");
  writeFileSync(potFile, pot.replace('"R": 5000', '"R": 5100'));
  const stale = report().report;
  expect(
    stale?.snapshots.find((item) => item.ref === "sfab/sg90-servo@1.0.0")
      ?.stale === true &&
      stale.warnings.some((item) => item.code === "stale-capture"),
    "a pot edit leaves the group capture fresh"
  );
  rmSync(potFile);
  const servoFile = join(parts, "sg90@1.0.0.json");
  const servo = JSON.parse(
    readFileSync(join(catalog, "sg90@1.0.0.json"), "utf8")
  );
  servo.axes.body["2"].variants["gear-train"].shafts[0].inertia *= 2;
  writeFileSync(servoFile, JSON.stringify(servo));
  expect(
    report().report?.snapshots.find(
      (item) => item.ref === "sfab/sg90-servo@1.0.0"
    )?.stale === true,
    "a body edit leaves the group capture fresh"
  );
  rmSync(servoFile);
  mkdirSync(join(dir, "snapshots/sfab"), { recursive: true });
  const local = join(dir, "snapshots/sfab/sg90-servo@1.0.0.json");
  const text = readFileSync(snapFile, "utf8");
  for (const [label, edited, detail] of [
    [
      "axis",
      readFileSync(
        join(catalogRoot(), "snapshots/sfab/sg90-hinge@1.0.0.json"),
        "utf8"
      ),
      "sfab/sg90-servo@1.0.0 is a body snapshot",
    ],
    [
      "partType",
      text.replace(
        '"partType": "hobby-servo-3wire"',
        '"partType": "potentiometer"'
      ),
      "partType potentiometer is not hobby-servo-3wire",
    ],
  ] as const) {
    writeFileSync(local, edited);
    const plan = report();
    const said = [
      ...(plan.report?.errors ?? []),
      ...(plan.report?.warnings ?? []),
      ...(plan.degraded ?? []),
    ].map((item) => item.message);
    expect(
      said.some((message) => message.includes(detail)) &&
        !plan.parts.some((item) => item.id === "servo"),
      `wrong ${label}: ${said.join(" | ")}`
    );
  }

  // A tagged SI param is a param. The run checks the part's own current
  // against the envelope: the arm sweep on the lumped body stays inside
  // it, a tighter bound warns once and the run goes on.
  writeFileSync(
    local,
    text.replace(
      '"quiescent": 0.01',
      '"quiescent": { "v": 0.01, "q": "Current", "d": { "A": 1 } }'
    )
  );
  const tagged = report().parts.find((item) => item.id === "servo");
  expect(
    tagged?.motor?.quiescent === 0.01,
    `tagged quiescent ran as ${tagged?.motor?.quiescent}`
  );
  expect(!s.warnings.includes("envelope"), "the arm sweep left the envelope");
  writeFileSync(
    local,
    text.replace(
      /"V\+\.current": \[\s*(-?[0-9.e-]+),\s*[0-9.e-]+\s*\]/,
      '"V+.current": [$1, 0.3]'
    )
  );
  const tight = await runWorld(dir, sWorld);
  const envelope = tight.report?.warnings.filter(
    (item) => item.code === "envelope"
  );
  expect(
    envelope?.length === 1 &&
      envelope[0]?.port === "V+" &&
      envelope[0]?.quantity === "Current" &&
      tight.joint.length === s.joint.length,
    `tight envelope: ${JSON.stringify(envelope)}`
  );
  rmSync(local);
  console.log(
    `group snapshot: stale on a child or body edit; wrong axis and part type refused; tagged param runs; ${envelope?.[0]?.message}`
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
