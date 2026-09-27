/**
 * Ported from layered-sim E4 (fd10742). Fit one port pair from the capture
 * config and write its snapshot. The DC table and `from.hash` come from
 * that part's stamp. Free-run, when the entry has cases, boots the entry's
 * scene.
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
import {
  assemblyStampOf,
  boardStampOf,
  describeNetlist,
} from "./world/circuit-stamp";
import { attachWorld, readRecording, stopWorld } from "./world/host";
import { loadPartById } from "./world/parts/library";
import { contentHash, sortValue } from "./world/parts/si";
import { catalogRoot } from "./world/plan";
import { branchDc, feedKind, supplyDc } from "./world/snapshot-dc";
import { type TableLaw, tableVoltage } from "./world/snapshot-law";
import { lintSnapshot } from "./world/snapshot-lint";

type FreeCase = {
  firmware: string;
  source: string;
  flag: string;
  ms: number;
  load: string;
};

export type CaptureFile = {
  created: string;
  tool: { name: string; version: string };
  entries: CaptureEntry[];
};

export type FreeRunSpec = {
  project: string;
  board: string;
  currentPart: string;
  boardPart: string;
  supplyInstance: string;
  supplyPart: string;
  flagInstance: string;
  comparePart?: string;
  compareSkip?: string[];
  stallFrom?: string;
  stallDir?: string;
  wires: [string, string][];
};

export type CaptureEntry = {
  id: string;
  part: string;
  variant: string;
  instance: string;
  /** Absent is a capture error when the part exposes two non-ground ports. */
  across?: [string, string];
  through: string;
  iSense: 1 | -1;
  supply?: { port: string; ref: number; affine: number };
  fitV: number;
  baseline: { level: string; value: number };
  heldOut: "fixture" | "use-like" | "both";
  /** Write a static-max-abs row. A feed entry can omit it. */
  staticError?: boolean;
  sweep: {
    fixture?: string;
    supplyPort?: string;
    supplyQuantity?: string;
    currentPort?: string;
    currentQuantity?: string;
    current?: number[];
  };
  envelope: { supplyVoltage?: [number, number]; marginA?: number };
  feed?: {
    part: string;
    port: string;
    rSeries: number;
    citationTitle: string;
  };
  freeRun?: FreeRunSpec;
  cases?: Record<string, FreeCase>;
};

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
  /** Feed current limit, amperes. The sweep end when there is no feed. */
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
  config?: CaptureFile | CaptureEntry;
  catalogDir?: string;
  libraryDir?: string;
  /** Where to write. Absent, the fixture id names the catalog snapshot. */
  outFile?: string;
  /** Default true when `config.cases` has scenes. */
  freeRun?: boolean;
};

export async function captureCatalog(
  fixtureFile?: string
): Promise<CaptureStats> {
  return captureFromConfig({ ...(fixtureFile ? { fixtureFile } : {}) });
}

/** Every config entry. The returned stats are the entry that has free-run cases. */
export async function captureFromConfig(
  opts: CaptureRun = {}
): Promise<CaptureStats> {
  const catalog = opts.catalogDir ?? catalogRoot();
  const file = readCaptureFile(catalog, opts.config);
  if (opts.outFile && file.entries.length !== 1) {
    throw new Error("outFile needs a single capture entry");
  }
  const stats: CaptureStats[] = [];
  for (const entry of file.entries) {
    stats.push(await captureEntry(entry, file, catalog, opts));
  }
  const ran = stats.find((row) => row.cases.length > 0) ?? stats[0];
  if (!ran) throw new Error("capture config has no entries");
  return ran;
}

function readCaptureFile(
  catalog: string,
  inline: CaptureRun["config"]
): CaptureFile {
  if (inline && "entries" in inline) return inline;
  if (inline) {
    return {
      created: "",
      tool: { name: "", version: "" },
      entries: [inline],
    };
  }
  return JSON.parse(
    readFileSync(join(catalog, "fixtures", "capture.config.json"), "utf8")
  ) as CaptureFile;
}

