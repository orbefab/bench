/**
 * Power-input snapshot: lint, capture byte-identity, selection, report.
 * Ported from layered-sim E4 (fd10742). The feed snapshot is retired.
 */
import {
  cpSync,
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
} from "@sfab-bench/contract";

import { captureCatalog } from "./capture";
import { canonicalJson } from "./world/parts/si";
import { catalogRoot, planWorld } from "./world/plan";
import { envelopeOf, outsideEnvelope } from "./world/snapshot-law";
import { FIXTURE_SUPPLY, lintSnapshot } from "./world/snapshot-lint";
import { loadSnapshot } from "./world/snapshot-load";

const SNAPSHOT_ID = "sfab/nano-power-input@1.0.0";
const nanoDir = fileURLToPath(
  new URL("../../../examples/nano/", import.meta.url)
);

function expect(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

function snapFile(): string {
  return join(
    catalogRoot(),
    "snapshots",
    "sfab",
    "nano-power-input@1.0.0.json"
  );
}

function powerType(): PartTypeFile {
  return JSON.parse(
    readFileSync(join(catalogRoot(), "types", "power-input.json"), "utf8")
  ) as PartTypeFile;
}

function lint(snap: SnapshotFile) {
  return lintSnapshot(snap, {
    plausible: powerType().plausible,
    ports: powerType().ports,
  });
}

function mustFail(snap: SnapshotFile, needle: string, label: string): void {
  const result = lint(snap);
  const text = result.diagnostics.map((diag) => diag.message).join("\n");
  expect(result.diagnostics.length > 0, `${label} was accepted`);
  expect(text.includes(needle), `${label} missed ${needle}: ${text}`);
}

const before = readFileSync(snapFile(), "utf8");
const stats = await captureCatalog();
const after = readFileSync(snapFile(), "utf8");
expect(before === after, "capture did not reproduce the committed snapshot");
console.log("capture reproducible: byte-identical");

const committed = JSON.parse(after) as SnapshotFile;
const clean = lint(committed);
expect(
  clean.diagnostics.length === 0,
  clean.diagnostics.map((d) => d.message).join("; ")
);
expect(clean.quality === "Q1", `linter granted ${clean.quality}`);
const env = envelopeOf(committed);
expect(env !== null, "snapshot envelope");
expect(
  env !== null && !outsideEnvelope(env, 0, env.current[1]),
  "current bound is outside itself"
);
expect(
  env !== null && outsideEnvelope(env, 0, env.current[1] + 0.01),
  "current just above the bound is inside"
);
console.log(
  `envelope unit: ${env?.current[1]} A inside, ${(env?.current[1] ?? 0) + 0.01} A outside`
);
const loaded = loadSnapshot(
  tmpdir(),
  { catalogDir: catalogRoot(), assetRoot: tmpdir() },
  SNAPSHOT_ID,
  powerType()
);
expect(
  loaded.diagnostics.length === 0,
  "loader rejected the committed snapshot"
);
expect(loaded.loaded?.quality === "Q1", "loader quality is not Q1");
console.log("lint: committed snapshot Q1");

{
  const copy = structuredClone(committed);
  delete (copy as { provenance?: unknown }).provenance;
  mustFail(copy, "missing provenance", "no provenance");
}
{
  const copy = structuredClone(committed);
  copy.envelope.bounds["VBUS.current"] = [0, 2];
  mustFail(copy, "table does not cover its envelope", "wide envelope");
}
{
  const copy = structuredClone(committed);
  copy.quality = "Q3";
  mustFail(
    copy,
    "quality claim Q3 is above the linter grant Q1",
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
  copy.envelope.bounds["supply.voltage"] = [4.75, 5.25];
  const result = lint(copy);
  const hit = result.diagnostics.find((diag) =>
    diag.message.includes(FIXTURE_SUPPLY)
  );
  expect(
    hit !== undefined,
    `fixture supply was accepted: ${result.diagnostics.map((d) => d.message).join("\n")}`
  );
  console.log(`lint fixture supply: ${hit?.message}`);
}
console.log("lint: broken copies rejected");

expect(stats.staticMaxAbsMv <= 10, `fit ${stats.staticMaxAbsMv} mV`);
console.log(
  `fit: static ${stats.staticMaxAbsMv.toFixed(3)} mV (line ${stats.lineMaxAbsMv.toFixed(3)} mV rejected), knots ${stats.knots}, trip ${stats.tripA} A, envelope <= ${stats.envelopeMaxA} A`
);

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
    low.snapshots.length === 1 &&
      low.snapshots[0]?.ref === SNAPSHOT_ID &&
      low.snapshots[0]?.path === "nano.power",
    `path 1 snapshot ${low.snapshots.map((row) => `${row.path} ${row.ref}`).join(",")}`
  );
  expect(low.snapshots[0]?.quality === "Q1", "path 1 quality");
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
  expect(
    bench.snapshots.some((row) => row.ref === SNAPSHOT_ID),
    "bench feed dropped the power snapshot"
  );
  expect(
    bench.warnings.every((diag) => !diag.message.includes("ideal terminal")),
    "bench feed fell back to the ideal terminal"
  );
  const mismatchNano = levelRow(mismatch, "nano");
  expect(
    mismatchNano.variant === "avr8js" && mismatchNano.class === 1,
    "mismatched port left class 1"
  );
  expect(
    mismatch.snapshots.some((row) => row.ref === SNAPSHOT_ID),
    "wide usb dropped the power snapshot"
  );
  expect(
    mismatch.lock.snapshots?.some((row) => row.id === SNAPSHOT_ID) === true,
    "wide usb did not pin the power snapshot"
  );
  expect(
    mismatch.warnings.every((diag) => !diag.message.includes("ideal terminal")),
    "wide usb fell back to the ideal terminal"
  );
  console.log(
    `selection: path 2 ${highNano.variant} (${highNano.reason}), path 1 ${lowNano.variant} power snapshot ${SNAPSHOT_ID} Q1 (${lowNano.reason}), bench and wide usb keep the power group`
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
expect(first.snapshots[0]?.quality === "Q1", "report quality");
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
          "usb": { "part": "sfab/usb-port-500ma@1.0.0", "params": { "Rs": 1.5, "Ilimit": 0.5 } }
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
