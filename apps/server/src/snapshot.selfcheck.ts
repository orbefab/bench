/**
 * Nano USB snapshot: lint, capture, fit, free-run, selection, report.
 * Ported from layered-sim E4 (fd10742).
 */
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
  PartTypeFile,
  RunReport,
  SnapshotFile,
  WorldState,
} from "@sfab-bench/contract";

import { captureNanoUsb, compareMg90sFreeRun } from "./capture";
import { closeRootWatches } from "./projects";
import { boardStampOf } from "./world/circuit-stamp";
import { attachWorld, stopWorld } from "./world/host";
import { canonicalJson } from "./world/parts/si";
import { catalogRoot, planWorld } from "./world/plan";
import { NANO_BOARD_A } from "./world/power-path";
import { createRailCircuit } from "./world/rail-circuit";
import { envelopeOf, outsideEnvelope, tableLawOf } from "./world/snapshot-law";
import { lintSnapshot } from "./world/snapshot-lint";
import { loadSnapshot } from "./world/snapshot-load";

const SNAPSHOT_ID = "sfab/nano-usb-5v@1.0.0";
const NANO_STAMP = boardStampOf("sfab/nano-ch340@1.0.0", "circuits", {
  boardId: "nano",
});
const nanoDir = fileURLToPath(
  new URL("../../../examples/nano/", import.meta.url)
);
const armDir = fileURLToPath(
  new URL("../../../examples/arm/", import.meta.url)
);

