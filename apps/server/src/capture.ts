/**
 * Ported from layered-sim E4 (fd10742). Fit a firmware board's input and
 * write its snapshot. The DC table and `from.hash` come from that part's
 * board netlist. Free-run cases stay Nano scenes: they boot a sketch and
 * a servo, and the config names the firmware, the servo, and the duration.
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
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  FIXTURE_FORMAT,
  type FixtureFile,
  type PartTypeFile,
  type RecordingRead,
  SNAPSHOT_FORMAT,
  type SnapshotFile,
  type WorldState,
} from "@sfab-bench/contract";

import { closeRootWatches } from "./projects";
import { boardStampOf, describeNetlist } from "./world/circuit-stamp";
import { attachWorld, readRecording, stopWorld } from "./world/host";
import { netlistDc } from "./world/nano-usb-dc";
import { loadPartById } from "./world/parts/library";
import { contentHash, sortValue } from "./world/parts/si";
import { catalogRoot } from "./world/plan";
import { type TableLaw, tableVoltage } from "./world/snapshot-law";
import { lintSnapshot } from "./world/snapshot-lint";

type FreeCase = {
  firmware: string;
  source: string;
  flag: string;
  ms: number;
  servo: string;
};

export type CaptureConfig = {
  created: string;
  tool: { name: string; version: string };
  part: string;
  variant: string;
  /** Instance path. Node names in the provenance hash use it. */
  instance: string;
  feedPort: string;
  loadPort: string;
  /** Ohms. The cable resistance stamped in front of `feedPort`. */
  rSeries: number;
  sweep: { fixture: string };
  /**
   * Free-run scenes, keyed by case. Each one is a Nano, a servo, and a
   * sketch. Absent, the capture writes the DC table only.
   */
  cases?: Record<string, FreeCase>;
};
/** Stop the envelope this far under the port's current limit. The clone has no polyfuse. */
const TRIP_MARGIN_A = 0.01;
/** Insert knots until the sweep sits inside this band, then the 10 mV check is the bound. */
const FIT_V = 0.002;

export type CaptureCase = {
  name: string;
  maxAbsMv: number;
  rmsMv: number;
  firstRmsMv: number;
  secondRmsMv: number;
  resets1: number;
  resets2: number;
};

export type CaptureStats = {
  /** Max |table − class-2 DC| across the fixture, in millivolts. */
  staticMaxAbsMv: number;
  /** Rejected straight-line fit, in millivolts. Printed so the table's reason is visible. */
  lineMaxAbsMv: number;
  knots: number;
  /** `sfab/usb-port-500ma` thevenin `Ilimit`, amperes. */
  tripA: number;
  /** Envelope current upper bound, amperes. One margin below `tripA`. */
  envelopeMaxA: number;
  cases: CaptureCase[];
  moveUsPerMs: { class1: number; class2: number };
  json: string;
};

type Sweep = { supply: number[]; current: number[] };

export type CaptureRun = {
  /** Overrides the fixture path in the config. The committed Nano capture uses this. */
  fixtureFile?: string;
  config?: CaptureConfig;
  catalogDir?: string;
  libraryDir?: string;
  /** Where to write. Absent, the fixture id names the catalog snapshot. */
  outFile?: string;
  /** Default true when `config.cases` has scenes. */
  freeRun?: boolean;
};

export async function captureNanoUsb(
  fixtureFile?: string
): Promise<CaptureStats> {
  return captureFromConfig({ ...(fixtureFile ? { fixtureFile } : {}) });
}