async function captureEntry(
  config: CaptureEntry,
  file: CaptureFile,
  catalog: string,
  opts: CaptureRun
): Promise<CaptureStats> {
  const across = acrossOf(config, catalog, opts.libraryDir);
  const stampOpts = {
    catalogDir: catalog,
    boardId: config.instance,
    ...(opts.libraryDir ? { libraryDir: opts.libraryDir } : {}),
  };
  const stamp = config.feed
    ? boardStampOf(config.part, config.variant, stampOpts)
    : assemblyStampOf(config.part, config.variant, {
        ...stampOpts,
        across,
      });
  const feedPort = config.feed?.port;
  const onConnector = Boolean(
    feedPort &&
      stamp.vbusNode !== null &&
      stamp.portNodes[feedPort] === stamp.vbusNode
  );
  const feed = feedKind(onConnector);
  if (feedPort && !stamp.portNodes[feedPort]) {
    throw new Error(`${config.part} has no ${feedPort} node`);
  }
  for (const name of [across[0], across[1], config.through]) {
    if (!stamp.portNodes[name]) {
      throw new Error(`${config.part} has no ${name} node`);
    }
  }
  const rSeries = config.feed?.rSeries ?? 0;
  const dc = (supply: number, amps: number) =>
    config.feed
      ? supplyDc(stamp, supply, amps, rSeries, onConnector, config.through)
      : branchDc(stamp, across[0], across[1], amps);
  const fixture = config.sweep.fixture
    ? readFixture(
        opts.fixtureFile ??
          join(catalog, "fixtures", `${config.sweep.fixture}.fixture.json`)
      )
    : null;
  const sweep = fixture
    ? sweepsOf(fixture, config)
    : {
        supply: config.supply ? [config.supply.ref] : [0],
        current: config.sweep.current ?? [],
      };
  const tripA = config.feed
    ? limitOf(catalog, config.feed.part)
    : (sweep.current[sweep.current.length - 1] ?? 0);
  const margin = config.envelope.marginA ?? 0;
  const envelopeMaxA = config.feed
    ? sweep.current.find((amps) => Math.abs(amps - (tripA - margin)) < 1e-6)
    : sweep.current[sweep.current.length - 1];
  if (envelopeMaxA === undefined) {
    throw new Error(
      `${config.part} current sweep does not include the envelope end`
    );
  }
  const supplyRef = config.supply?.ref ?? 0;
  const atTyp = sweep.current.map((amps) => dc(supplyRef, amps));
  const lineMaxAbsMv = lineError(sweep.current, atTyp) * 1000;
  const knots = fitKnots(sweep.current, atTyp, config.fitV, supplyRef);
  const law: TableLaw = {
    across,
    iSense: config.iSense,
    iAxis: knots,
    vAxis: knots.map((amps) => round9(dc(supplyRef, amps))),
    ...(config.supply
      ? {
          supplyPort: config.supply.port,
          supplyRef: config.supply.ref,
          supplyAffine: config.supply.affine,
        }
      : {}),
  };
  let staticMax = 0;
  for (const supply of sweep.supply) {
    for (const amps of sweep.current) {
      const err = Math.abs(dc(supply, amps) - tableVoltage(law, supply, amps));
      if (err > staticMax) staticMax = err;
    }
  }

  const partType = partTypeOf(config.part, catalog, opts.libraryDir);
  const hash = contentHash(
    describeNetlist(stamp, config.feed?.rSeries ?? 0, feed)
  );
  const bench = benchVersions();
  const scenes = Object.entries(config.cases ?? {}).map(([name, row]) => ({
    name,
    ...row,
  }));
  const runFree = opts.freeRun ?? scenes.length > 0;
  const outPath = opts.outFile ?? snapshotPath(catalog, config.id);
  if (!fixture) throw new Error(`${config.part} capture needs a fixture`);
  const shared = {
    law,
    fixture,
    fixtureRef: config.sweep.fixture ?? config.id,
    config,
    file,
    partType,
    hash,
    bench,
    envelopeMaxA,
    tripA,
  };
  if (!runFree) {
    const quantity = `${across[0]}.voltage`;
    const base = snapshotOf({
      ...shared,
      error: config.staticError
        ? [
            {
              metric: "static-max-abs",
              quantity,
              value: round9(staticMax),
              heldOut: config.heldOut,
              baseline: config.baseline,
            },
          ]
        : "none-available",
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
  const free = await runScenes(scenes, config);
  const worstAbs = Math.max(...free.cases.map((row) => row.maxAbsMv)) / 1000;
  const worstRms = Math.max(...free.cases.map((row) => row.rmsMv)) / 1000;
  const quantity = `${config.through}.voltage`;
  const done = snapshotOf({
    ...shared,
    file,
    error: [
      ...(config.staticError
        ? [
            {
              metric: "static-max-abs" as const,
              quantity,
              value: round9(staticMax),
              heldOut: config.heldOut,
              baseline: config.baseline,
            },
          ]
        : []),
      {
        metric: "free-run-max-abs" as const,
        quantity,
        value: round9(worstAbs),
        heldOut: config.heldOut,
        baseline: config.baseline,
      },
      {
        metric: "free-run-rms" as const,
        quantity,
        value: round9(worstRms),
        heldOut: config.heldOut,
        baseline: config.baseline,
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

function snapshotPath(catalog: string, id: string): string {
  const slash = id.indexOf("/");
  const at = id.lastIndexOf("@");
  const publisher = id.slice(0, slash);
  const name = id.slice(slash + 1, at);
  const version = id.slice(at + 1);
  return join(catalog, "snapshots", publisher, `${name}@${version}.json`);
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
  return lintSnapshot(snap, { plausible: type.plausible, ports: type.ports });
}

function snapshotOf(input: {
  law: TableLaw;
  fixture: FixtureFile;
  fixtureRef: string;
  config: CaptureEntry;
  file: CaptureFile;
  partType: string;
  hash: string;
  bench: { version: string; mujoco: string; avr8js: string };
  envelopeMaxA: number;
  tripA: number;
  error: SnapshotFile["error"];
  quality: SnapshotFile["quality"];
}): SnapshotFile {
  const port = input.law.across[0];
  const supply = input.config.supply;
  const feed = input.config.feed;
  const inputs = [`${port}.current`];
  if (supply) inputs.push(`${supply.port}.voltage`);
  const bounds: Record<string, [number, number]> = {
    [`${input.config.through}.current`]: [
      input.law.iAxis[0] ?? 0,
      input.envelopeMaxA,
    ],
  };
  if (supply && input.config.envelope.supplyVoltage) {
    bounds[`${supply.port}.voltage`] = input.config.envelope.supplyVoltage;
  }
  if (feed && supply) {
    bounds[`${supply.port}.resistance`] = [feed.rSeries, feed.rSeries];
    bounds[`${supply.port}.currentLimit`] = [input.tripA, input.tripA];
  }
  const margin = input.config.envelope.marginA ?? 0;
  return {
    format: SNAPSHOT_FORMAT,
    partType: input.partType,
    part: input.config.part,
    axis: "behaviour",
    form: "table@1",
    ports: { inputs, outputs: [`${port}.voltage`] },
    params: {
      across: [...input.law.across],
      iSense: input.law.iSense,
      iAxis: [...input.law.iAxis],
      vAxis: [...input.law.vAxis],
      ...(input.law.supplyPort ? { supplyPort: input.law.supplyPort } : {}),
      ...(input.law.supplyRef !== undefined
        ? { supplyRef: input.law.supplyRef }
        : {}),
      ...(input.law.supplyAffine !== undefined
        ? { supplyAffine: input.law.supplyAffine }
        : {}),
    },
    envelope: { bounds },
    error: input.error,
    quality: input.quality,
    provenance: {
      source: "captured",
      from: {
        part: input.config.part,
        level: input.config.baseline.level,
        hash: input.hash,
      },
      fixture: {
        ref: input.fixtureRef,
        hash: contentHash(input.fixture),
        seed: input.fixture.seed,
      },
      tool: input.file.tool,
      ...(feed
        ? {
            citations: [
              {
                title: feed.citationTitle,
                ref: `${feed.part} thevenin Ilimit ${input.tripA} A; the envelope stops ${margin} A below that trip`,
              },
            ],
          }
        : {}),
      bench: input.bench,
      created: input.file.created,
    },
  };
}

function writeSnapshot(file: string, snap: SnapshotFile): string {
  mkdirSync(dirname(file), { recursive: true });
  const json = `${JSON.stringify(sortValue(snap), null, 2)}\n`;
  writeFileSync(file, json);
  return json;
}

function readFixture(file: string): FixtureFile {
  const fixture = JSON.parse(readFileSync(file, "utf8")) as FixtureFile;
  if (fixture.format !== FIXTURE_FORMAT) {
    throw new Error(`fixture format ${fixture.format}`);
  }
  return fixture;
}

function sweepsOf(fixture: FixtureFile, entry: CaptureEntry): Sweep {
  const supply = entry.sweep.supplyPort
    ? fixture.sweeps.find(
        (row) =>
          row.port === entry.sweep.supplyPort &&
          row.quantity === entry.sweep.supplyQuantity
      )
    : undefined;
  const current = fixture.sweeps.find(
    (row) =>
      row.port === (entry.sweep.currentPort ?? entry.through) &&
      row.quantity === entry.sweep.currentQuantity
  );
  if (!current) {
    throw new Error(`${entry.part} fixture has no current sweep`);
  }
  return {
    supply: supply?.values ?? (entry.supply ? [entry.supply.ref] : [0]),
    current: current.values,
  };
}

function limitOf(catalog: string, partId: string): number {
  const slash = partId.indexOf("/");
  const at = partId.lastIndexOf("@");
  const file = join(
    catalog,
    "parts",
    partId.slice(0, slash),
    `${partId.slice(slash + 1, at)}@${partId.slice(at + 1)}.json`
  );
  const part = JSON.parse(readFileSync(file, "utf8")) as {
    axes?: {
      behaviour?: Record<
        string,
        {
          variants: Record<
            string,
            { form?: string; params?: { Ilimit?: number } }
          >;
        }
      >;
    };
  };
  for (const slot of Object.values(part.axes?.behaviour ?? {})) {
    for (const variant of Object.values(slot.variants)) {
      if (variant.form === "thevenin-limit@1" && variant.params?.Ilimit) {
        return variant.params.Ilimit;
      }
    }
  }
  throw new Error(`${partId} has no current limit`);
}

function acrossOf(
  entry: CaptureEntry,
  catalog: string,
  libraryDir?: string
): [string, string] {
  if (entry.across && entry.across.length === 2) return entry.across;
  const typeId = partTypeOf(entry.part, catalog, libraryDir);
  const type = JSON.parse(
    readFileSync(join(catalog, "types", `${typeId}.json`), "utf8")
  ) as PartTypeFile;
  const exposed = Object.entries(type.ports)
    .filter(([, decl]) => decl.role !== "ground")
    .map(([name]) => name);
  throw new Error(
    exposed.length >= 2
      ? `${entry.part} has ${exposed.join(" and ")} exposed and no across`
      : `${entry.part} capture entry has no across`
  );
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

function fitKnots(
  current: number[],
  volts: number[],
  fitV: number,
  supplyRef: number
): number[] {
  const knots = [current[0] ?? 0, current[current.length - 1] ?? 0];
  while (knots.length < 40) {
    let worst = -1;
    let worstErr = 0;
    const law = lawFrom(knots, current, volts, supplyRef);
    for (let k = 0; k < current.length; k++) {
      const amps = current[k] ?? 0;
      if (knots.some((knot) => knot === amps)) continue;
      const err = Math.abs(
        (volts[k] ?? 0) - tableVoltage(law, supplyRef, amps)
      );
      if (err > worstErr) {
        worstErr = err;
        worst = k;
      }
    }
    if (worst < 0 || worstErr <= fitV) break;
    knots.push(current[worst] ?? 0);
    knots.sort((a, b) => a - b);
  }
  return knots;
}

function lawFrom(
  knots: number[],
  current: number[],
  volts: number[],
  supplyRef: number
): TableLaw {
  return {
    across: ["p", "m"],
    iSense: 1,
    iAxis: knots,
    vAxis: knots.map((amps) => {
      const at = current.indexOf(amps);
      return volts[at] ?? 0;
    }),
    supplyPort: "supply",
    supplyRef,
    supplyAffine: 1,
  };
}

function round9(n: number): number {
  return Math.round(n * 1e9) / 1e9;
}

type FreeScene = FreeCase & { name: string };

function readCaptureConfig(catalog: string): CaptureFile {
  return JSON.parse(
    readFileSync(join(catalog, "fixtures", "capture.config.json"), "utf8")
  ) as CaptureFile;
}

function scenesOf(entry: CaptureEntry): FreeScene[] {
  return Object.entries(entry.cases ?? {}).map(([name, row]) => ({
    name,
    ...row,
  }));
}

function freeRunEntry(file: CaptureFile): CaptureEntry {
  const entry = file.entries.find((row) => row.freeRun && row.cases);
  if (!entry?.freeRun) throw new Error("capture config has no free-run entry");
  return entry;
}

export type CaptureFreeRun = CaptureCase & {
  /** Last-frame board voltage, volts. */
  voltage1: number;
  voltage2: number;
  /** Last-frame load current, amperes. */
  current1: number;
  current2: number;
};

/** Class 1 against class 2 for the config scenes, with the compare part. Does not write the snapshot. */
export async function compareLoadFreeRun(): Promise<CaptureFreeRun[]> {
  const file = readCaptureConfig(catalogRoot());
  const entry = freeRunEntry(file);
  const skip = new Set(entry.freeRun?.compareSkip ?? []);
  const part = entry.freeRun?.comparePart;
  if (!part) throw new Error(`${entry.id} has no compare part`);
  const scenes = scenesOf(entry)
    .filter((spec) => !skip.has(spec.name))
    .map((spec) => ({ ...spec, load: part }));
  const ran = await runScenes(scenes, entry);
  return ran.cases;
}

async function runScenes(
  specs: readonly FreeScene[],
  entry: CaptureEntry
): Promise<{
  cases: CaptureFreeRun[];
  moveUsPerMs: { class1: number; class2: number };
}> {
  const scene = entry.freeRun;
  if (!scene) throw new Error(`${entry.id} has no free-run scene`);
  const examples = fileURLToPath(
    new URL("../../../examples/", import.meta.url)
  );
  const projectDir = join(examples, scene.project);
  const root = mkdtempSync(join(tmpdir(), "sfab-capture-"));
  const cases: CaptureFreeRun[] = [];
  const moveUsPerMs = { class1: 0, class2: 0 };
  try {
    cpSync(projectDir, root, { recursive: true });
    if (scene.stallFrom && scene.stallDir) {
      const from = join(examples, scene.stallFrom, scene.stallDir);
      mkdirSync(join(root, scene.stallDir), { recursive: true });
      cpSync(join(from, "stall.hex"), join(root, scene.stallDir, "stall.hex"));
      cpSync(join(from, "stall.ino"), join(root, scene.stallDir, "stall.ino"));
    }
    writeStop(root);
    for (const spec of specs) {
      writeScene(root, `${spec.name}-c1`, spec, 1, scene);
      writeScene(root, `${spec.name}-c2`, spec, 2, scene);
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
      const err = voltageError(low.read, high.read, scene.board);
      const end1 = railEnd(low.read, scene);
      const end2 = railEnd(high.read, scene);
      cases.push({
        name: spec.name,
        maxAbsMv: err.maxAbs * 1000,
        rmsMv: err.rms * 1000,
        firstRmsMv: err.first * 1000,
        secondRmsMv: err.second * 1000,
        resets1: low.state.boards[scene.board]?.resets ?? 0,
        resets2: high.state.boards[scene.board]?.resets ?? 0,
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
  high: RecordingRead,
  board: string
): { maxAbs: number; rms: number; first: number; second: number } {
  const n = Math.min(low.frames.length, high.frames.length);
  const err: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = low.frames[i]?.boards[board]?.voltage;
    const b = high.frames[i]?.boards[board]?.voltage;
    if (a === undefined || b === undefined) {
      throw new Error(`missing ${board} voltage at frame ${i}`);
    }
    err.push(a - b);
  }
  if (err.length < 2) {
    throw new Error(`recording has fewer than two ${board} voltage samples`);
  }
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

function railEnd(
  read: RecordingRead,
  scene: FreeRunSpec
): { voltage: number; current: number } {
  const frame = read.frames[read.frames.length - 1];
  const voltage = frame?.boards[scene.board]?.voltage;
  const current = frame?.parts[scene.currentPart]?.current;
  if (voltage === undefined || current === undefined) {
    throw new Error(
      `recording is missing ${scene.board} voltage or ${scene.currentPart} current`
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

/** Free-run scene from the entry. Names and wires are the entry's data. */
function writeScene(
  dir: string,
  name: string,
  spec: FreeScene,
  behaviour: 1 | 2,
  scene: FreeRunSpec
): void {
  const levels =
    behaviour === 2
      ? `"default": 1, "paths": { "${scene.board}": { "behaviour": 2 } }`
      : `"default": 1`;
  const wires = scene.wires
    .map((pair) => JSON.stringify(pair))
    .join(",\n                ");
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
                "${scene.flagInstance}": { "part": "${spec.flag}" },
                "${scene.board}": { "part": "${scene.boardPart}", "params": { "firmware": "${spec.firmware}", "source": "${spec.source}" } },
                "${scene.supplyInstance}": { "part": "${scene.supplyPart}" },
                "${scene.currentPart}": { "part": "${spec.load}" }
              },
              "wires": [
                ${wires}
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