function expect(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

function snapFile(): string {
  return join(catalogRoot(), "snapshots", "sfab", "nano-usb-5v@1.0.0.json");
}

function nanoType(): PartTypeFile {
  return JSON.parse(
    readFileSync(join(catalogRoot(), "types", "arduino-nano.json"), "utf8")
  ) as PartTypeFile;
}

function lint(snap: SnapshotFile) {
  return lintSnapshot(snap, {
    plausible: nanoType().plausible,
    ports: nanoType().ports,
  });
}

function mustFail(snap: SnapshotFile, needle: string, label: string): void {
  const result = lint(snap);
  const text = result.diagnostics.map((diag) => diag.message).join("\n");
  expect(result.diagnostics.length > 0, `${label} was accepted`);
  expect(text.includes(needle), `${label} missed ${needle}: ${text}`);
}

const before = readFileSync(snapFile(), "utf8");
const stats = await captureNanoUsb();
const after = readFileSync(snapFile(), "utf8");
expect(before === after, "capture did not reproduce the committed snapshot");
console.log("capture reproducible: byte-identical");

const committed = JSON.parse(after) as SnapshotFile;
const clean = lint(committed);
expect(
  clean.diagnostics.length === 0,
  clean.diagnostics.map((d) => d.message).join("; ")
);
expect(clean.quality === "Q2a", `linter granted ${clean.quality}`);
const env = envelopeOf(committed);
expect(env !== null, "snapshot envelope");
expect(
  env !== null && !outsideEnvelope(env, 5, env.current[1]),
  "current bound is outside itself"
);
expect(
  env !== null && outsideEnvelope(env, 5, 0.9),
  "stock 0.9 A limit is not outside the 0.89 A current bound"
);
console.log(
  "envelope unit: 0.89 A inside, 0.9 A outside; the stock port limit can cross the bound"
);
overLimit(committed);
const loaded = loadSnapshot(
  tmpdir(),
  { catalogDir: catalogRoot(), assetRoot: tmpdir() },
  SNAPSHOT_ID,
  nanoType()
);
expect(
  loaded.diagnostics.length === 0,
  "loader rejected the committed snapshot"
);
expect(loaded.loaded?.quality === "Q2a", "loader quality is not Q2a");
console.log("lint: committed snapshot Q2a");

{
  const copy = structuredClone(committed);
  delete (copy as { provenance?: unknown }).provenance;
  mustFail(copy, "missing provenance", "no provenance");
}
{
  const copy = structuredClone(committed);
  copy.envelope.bounds["5V.current"] = [0, 2];
  mustFail(copy, "table does not cover its envelope", "wide envelope");
}
{
  const copy = structuredClone(committed);
  copy.quality = "Q3";
  mustFail(
    copy,
    "quality claim Q3 is above the linter grant Q2a",
    "quality claim"
  );
}
{
  const copy = structuredClone(committed);
  const axis = [...(copy.params.iAxis as number[])];
  axis[5] = 500;
  copy.params.iAxis = axis;
  mustFail(copy, "outside the plausible range", "mA written as A");
  const text = lint(copy)
    .diagnostics.map((diag) => diag.message)
    .join("\n");
  expect(text.includes("500000 mA"), `mA scale note missing: ${text}`);
}
{
  const copy = structuredClone(committed);
  copy.params.supplyAffine = 0;
  copy.params.supplyRef = 0;
  copy.envelope.bounds["supply.voltage"] = [0, 0];
  const volts = [...(copy.params.vAxis as number[])];
  volts[0] = 1;
  copy.params.vAxis = volts;
  mustFail(copy, "non-physical output at a 0 V setpoint", "0 V setpoint");
}
console.log("lint: broken copies rejected");

expect(stats.staticMaxAbsMv <= 10, `fit ${stats.staticMaxAbsMv} mV`);
console.log(
  `fit: static ${stats.staticMaxAbsMv.toFixed(3)} mV (line ${stats.lineMaxAbsMv.toFixed(3)} mV rejected), knots ${stats.knots}, trip ${stats.tripA} A, envelope <= ${stats.envelopeMaxA} A`
);

for (const row of stats.cases) {
  expect(row.maxAbsMv <= 50, `${row.name} max-abs ${row.maxAbsMv} mV`);
  expect(row.rmsMv <= 10, `${row.name} rms ${row.rmsMv} mV`);
  expect(
    row.resets1 === row.resets2,
    `${row.name} resets ${row.resets1}/${row.resets2}`
  );
  expect(
    row.secondRmsMv <= 1.5 * row.firstRmsMv + 1e-9,
    `${row.name} rms grew ${row.firstRmsMv} -> ${row.secondRmsMv}`
  );
  console.log(
    `free-run ${row.name}: max-abs ${row.maxAbsMv.toFixed(3)} mV, rms ${row.rmsMv.toFixed(3)} mV, half ${row.firstRmsMv.toFixed(3)}/${row.secondRmsMv.toFixed(3)} mV, resets ${row.resets1}/${row.resets2}`
  );
}

const mg90s = await compareMg90sFreeRun();
for (const row of mg90s) {
  expect(row.maxAbsMv <= 50, `mg90s ${row.name} max-abs ${row.maxAbsMv} mV`);
  expect(row.rmsMv <= 10, `mg90s ${row.name} rms ${row.rmsMv} mV`);
  expect(
    row.resets1 === row.resets2,
    `mg90s ${row.name} resets ${row.resets1}/${row.resets2}`
  );
  expect(
    row.secondRmsMv <= 1.5 * row.firstRmsMv + 1e-9,
    `mg90s ${row.name} rms grew ${row.firstRmsMv} -> ${row.secondRmsMv}`
  );
  const stalled =
    row.name === "stall"
      ? `, class 1 ${row.voltage1.toFixed(4)} V, class 2 ${row.voltage2.toFixed(4)} V, servo current class 1 ${row.current1.toFixed(4)} A, class 2 ${row.current2.toFixed(4)} A`
      : "";
  console.log(
    `free-run mg90s ${row.name}: max-abs ${row.maxAbsMv.toFixed(3)} mV, rms ${row.rmsMv.toFixed(3)} mV, half ${row.firstRmsMv.toFixed(3)}/${row.secondRmsMv.toFixed(3)} mV, resets ${row.resets1}/${row.resets2}${stalled}`
  );
}

const root = mkdtempSync(join(tmpdir(), "sfab-snap-"));
try {
  cpSync(nanoDir, root, { recursive: true });
  writeWorld(root, "path-2.world.json", {
    default: 1,
    paths: { nano: { behaviour: 2 } },
  });
  writeWorld(root, "path-1.world.json", {
    default: 1,
    paths: { nano: { behaviour: 1 } },
  });
  writeBench(root);
  writeMismatch(root);
  const high = open(root, "path-2.world.json");
  const low = open(root, "path-1.world.json");
  const bench = open(root, "bench.world.json");
  const mismatch = open(root, "mismatch.world.json");
  const highNano = levelRow(high, "nano");
  const lowNano = levelRow(low, "nano");
  expect(
    highNano.class === 2 && highNano.variant === "circuits",
    `path 2 ran ${highNano.variant} class ${highNano.class}`
  );
  expect(highNano.reason === "path rule nano", highNano.reason);
  expect(high.snapshots.length === 0, "path 2 ran a snapshot");
  expect(
    lowNano.class === 1 && lowNano.variant === "avr8js",
    `path 1 ran ${lowNano.variant} class ${lowNano.class}`
  );
  expect(lowNano.reason === "path rule nano", lowNano.reason);
  expect(
    low.snapshots.length === 1 && low.snapshots[0]?.ref === SNAPSHOT_ID,
    "path 1 snapshot ref"
  );
  expect(low.snapshots[0]?.quality === "Q2a", "path 1 quality");
  const omits = low.notSimulated.find(
    (row) => row.path === "nano" && row.axis === "behaviour"
  );
  expect(
    omits?.effects.includes("rail capacitance (snapshot has no state)") ===
      true && omits.effects.includes("D13 LED and reset network"),
    `omits ${omits?.effects.join("; ")}`
  );
  const benchNano = levelRow(bench, "nano");
  expect(
    benchNano.variant === "avr8js" && benchNano.class === 1,
    "bench feed left class 1"
  );
  expect(bench.snapshots.length === 0, "bench feed ran the snapshot");
  expect(
    bench.warnings.some((diag) => diag.message.includes("ideal terminal")),
    "bench feed has no ideal-terminal note"
  );
  const mismatchNano = levelRow(mismatch, "nano");
  expect(
    mismatchNano.variant === "avr8js" && mismatchNano.class === 1,
    "mismatched port left class 1"
  );
  expect(mismatch.snapshots.length === 0, "mismatched port ran the snapshot");
  expect(
    mismatch.lock.snapshots === undefined,
    "mismatched port pinned the snapshot"
  );
  expect(
    mismatch.warnings.some(
      (diag) =>
        diag.message.includes("ideal terminal") &&
        diag.message.includes("usb-a-port")
    ),
    "mismatched port has no ideal-terminal note"
  );
  console.log(
    `selection: path 2 ${highNano.variant} (${highNano.reason}), path 1 ${lowNano.variant} snapshot (${lowNano.reason}), bench ideal terminal, mismatched usb-a-port ideal terminal`
  );

  const stalled = await envelopeRun(root);
  expect(
    stalled.low.envelope.length === 1,
    `envelope warnings ${stalled.low.envelope.length}`
  );
  if (stalled.high.resets > 0) {
    expect(
      stalled.low.resets > 0,
      `class 2 reset ${stalled.high.resets} times and class 1 did not`
    );
  }
  console.log(
    `envelope: one warning, run continued; resets class 2 ${stalled.high.resets}, class 1 ${stalled.low.resets}`
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

const example = fileURLToPath(
  new URL("../../../examples/nano/", import.meta.url)
);
const first = open(example, "nano-vcc-class1.world.json");
const second = open(example, "nano-vcc-class1.world.json");
expect(
  canonicalJson(first) === canonicalJson(second),
  "reports differ across loads"
);
expect(first.snapshots[0]?.quality === "Q2a", "report quality");
expect(Array.isArray(first.snapshots[0]?.error), "report error");
const reported = first.notSimulated.find(
  (row) => row.path === "nano" && row.axis === "behaviour"
);
expect(
  reported?.effects.includes("rail capacitance (snapshot has no state)") ===
    true,
  "report omits"
);
console.log("report: byte-identical, quality, error, omits");

console.log(
  `INFO move µs/ms class 2 ${stats.moveUsPerMs.class2.toFixed(1)}, class 1 ${stats.moveUsPerMs.class1.toFixed(1)}`
);
console.log(
  "unchanged: class-2 Nano, Uno, arm, gauge, and worlds without a Nano stay on the existing self-checks"
);

function open(project: string, world: string): RunReport {
  const planned = planWorld(project, world);
  if (!planned.ok) {
    throw new Error(planned.errors.map((item) => item.message).join("; "));
  }
  const report = planned.plan.report;
  if (!report) throw new Error(`${world} produced no report`);
  const nano = planned.plan.levels?.find(
    (row) => row.path === "nano" && row.axis === "behaviour"
  );
  expect(
    nano !== undefined,
    `${world} plan has no nano level for world_status`
  );
  return report;
}

function levelRow(report: RunReport, path: string) {
  const row = report.levels.find(
    (item) => item.path === path && item.axis === "behaviour"
  );
  if (!row) throw new Error(`no behaviour level for ${path}`);
  return row;
}

function writeWorld(
  dir: string,
  name: string,
  levels: { default: number; paths?: Record<string, { behaviour: number }> }
): void {
  writeFileSync(
    join(dir, name),
    `${JSON.stringify(
      {
        version: 2,
        environment: { ground: { plane: true }, gravity: [0, 0, -9.81] },
        run: { seed: 1, levels },
        root: { id: "scene", part: "sfab/nano-vcc-scene@1.0.0" },
      },
      null,
      2
    )}\n`
  );
}

function writeBench(dir: string): void {
  writeFileSync(
    join(dir, "parts", "sfab", "bench-scene@1.0.0.json"),
    `{
  "format": "sfab.part@1",
  "id": "sfab/bench-scene@1.0.0",
  "type": "assembly",
  "foreign": false,
  "axes": {
    "behaviour": { "2": { "default": "netlist", "variants": { "netlist": {
      "kind": "composite", "omits": ["no snapshot of this assembly"],
      "netlist": {
        "instances": {
          "nano": { "part": "sfab/nano-ch340@1.0.0", "params": { "firmware": "firmware/hold/hold.hex", "source": "firmware/hold/hold.ino" } },
          "supply": { "part": "sfab/bench-supply@1.0.0" }
        },
        "wires": [["supply.5V", "nano.5V"], ["supply.GND", "nano.GND"]],
        "expose": {}
      }
    } } } },
    "body": { "0": { "default": "none", "variants": { "none": { "kind": "none", "omits": ["assembly adds no body"] } } } },
    "visual": { "0": { "default": "none", "variants": { "none": { "kind": "none", "omits": ["assembly adds no visual"] } } } }
  }
}
`
  );
  writeFileSync(
    join(dir, "bench.world.json"),
    `{
  "version": 2,
  "environment": { "ground": { "plane": true }, "gravity": [0, 0, -9.81] },
  "run": { "seed": 1, "levels": { "default": 1 } },
  "root": { "id": "scene", "part": "sfab/bench-scene@1.0.0" }
}
`
  );
}

function writeMismatch(dir: string): void {
  writeFileSync(
    join(dir, "parts", "sfab", "mismatch-scene@1.0.0.json"),
    `{
  "format": "sfab.part@1",
  "id": "sfab/mismatch-scene@1.0.0",
  "type": "assembly",
  "foreign": false,
  "axes": {
    "behaviour": { "2": { "default": "netlist", "variants": { "netlist": {
      "kind": "composite", "omits": ["no snapshot of this assembly"],
      "netlist": {
        "instances": {
          "nano": { "part": "sfab/nano-ch340@1.0.0", "params": { "firmware": "firmware/hold/hold.hex", "source": "firmware/hold/hold.ino" } },
          "usb": { "part": "sfab/usb-port-500ma@1.0.0", "params": { "Rs": 1 } }
        },
        "wires": [["usb.5V", "nano.5V"], ["usb.GND", "nano.GND"]],
        "expose": {}
      }
    } } } },
    "body": { "0": { "default": "none", "variants": { "none": { "kind": "none", "omits": ["assembly adds no body"] } } } },
    "visual": { "0": { "default": "none", "variants": { "none": { "kind": "none", "omits": ["assembly adds no visual"] } } } }
  }
}
`
  );
  writeFileSync(
    join(dir, "mismatch.world.json"),
    `{
  "version": 2,
  "environment": { "ground": { "plane": true }, "gravity": [0, 0, -9.81] },
  "run": { "seed": 1, "levels": { "default": 1 } },
  "root": { "id": "scene", "part": "sfab/mismatch-scene@1.0.0" }
}
`
  );
}

function overLimit(file: SnapshotFile): void {
  const law = tableLawOf(file);
  expect(law !== null, "snapshot table");
  if (!law) return;
  for (const n of [1, 2, 3]) {
    const motors = Array.from({ length: n }, () => ({
      resistance: 6.5,
      k: 0.3,
    }));
    const usb = stalledRail("usb", motors);
    const snap = stalledRail("snapshot-feed", motors, law);
    const dvMv = Math.abs(usb - snap) * 1000;
    console.log(
      `over-limit n=${n}: class 2 ${usb.toFixed(3)} V, class 1 ${snap.toFixed(3)} V, |Δ| ${dvMv.toFixed(1)} mV`
    );
    expect(dvMv <= 50, `n=${n} differs by ${dvMv.toFixed(1)} mV`);
  }
}

function stalledRail(
  boardPath: "usb" | "snapshot-feed",
  motors: { resistance: number; k: number }[],
  law?: NonNullable<ReturnType<typeof tableLawOf>>
): number {
  const circuit = createRailCircuit({
    vNom: 5,
    rSeries: 0.5,
    iLimit: 0.9,
    motors,
    ...(boardPath === "snapshot-feed"
      ? { boardPath, ...(law ? { law } : {}) }
      : { stamp: NANO_STAMP, feed: "usb" as const }),
  });
  circuit.setFixed(NANO_BOARD_A + 0.0252);
  for (let i = 0; i < motors.length; i++) circuit.setMotor(i, 1, 0, true);
  for (let k = 0; k < 200; k++) circuit.solve();
  return circuit.boardVoltage;
}

async function envelopeRun(dir: string): Promise<{
  low: { envelope: string[]; resets: number };
  high: { resets: number };
}> {
  mkdirSync(join(dir, "firmware", "stall"), { recursive: true });
  cpSync(
    join(armDir, "firmware", "stall", "stall.hex"),
    join(dir, "firmware", "stall", "stall.hex")
  );
  cpSync(
    join(armDir, "firmware", "stall", "stall.ino"),
    join(dir, "firmware", "stall", "stall.ino")
  );
  writeFileSync(
    join(dir, "robot", "flag-stop.urdf"),
    `<?xml version="1.0"?>
<robot name="flag-stop"><mujoco><compiler fusestatic="false" discardvisual="false"/></mujoco>
<link name="base"><inertial><origin xyz="0 0 0.01"/><mass value="0.02"/><inertia ixx="0.000003" ixy="0" ixz="0" iyy="0.000003" iyz="0" izz="0.000005"/></inertial></link>
<link name="vane"><inertial><origin xyz="0.04 0 0"/><mass value="0.01"/><inertia ixx="0.0000004" ixy="0" ixz="0" iyy="0.0000054" iyz="0" izz="0.0000055"/></inertial></link>
<joint name="hinge" type="revolute"><parent link="base"/><child link="vane"/><origin xyz="0 0 0.0125"/><axis xyz="0 0 1"/>
<limit lower="0" upper="0.05" effort="0.18" velocity="10.472"/><dynamics damping="0.001" friction="0"/></joint></robot>
`
  );
  writeFileSync(
    join(dir, "parts", "sfab", "flag-stop@1.0.0.json"),
    `{"format":"sfab.part@1","id":"sfab/flag-stop@1.0.0","type":"flag-hinge","foreign":false,"sources":[{"title":"stall stop","ref":"upper limit 0.05 rad"}],"axes":{"behaviour":{"1":{"default":"rigid","variants":{"rigid":{"kind":"form","form":"multibody@1","params":{},"omits":["joint flexibility"]}}}},"body":{"1":{"default":"urdf","variants":{"urdf":{"kind":"urdf","file":"robot/flag-stop.urdf","omits":["link flex"]}}}},"visual":{"0":{"default":"box","variants":{"box":{"kind":"box","size":[0.08,0.04,0.02],"omits":["link meshes"]}}}}}}`
  );
  writeFileSync(
    join(dir, "parts", "sfab", "over-scene@1.0.0.json"),
    `{
  "format": "sfab.part@1", "id": "sfab/over-scene@1.0.0", "type": "assembly", "foreign": false,
  "axes": { "behaviour": { "2": { "default": "netlist", "variants": { "netlist": {
    "kind": "composite", "omits": ["no snapshot of this assembly"],
    "netlist": {
      "instances": {
        "flag": { "part": "sfab/flag-stop@1.0.0" },
        "flag2": { "part": "sfab/flag-stop@1.0.0", "pose": { "position": [0.25, 0, 0], "rotation": [1, 0, 0, 0] } },
        "nano": { "part": "sfab/nano-ch340@1.0.0", "params": { "firmware": "firmware/stall/stall.hex", "source": "firmware/stall/stall.ino" } },
        "usb": { "part": "sfab/usb-port-500ma@1.0.0" },
        "servo": { "part": "sfab/sg90@1.0.0" },
        "servo2": { "part": "sfab/sg90@1.0.0", "pose": { "position": [0.25, 0, 0], "rotation": [1, 0, 0, 0] } }
      },
      "wires": [
        ["usb.5V", "nano.5V"], ["usb.GND", "nano.GND"],
        ["nano.D9", "servo.signal"], ["nano.5V", "servo.V+"], ["nano.GND", "servo.GND"],
        ["servo.shaft", "flag.hinge"], ["servo.mount", "flag.base"],
        ["nano.D9", "servo2.signal"], ["nano.5V", "servo2.V+"], ["nano.GND", "servo2.GND"],
        ["servo2.shaft", "flag2.hinge"], ["servo2.mount", "flag2.base"]
      ],
      "expose": {}
    }
  } } } },
  "body": { "0": { "default": "none", "variants": { "none": { "kind": "none", "omits": ["assembly adds no body"] } } } },
  "visual": { "0": { "default": "none", "variants": { "none": { "kind": "none", "omits": ["assembly adds no visual"] } } } } }
}
`
  );
  writeFileSync(
    join(dir, "over-1.world.json"),
    `{"version":2,"environment":{"ground":{"plane":true},"gravity":[0,0,-9.81]},"run":{"seed":1,"levels":{"default":1}},"root":{"id":"scene","part":"sfab/over-scene@1.0.0"}}`
  );
  writeFileSync(
    join(dir, "over-2.world.json"),
    `{"version":2,"environment":{"ground":{"plane":true},"gravity":[0,0,-9.81]},"run":{"seed":1,"levels":{"default":1,"paths":{"nano":{"behaviour":2}}}},"root":{"id":"scene","part":"sfab/over-scene@1.0.0"}}`
  );
  const low = await runStall(dir, "over-1.world.json");
  const high = await runStall(dir, "over-2.world.json");
  return { low, high };
}

async function runStall(
  dir: string,
  world: string
): Promise<{ envelope: string[]; resets: number }> {
  const seen: {
    state: WorldState | null;
    report: RunReport | null;
    failed: string | null;
  } = {
    state: null,
    report: null,
    failed: null,
  };
  const attached = await attachWorld(dir, world, {
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
  const ms = 600;
  try {
    attached.step(ms);
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (seen.failed) throw new Error(seen.failed);
      if ((seen.state?.simTime ?? -1) >= ms / 1000 - 1e-3) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!seen.state || seen.state.simTime < ms / 1000 - 1e-3) {
      throw new Error(
        `${world} timed out at ${seen.state?.simTime ?? "no state"} s`
      );
    }
  } finally {
    attached.detach();
    await stopWorld(dir, world);
    closeRootWatches();
  }
  const row = seen.report?.snapshots.find((item) => item.ref === SNAPSHOT_ID);
  return {
    envelope: row?.envelope ?? [],
    resets: seen.state?.boards.nano?.resets ?? 0,
  };
}