/** DC table from `boardStampOf`, plus free-run when the config has scenes. */
export async function captureFromConfig(
  opts: CaptureRun = {}
): Promise<CaptureStats> {
  const catalog = opts.catalogDir ?? catalogRoot();
  const config =
    opts.config ??
    (JSON.parse(
      readFileSync(join(catalog, "fixtures", "capture.config.json"), "utf8")
    ) as CaptureConfig);
  const stamp = boardStampOf(config.part, config.variant, {
    catalogDir: catalog,
    boardId: config.instance,
    ...(opts.libraryDir ? { libraryDir: opts.libraryDir } : {}),
  });
  const feed =
    stamp.vbusNode !== null &&
    stamp.portNodes[config.feedPort] === stamp.vbusNode
      ? "usb"
      : "header";
  if (!stamp.portNodes[config.feedPort]) {
    throw new Error(`${config.part} has no ${config.feedPort} node`);
  }
  if (!stamp.portNodes[config.loadPort]) {
    throw new Error(`${config.part} has no ${config.loadPort} node`);
  }
  const dc = (supply: number, amps: number) =>
    netlistDc(stamp, supply, amps, config.rSeries, feed, config.loadPort);
  const fixturePath =
    opts.fixtureFile ??
    join(catalog, "fixtures", `${config.sweep.fixture}.fixture.json`);
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as FixtureFile;
  if (fixture.format !== FIXTURE_FORMAT) {
    throw new Error(`fixture format ${fixture.format}`);
  }
  const sweep = sweepsOf(fixture, config.loadPort);
  const tripA = usbTrip(catalog);
  const envelopeMaxA = sweep.current.find(
    (amps) => Math.abs(amps - (tripA - TRIP_MARGIN_A)) < 1e-6
  );
  if (envelopeMaxA === undefined || sweep.current[0] !== 0) {
    throw new Error(
      "fixture current sweep must start at 0 and include the point 0.01 A below the usb-a-port trip"
    );
  }
  const atTyp = sweep.current.map((amps) => dc(5, amps));
  const lineMaxAbsMv = lineError(sweep.current, atTyp) * 1000;
  const knots = fitKnots(sweep.current, atTyp);
  const law: TableLaw = {
    iAxis: knots,
    vAxis: knots.map((amps) => round9(dc(5, amps))),
    supplyRef: 5,
    supplyAffine: 1,
  };
  let staticMax = 0;
  for (const supply of sweep.supply) {
    for (const amps of sweep.current) {
      const err = Math.abs(dc(supply, amps) - tableVoltage(law, supply, amps));
      if (err > staticMax) staticMax = err;
    }
  }

  const partType = partTypeOf(config.part, catalog, opts.libraryDir);
  const hash = contentHash(describeNetlist(stamp, config.rSeries, feed));
  const bench = benchVersions();
  const scenes = Object.entries(config.cases ?? {}).map(([name, row]) => ({
    name,
    ...row,
  }));
  const runFree = opts.freeRun ?? scenes.length > 0;
  const outPath = opts.outFile ?? snapshotPath(catalog, config.sweep.fixture);
  const shared = {
    law,
    fixture,
    fixtureRef: config.sweep.fixture,
    config,
    partType,
    hash,
    bench,
    envelopeMaxA,
    tripA,
  };
  if (!runFree) {
    const base = snapshotOf({
      ...shared,
      error: "none-available",
      quality: "Q1",
    });
    const lint = lintBoard(base, partType, catalog);
    if (lint.diagnostics.length > 0) {
      throw new Error(
        `snapshot lint ${lint.quality}: ${lint.diagnostics.map((d) => d.message).join("; ")}`
      );
    }
    base.quality = lint.quality;
    const json = writeSnapshot(outPath, base);
    return {
      staticMaxAbsMv: staticMax * 1000,
      lineMaxAbsMv,
      knots: knots.length,
      tripA,
      envelopeMaxA,
      cases: [],
      moveUsPerMs: { class1: 0, class2: 0 },
      json,
    };
  }
  writeSnapshot(
    outPath,
    snapshotOf({ ...shared, error: "none-available", quality: "Q1" })
  );
  const free = await runScenes(scenes);
  const worstAbs = Math.max(...free.cases.map((row) => row.maxAbsMv)) / 1000;
  const worstRms = Math.max(...free.cases.map((row) => row.rmsMv)) / 1000;
  const done = snapshotOf({
    ...shared,
    error: [
      {
        metric: "free-run-max-abs",
        quantity: `${config.loadPort}.voltage`,
        value: round9(worstAbs),
        heldOut: "use-like",
        baseline: { level: "2", value: 0 },
      },
      {
        metric: "free-run-rms",
        quantity: `${config.loadPort}.voltage`,
        value: round9(worstRms),
        heldOut: "use-like",
        baseline: { level: "2", value: 0 },
      },
    ],
    quality: "Q2a",
  });
  const lint = lintBoard(done, partType, catalog);
  if (lint.diagnostics.length > 0 || lint.quality !== "Q2a") {
    const text = lint.diagnostics.map((diag) => diag.message).join("; ");
    throw new Error(`snapshot lint ${lint.quality}: ${text}`);
  }
  done.quality = lint.quality;
  const json = writeSnapshot(outPath, done);
  return {
    staticMaxAbsMv: staticMax * 1000,
    lineMaxAbsMv,
    knots: knots.length,
    tripA,
    envelopeMaxA,
    cases: free.cases,
    moveUsPerMs: free.moveUsPerMs,
    json,
  };
}

function snapshotPath(catalog: string, fixtureRef: string): string {
  const slash = fixtureRef.indexOf("/");
  const publisher = fixtureRef.slice(0, slash);
  const name = fixtureRef.slice(slash + 1);
  return join(catalog, "snapshots", publisher, `${name}@1.0.0.json`);
}

function partTypeOf(
  partId: string,
  catalog: string,
  libraryDir?: string
): string {
  const worldDir = join(catalog, ".board-stamp-world");
  const loaded = loadPartById(
    worldDir,
    {
      catalogDir: catalog,
      assetRoot: catalog,
      ...(libraryDir ? { libraryDir } : {}),
    },
    partId
  );
  if (!("part" in loaded)) throw new Error(loaded.message);
  const type = loaded.part.type;
  return typeof type === "string" ? type : type.id;
}

function lintBoard(snap: SnapshotFile, partType: string, catalog: string) {
  const type = JSON.parse(
    readFileSync(join(catalog, "types", `${partType}.json`), "utf8")
  ) as PartTypeFile;
  return lintSnapshot(snap, { plausible: type.plausible, actuator: false });
}

function snapshotOf(input: {
  law: TableLaw;
  fixture: FixtureFile;
  fixtureRef: string;
  config: CaptureConfig;
  partType: string;
  hash: string;
  bench: { version: string; mujoco: string; avr8js: string };
  envelopeMaxA: number;
  tripA: number;
  error: SnapshotFile["error"];
  quality: SnapshotFile["quality"];
}): SnapshotFile {
  const load = input.config.loadPort;
  return {
    format: SNAPSHOT_FORMAT,
    partType: input.partType,
    part: input.config.part,
    axis: "behaviour",
    form: "table@1",
    ports: {
      inputs: [`${load}.current`, "supply.voltage"],
      outputs: [`${load}.voltage`],
    },
    params: {
      iAxis: [...input.law.iAxis],
      vAxis: [...input.law.vAxis],
      supplyRef: input.law.supplyRef,
      supplyAffine: input.law.supplyAffine,
    },
    envelope: {
      bounds: {
        "supply.voltage": [4.75, 5.25],
        [`${load}.current`]: [0, input.envelopeMaxA],
        "supply.resistance": [input.config.rSeries, input.config.rSeries],
        "supply.currentLimit": [input.tripA, input.tripA],
      },
    },
    error: input.error,
    quality: input.quality,
    provenance: {
      source: "captured",
      from: {
        part: input.config.part,
        level: "2",
        hash: input.hash,
      },
      fixture: {
        ref: input.fixtureRef,
        hash: contentHash(input.fixture),
        seed: input.fixture.seed,
      },
      tool: input.config.tool,
      citations: [
        {
          title: "usb-a-port current limit",
          ref: `sfab/usb-port-500ma@1.0.0 thevenin Ilimit ${input.tripA} A; the envelope stops ${TRIP_MARGIN_A} A below that trip`,
        },
      ],
      bench: input.bench,
      created: input.config.created,
    },
  };
}

function writeSnapshot(file: string, snap: SnapshotFile): string {
  mkdirSync(dirname(file), { recursive: true });
  const json = `${JSON.stringify(sortValue(snap), null, 2)}\n`;
  writeFileSync(file, json);
  return json;
}

function sweepsOf(fixture: FixtureFile, loadPort: string): Sweep {
  const supply = fixture.sweeps.find(
    (row) => row.port === "supply" && row.quantity === "Voltage"
  );
  const current = fixture.sweeps.find(
    (row) => row.port === loadPort && row.quantity === "Current"
  );
  if (!supply || !current) {
    throw new Error("fixture needs supply Voltage and 5V Current sweeps");
  }
  return { supply: supply.values, current: current.values };
}

function usbTrip(catalog: string): number {
  const part = JSON.parse(
    readFileSync(
      join(catalog, "parts", "sfab", "usb-port-500ma@1.0.0.json"),
      "utf8"
    )
  ) as {
    axes: {
      behaviour: {
        "1": { variants: { thevenin: { params: { Ilimit: number } } } };
      };
    };
  };
  return part.axes.behaviour["1"].variants.thevenin.params.Ilimit;
}

function benchVersions(): { version: string; mujoco: string; avr8js: string } {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  ) as { version: string; dependencies: Record<string, string> };
  return {
    version: pkg.version,
    mujoco: pkg.dependencies["@mujoco/mujoco"] ?? "unknown",
    avr8js: pkg.dependencies.avr8js ?? "unknown",
  };
}

function lineError(current: number[], volts: number[]): number {
  const n = current.length;
  let sI = 0;
  let sV = 0;
  let sII = 0;
  let sIV = 0;
  for (let k = 0; k < n; k++) {
    const i = current[k] ?? 0;
    const v = volts[k] ?? 0;
    sI += i;
    sV += v;
    sII += i * i;
    sIV += i * v;
  }
  const det = n * sII - sI * sI;
  const a = (sV * sII - sI * sIV) / det;
  const b = (n * sIV - sI * sV) / det;
  let max = 0;
  for (let k = 0; k < n; k++) {
    const err = Math.abs((volts[k] ?? 0) - (a + b * (current[k] ?? 0)));
    if (err > max) max = err;
  }
  return max;
}

function fitKnots(current: number[], volts: number[]): number[] {
  const knots = [current[0] ?? 0, current[current.length - 1] ?? 0];
  while (knots.length < 40) {
    let worst = -1;
    let worstErr = 0;
    const law = lawFrom(knots, current, volts);
    for (let k = 0; k < current.length; k++) {
      const amps = current[k] ?? 0;
      if (knots.some((knot) => knot === amps)) continue;
      const err = Math.abs((volts[k] ?? 0) - tableVoltage(law, 5, amps));
      if (err > worstErr) {
        worstErr = err;
        worst = k;
      }
    }
    if (worst < 0 || worstErr <= FIT_V) break;
    knots.push(current[worst] ?? 0);
    knots.sort((a, b) => a - b);
  }
  return knots;
}

function lawFrom(
  knots: number[],
  current: number[],
  volts: number[]
): TableLaw {
  return {
    iAxis: knots,
    vAxis: knots.map((amps) => {
      const at = current.indexOf(amps);
      return volts[at] ?? 0;
    }),
    supplyRef: 5,
    supplyAffine: 1,
  };
}

function round9(n: number): number {
  return Math.round(n * 1e9) / 1e9;
}

type FreeScene = FreeCase & { name: string };

/** The comparison servo. The snapshot's own scenes stay the config's servo. */
const MG90S = "sfab/mg90s@1.0.0";

function readCaptureConfig(catalog: string): CaptureConfig {
  return JSON.parse(
    readFileSync(join(catalog, "fixtures", "capture.config.json"), "utf8")
  ) as CaptureConfig;
}

function scenesOf(config: CaptureConfig): FreeScene[] {
  return Object.entries(config.cases ?? {}).map(([name, row]) => ({
    name,
    ...row,
  }));
}

export type ServoFreeRun = CaptureCase & {
  /** Last-frame Nano 5V node, volts. */
  voltage1: number;
  voltage2: number;
  /** Last-frame servo supply current, amperes. */
  current1: number;
  current2: number;
};

/** Class 1 against class 2 for the config scenes, with an MG90S. Does not write the snapshot. */
export async function compareMg90sFreeRun(): Promise<ServoFreeRun[]> {
  const scenes = scenesOf(readCaptureConfig(catalogRoot()))
    .filter((spec) => spec.name !== "move")
    .map((spec) => ({ ...spec, servo: MG90S }));
  const ran = await runScenes(scenes);
  return ran.cases;
}

async function runScenes(specs: readonly FreeScene[]): Promise<{
  cases: ServoFreeRun[];
  moveUsPerMs: { class1: number; class2: number };
}> {
  const examples = fileURLToPath(
    new URL("../../../examples/", import.meta.url)
  );
  const nanoDir = join(examples, "nano");
  const armStall = join(examples, "arm", "firmware", "stall");
  const root = mkdtempSync(join(tmpdir(), "sfab-capture-"));
  const cases: ServoFreeRun[] = [];
  const moveUsPerMs = { class1: 0, class2: 0 };
  try {
    cpSync(nanoDir, root, { recursive: true });
    mkdirSync(join(root, "firmware", "stall"), { recursive: true });
    cpSync(
      join(armStall, "stall.hex"),
      join(root, "firmware", "stall", "stall.hex")
    );
    cpSync(
      join(armStall, "stall.ino"),
      join(root, "firmware", "stall", "stall.ino")
    );
    writeStop(root);
    for (const spec of specs) {
      writeScene(root, `${spec.name}-c1`, spec, 1);
      writeScene(root, `${spec.name}-c2`, spec, 2);
      const t1 = performance.now();
      const low = await runWorld(root, `${spec.name}-c1.world.json`, spec.ms);
      const wall1 = performance.now() - t1;
      const t2 = performance.now();
      const high = await runWorld(root, `${spec.name}-c2.world.json`, spec.ms);
      const wall2 = performance.now() - t2;
      if (spec.name === "move") {
        moveUsPerMs.class1 = (wall1 * 1000) / spec.ms;
        moveUsPerMs.class2 = (wall2 * 1000) / spec.ms;
      }
      const err = voltageError(low.read, high.read);
      const end1 = railEnd(low.read);
      const end2 = railEnd(high.read);
      cases.push({
        name: spec.name,
        maxAbsMv: err.maxAbs * 1000,
        rmsMv: err.rms * 1000,
        firstRmsMv: err.first * 1000,
        secondRmsMv: err.second * 1000,
        resets1: low.state.boards.nano?.resets ?? 0,
        resets2: high.state.boards.nano?.resets ?? 0,
        voltage1: end1.voltage,
        voltage2: end2.voltage,
        current1: end1.current,
        current2: end2.current,
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return { cases, moveUsPerMs };
}

function voltageError(
  low: RecordingRead,
  high: RecordingRead
): { maxAbs: number; rms: number; first: number; second: number } {
  const n = Math.min(low.frames.length, high.frames.length);
  const err: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = low.frames[i]?.boards.nano?.voltage;
    const b = high.frames[i]?.boards.nano?.voltage;
    if (a === undefined || b === undefined) {
      throw new Error(`missing 5V sample at frame ${i}`);
    }
    err.push(a - b);
  }
  if (err.length < 2)
    throw new Error("recording has fewer than two 5V samples");
  const mid = Math.floor(err.length / 2);
  return {
    maxAbs: err.reduce((max, item) => Math.max(max, Math.abs(item)), 0),
    rms: rms(err),
    first: rms(err.slice(0, mid)),
    second: rms(err.slice(mid)),
  };
}

function rms(values: number[]): number {
  let sum = 0;
  for (const value of values) sum += value * value;
  return Math.sqrt(sum / values.length);
}

function railEnd(read: RecordingRead): { voltage: number; current: number } {
  const frame = read.frames[read.frames.length - 1];
  const voltage = frame?.boards.nano?.voltage;
  const current = frame?.parts.servo?.current;
  if (voltage === undefined || current === undefined) {
    throw new Error(
      "recording is missing the Nano 5V node or the servo current"
    );
  }
  return { voltage, current };
}

async function runWorld(
  project: string,
  world: string,
  ms: number
): Promise<{ state: WorldState; read: RecordingRead }> {
  const seen: { state: WorldState | null; failed: string | null } = {
    state: null,
    failed: null,
  };
  const attached = await attachWorld(project, world, {
    sender: { kind: "loopback", label: "Mac" },
    onEvent(event) {
      if (event.type === "error") {
        seen.failed =
          event.message ?? event.errors.map((item) => item.message).join("; ");
      }
      if (event.type === "state") seen.state = event.state;
    },
  });
  if ("error" in attached) throw new Error(attached.error);
  try {
    attached.step(ms);
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (seen.failed) throw new Error(seen.failed);
      const simTime = seen.state?.simTime ?? -1;
      if (simTime >= ms / 1000 - 1e-3) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const state = seen.state;
    if (!state || state.simTime < ms / 1000 - 1e-3) {
      throw new Error(
        `${world} timed out at ${state ? state.simTime : "no state"} s`
      );
    }
    const read = await readRecording(project, world, {
      from: 0,
      to: ms / 1000,
    });
    if ("error" in read) throw new Error(read.error);
    return { state, read };
  } finally {
    attached.detach();
    await stopWorld(project, world);
    closeRootWatches();
  }
}

function writeStop(dir: string): void {
  writeFileSync(
    join(dir, "robot", "flag-stop.urdf"),
    `<?xml version="1.0"?>
<robot name="flag-stop">
  <mujoco><compiler fusestatic="false" discardvisual="false"/></mujoco>
  <link name="base">
    <inertial><origin xyz="0 0 0.01" rpy="0 0 0"/><mass value="0.02"/>
      <inertia ixx="0.000003" ixy="0" ixz="0" iyy="0.000003" iyz="0" izz="0.000005"/>
    </inertial>
    <visual><origin xyz="0 0 0.01" rpy="0 0 0"/><geometry><box size="0.04 0.04 0.02"/></geometry></visual>
  </link>
  <link name="vane">
    <inertial><origin xyz="0.04 0 0" rpy="0 0 0"/><mass value="0.01"/>
      <inertia ixx="0.0000004" ixy="0" ixz="0" iyy="0.0000054" iyz="0" izz="0.0000055"/>
    </inertial>
    <visual><origin xyz="0.04 0 0" rpy="0 0 0"/><geometry><box size="0.08 0.02 0.005"/></geometry></visual>
  </link>
  <joint name="hinge" type="revolute">
    <parent link="base"/><child link="vane"/>
    <origin xyz="0 0 0.0125" rpy="0 0 0"/><axis xyz="0 0 1"/>
    <limit lower="0" upper="0.05" effort="0.18" velocity="10.472"/>
    <dynamics damping="0.001" friction="0"/>
  </joint>
</robot>
`
  );
  writeFileSync(
    join(dir, "parts", "sfab", "flag-stop@1.0.0.json"),
    `{
  "format": "sfab.part@1",
  "id": "sfab/flag-stop@1.0.0",
  "type": "flag-hinge",
  "foreign": false,
  "sources": [{ "title": "stall stop", "ref": "upper limit 0.05 rad" }],
  "axes": {
    "behaviour": { "1": { "default": "rigid", "variants": { "rigid": { "kind": "form", "form": "multibody@1", "params": {}, "omits": ["joint flexibility"] } } } },
    "body": { "1": { "default": "urdf", "variants": { "urdf": { "kind": "urdf", "file": "robot/flag-stop.urdf", "omits": ["link flex"] } } } },
    "visual": { "0": { "default": "box", "variants": { "box": { "kind": "box", "size": [0.08, 0.04, 0.02], "omits": ["link meshes"] } } } }
  }
}
`
  );
}

/**
 * A Nano, the scene's servo, and the scene's sketch. Free-run needs
 * firmware and a body, so this stays the Nano even when the DC table
 * is some other board.
 */
function writeScene(
  dir: string,
  name: string,
  spec: FreeScene,
  behaviour: 1 | 2
): void {
  const levels =
    behaviour === 2
      ? `"default": 1, "types": { "arduino-nano": { "behaviour": 2 } }`
      : `"default": 1`;
  writeFileSync(
    join(dir, "parts", "sfab", `${name}-scene@1.0.0.json`),
    `{
  "format": "sfab.part@1",
  "id": "sfab/${name}-scene@1.0.0",
  "type": "assembly",
  "foreign": false,
  "axes": {
    "behaviour": {
      "2": {
        "default": "netlist",
        "variants": {
          "netlist": {
            "kind": "composite",
            "omits": ["no snapshot of this assembly"],
            "netlist": {
              "instances": {
                "flag": { "part": "${spec.flag}" },
                "nano": { "part": "sfab/nano-ch340@1.0.0", "params": { "firmware": "${spec.firmware}", "source": "${spec.source}" } },
                "usb": { "part": "sfab/usb-port-500ma@1.0.0" },
                "servo": { "part": "${spec.servo}" }
              },
              "wires": [
                ["usb.5V", "nano.5V"],
                ["usb.GND", "nano.GND"],
                ["nano.D9", "servo.signal"],
                ["nano.5V", "servo.V+"],
                ["nano.GND", "servo.GND"],
                ["servo.shaft", "flag.hinge"],
                ["servo.mount", "flag.base"]
              ],
              "expose": {}
            }
          }
        }
      }
    },
    "body": { "0": { "default": "none", "variants": { "none": { "kind": "none", "omits": ["assembly adds no body"] } } } },
    "visual": { "0": { "default": "none", "variants": { "none": { "kind": "none", "omits": ["assembly adds no visual"] } } } }
  }
}
`
  );
  writeFileSync(
    join(dir, `${name}.world.json`),
    `{
  "version": 2,
  "environment": { "ground": { "plane": true }, "gravity": [0, 0, -9.81] },
  "run": { "seed": 1, "levels": { ${levels} } },
  "root": { "id": "scene", "part": "sfab/${name}-scene@1.0.0" }
}
`
  );
}
