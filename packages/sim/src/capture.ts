/**
 * Ported from layered-sim E4 (fd10742). Fit one port pair from the capture
 * config and write its snapshot. The DC table and `from.hash` come from
 * that part's stamp. Free-run, when the entry has cases, boots the entry's
 * scene.
 */
import {
  FIXTURE_FORMAT,
  type FixtureFile,
  type PartTypeFile,
  type RecordingRead,
  SNAPSHOT_FORMAT,
  type SnapshotFile,
  type TableLaw,
  type WorldState,
} from "@sfab-bench/contract";
import { tableVoltage } from "@sfab-bench/engine-circuit";
import {
  contentHash,
  lintSnapshot,
  loadPartById,
  type Store,
  sortValue,
} from "@sfab-bench/parts";
import {
  type HingeCaptureEntry,
  writeHingeSnapshot,
} from "./body/hinge-capture";
import { branchDc } from "./branch-dc";
import {
  assemblyStampOf,
  type BoardStamp,
  describeNetlist,
} from "./circuit-stamp";
import type { StampEnv } from "./env";

export type FreeCase = {
  firmware: string;
  source: string;
  flag: string;
  ms: number;
  load: string;
};

export type CaptureFile<E = CaptureEntry> = {
  created: string;
  tool: { name: string; version: string };
  entries: E[];
};

export type AnyCaptureEntry = CaptureEntry | HingeCaptureEntry;

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
  fitV: number;
  baseline: { level: string; value: number };
  heldOut: "fixture" | "use-like" | "both";
  /** Write a static-max-abs row. */
  staticError?: boolean;
  sweep: {
    fixture?: string;
    currentPort?: string;
    currentQuantity?: string;
    current?: number[];
  };
  envelope: { marginA?: number };
  /** Level id that takes the new variant. Absent: the level that holds a snapshot. */
  into?: string;
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
  /** Sweep-end current, amperes. */
  tripA: number;
  /** Envelope current upper bound, amperes. The sweep end. */
  envelopeMaxA: number;
  cases: CaptureCase[];
  moveUsPerMs: { class1: number; class2: number };
  json: string;
};

export type CaptureEnv = {
  store: Store;
  catalogDir(): string;
  examplesDir(): string;
  now(): number;
  readText(file: string): string;
  writeText(file: string, text: string): void;
  join(...parts: string[]): string;
  dirname(file: string): string;
  mkdir(dir: string): void;
  copyTree(from: string, to: string): void;
  copyFile(from: string, to: string): void;
  makeTemp(prefix: string): string;
  removeTree(dir: string): void;
  runWorld(
    project: string,
    world: string,
    ms: number
  ): Promise<{ state: WorldState; read: RecordingRead }>;
  bench(): { version: string; mujoco: string; avr8js: string };
};

export type CaptureRun = {
  /** Overrides the fixture path in the config. The committed Nano capture uses this. */
  fixtureFile?: string;
  config?: CaptureFile<AnyCaptureEntry> | AnyCaptureEntry;
  catalogDir?: string;
  libraryDir?: string;
  /** Where to write. Absent, the fixture id names the catalog snapshot. */
  outFile?: string;
  /** Default true when `config.cases` has scenes. */
  freeRun?: boolean;
  /** Checked between steps; an aborted run throws `CaptureAborted`. */
  signal?: { readonly aborted: boolean };
  onStep?: (done: number, total: number, label: string) => void;
  /**
   * Awaited after each step, so a host can let its event loop run (a
   * socket message such as an abort) inside a long synchronous stretch.
   * The CLI passes none, and the output is the same.
   */
  pause?: () => Promise<void>;
};

export class CaptureAborted extends Error {
  constructor() {
    super("aborted");
  }
}

type Progress = { check(): void; step(label: string): Promise<void> };

function progressOf(opts: CaptureRun, total: number): Progress {
  let done = 0;
  return {
    check() {
      if (opts.signal?.aborted) throw new CaptureAborted();
    },
    async step(label) {
      done += 1;
      opts.onStep?.(done, total, label);
      await opts.pause?.();
    },
  };
}

export async function captureCatalog(
  env: CaptureEnv,
  stamp: StampEnv,
  fixtureFile?: string
): Promise<CaptureStats> {
  return captureFromConfig(
    { ...(fixtureFile ? { fixtureFile } : {}) },
    env,
    stamp
  );
}

/** Every config entry. The returned stats are the entry that has free-run cases. */
export async function captureFromConfig(
  opts: CaptureRun,
  env: CaptureEnv,
  stamp: StampEnv
): Promise<CaptureStats> {
  const catalog = opts.catalogDir ?? env.catalogDir();
  const file = readCaptureFile(catalog, opts.config, env);
  if (opts.outFile && file.entries.length !== 1) {
    throw new Error("outFile needs a single capture entry");
  }
  const stats: CaptureStats[] = [];
  for (const entry of file.entries) {
    stats.push(await captureEntry(entry, file, catalog, opts, env, stamp));
  }
  const ran = stats.find((row) => row.cases.length > 0) ?? stats[0];
  if (!ran) throw new Error("capture config has no entries");
  return ran;
}

function readCaptureFile(
  catalog: string,
  inline: CaptureRun["config"],
  env: CaptureEnv
): CaptureFile<AnyCaptureEntry> {
  if (inline && "entries" in inline) return inline;
  if (inline) {
    return {
      created: "",
      tool: { name: "", version: "" },
      entries: [inline],
    };
  }
  return JSON.parse(
    env.readText(env.join(catalog, "fixtures", "capture.config.json"))
  ) as CaptureFile<AnyCaptureEntry>;
}

async function captureEntry(
  config: AnyCaptureEntry,
  file: CaptureFile<AnyCaptureEntry>,
  catalog: string,
  opts: CaptureRun,
  env: CaptureEnv,
  stampEnv: StampEnv
): Promise<CaptureStats> {
  if ("form" in config) {
    const hinge = progressOf(opts, 1);
    hinge.check();
    await writeHingeSnapshot(
      {
        catalog,
        entry: config,
        created: file.created,
        tool: file.tool,
        bench: benchVersions(env),
        ...(opts.outFile ? { outFile: opts.outFile } : {}),
      },
      env
    );
    await hinge.step("hinge snapshot");
    return {
      staticMaxAbsMv: 0,
      lineMaxAbsMv: 0,
      knots: 0,
      tripA: 0,
      envelopeMaxA: 0,
      cases: [],
      moveUsPerMs: { class1: 0, class2: 0 },
      json: "",
    };
  }
  const across = acrossOf(config, catalog, env, opts.libraryDir);
  const stampOpts = {
    catalogDir: catalog,
    boardId: config.instance,
    ...(opts.libraryDir ? { libraryDir: opts.libraryDir } : {}),
  };
  const stamp = assemblyStampOf(
    config.part,
    config.variant,
    {
      ...stampOpts,
      across,
    },
    stampEnv
  );
  for (const name of [across[0], across[1], config.through]) {
    if (!stamp.portNodes[name]) {
      throw new Error(`${config.part} has no ${name} node`);
    }
  }
  const dc = (amps: number) => branchDc(stamp, across[0], across[1], amps);
  const fixture = config.sweep.fixture
    ? readFixture(
        opts.fixtureFile ??
          env.join(catalog, "fixtures", `${config.sweep.fixture}.fixture.json`),
        env
      )
    : null;
  const sweep = fixture
    ? sweepsOf(fixture, config)
    : { current: config.sweep.current ?? [] };
  const tripA = sweep.current[sweep.current.length - 1] ?? 0;
  const envelopeMaxA = sweep.current[sweep.current.length - 1];
  if (envelopeMaxA === undefined) {
    throw new Error(
      `${config.part} current sweep does not include the envelope end`
    );
  }
  const atTyp = sweep.current.map((amps) => dc(amps));
  const lineMaxAbsMv = lineError(sweep.current, atTyp) * 1000;
  const knots = fitKnots(sweep.current, atTyp, config.fitV);
  const law: TableLaw = {
    across,
    iSense: config.iSense,
    iAxis: knots,
    vAxis: knots.map((amps) => round9(dc(amps))),
  };
  let staticMax = 0;
  for (const amps of sweep.current) {
    const err = Math.abs(dc(amps) - tableVoltage(law, amps));
    if (err > staticMax) staticMax = err;
  }

  const partType = partTypeOf(config.part, catalog, env, opts.libraryDir);
  const hash = contentHash(describeNetlist(stamp, 0, "header"));
  const bench = benchVersions(env);
  const scenes = Object.entries(config.cases ?? {}).map(([name, row]) => ({
    name,
    ...row,
  }));
  const runFree = opts.freeRun ?? scenes.length > 0;
  const outPath = opts.outFile ?? snapshotPath(catalog, config.id, env);
  if (!fixture) throw new Error(`${config.part} capture needs a fixture`);
  const progress = progressOf(opts, 2 + (runFree ? scenes.length * 2 : 0));
  await progress.step(
    `fitted ${knots.length} knots over ${sweep.current.length} sweep points`
  );
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
    const lint = lintBoard(base, partType, catalog, env);
    if (lint.diagnostics.length > 0) {
      throw new Error(
        `snapshot lint ${lint.quality}: ${lint.diagnostics.map((d) => d.message).join("; ")}`
      );
    }
    base.quality = lint.quality;
    progress.check();
    const json = writeSnapshot(outPath, base, env);
    await progress.step("snapshot written");
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
    snapshotOf({ ...shared, error: "none-available", quality: "Q1" }),
    env
  );
  if (!config.freeRun) throw new Error(`${config.id} has no free-run scene`);
  const free = await runScenes(scenes, config.freeRun, env, progress);
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
  const lint = lintBoard(done, partType, catalog, env);
  if (lint.diagnostics.length > 0 || lint.quality !== "Q2a") {
    const text = lint.diagnostics.map((diag) => diag.message).join("; ");
    throw new Error(`snapshot lint ${lint.quality}: ${text}`);
  }
  done.quality = lint.quality;
  progress.check();
  const json = writeSnapshot(outPath, done, env);
  await progress.step("snapshot written");
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

function snapshotPath(catalog: string, id: string, env: CaptureEnv): string {
  const slash = id.indexOf("/");
  const at = id.lastIndexOf("@");
  const publisher = id.slice(0, slash);
  const name = id.slice(slash + 1, at);
  const version = id.slice(at + 1);
  return env.join(catalog, "snapshots", publisher, `${name}@${version}.json`);
}

function partTypeOf(
  partId: string,
  catalog: string,
  env: CaptureEnv,
  libraryDir?: string
): string {
  const worldDir = env.join(catalog, ".board-stamp-world");
  const loaded = loadPartById(
    worldDir,
    {
      store: env.store,
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

function lintBoard(
  snap: SnapshotFile,
  partType: string,
  catalog: string,
  env: CaptureEnv
) {
  const type = JSON.parse(
    env.readText(env.join(catalog, "types", `${partType}.json`))
  ) as PartTypeFile;
  return lintSnapshot(snap, { plausible: type.plausible, ports: type.ports });
}

function snapshotOf(input: {
  law: TableLaw;
  fixture: FixtureFile;
  fixtureRef: string;
  config: CaptureEntry;
  file: Pick<CaptureFile, "created" | "tool">;
  partType: string;
  hash: string;
  bench: { version: string; mujoco: string; avr8js: string };
  envelopeMaxA: number;
  error: SnapshotFile["error"];
  quality: SnapshotFile["quality"];
}): SnapshotFile {
  const port = input.law.across[0];
  const inputs = [`${port}.current`];
  const bounds: Record<string, [number, number]> = {
    [`${input.config.through}.current`]: [
      input.law.iAxis[0] ?? 0,
      input.envelopeMaxA,
    ],
  };
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
      variant: input.config.variant,
      instance: input.config.instance,
      fixture: {
        ref: input.fixtureRef,
        hash: contentHash(input.fixture),
        seed: input.fixture.seed,
      },
      tool: input.file.tool,
      bench: input.bench,
      created: input.file.created,
    },
  };
}

function writeSnapshot(
  file: string,
  snap: SnapshotFile,
  env: CaptureEnv
): string {
  const json = jsonText(sortValue(snap));
  env.writeText(file, json);
  return json;
}

function readFixture(file: string, env: CaptureEnv): FixtureFile {
  const fixture = JSON.parse(env.readText(file)) as FixtureFile;
  if (fixture.format !== FIXTURE_FORMAT) {
    throw new Error(`fixture format ${fixture.format}`);
  }
  return fixture;
}

function sweepsOf(
  fixture: FixtureFile,
  entry: CaptureEntry
): { current: number[] } {
  const current = fixture.sweeps.find(
    (row) =>
      row.port === (entry.sweep.currentPort ?? entry.through) &&
      row.quantity === entry.sweep.currentQuantity
  );
  if (!current) {
    throw new Error(`${entry.part} fixture has no current sweep`);
  }
  return { current: current.values };
}

function acrossOf(
  entry: CaptureEntry,
  catalog: string,
  env: CaptureEnv,
  libraryDir?: string
): [string, string] {
  if (entry.across && entry.across.length === 2) return entry.across;
  const typeId = partTypeOf(entry.part, catalog, env, libraryDir);
  const type = JSON.parse(
    env.readText(env.join(catalog, "types", `${typeId}.json`))
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

function benchVersions(env: CaptureEnv): {
  version: string;
  mujoco: string;
  avr8js: string;
} {
  return env.bench();
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

function fitKnots(current: number[], volts: number[], fitV: number): number[] {
  const knots = [current[0] ?? 0, current[current.length - 1] ?? 0];
  while (knots.length < 40) {
    let worst = -1;
    let worstErr = 0;
    const law = lawFrom(knots, current, volts);
    for (let k = 0; k < current.length; k++) {
      const amps = current[k] ?? 0;
      if (knots.some((knot) => knot === amps)) continue;
      const err = Math.abs((volts[k] ?? 0) - tableVoltage(law, amps));
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
  volts: number[]
): TableLaw {
  return {
    across: ["p", "m"],
    iSense: 1,
    iAxis: knots,
    vAxis: knots.map((amps) => {
      const at = current.indexOf(amps);
      return volts[at] ?? 0;
    }),
  };
}

function round9(n: number): number {
  return Math.round(n * 1e9) / 1e9;
}

type FreeScene = FreeCase & { name: string };

export type CaptureFreeRun = CaptureCase & {
  /** Last-frame board voltage, volts. */
  voltage1: number;
  voltage2: number;
  /** Last-frame load current, amperes. */
  current1: number;
  current2: number;
};

/** Class 1 against class 2 for these scenes. Does not write a snapshot. */
export function runClassScenes(
  scene: FreeRunSpec,
  specs: readonly FreeScene[],
  env: CaptureEnv
): Promise<{
  cases: CaptureFreeRun[];
  moveUsPerMs: { class1: number; class2: number };
}> {
  return runScenes(specs, scene, env);
}

async function runScenes(
  specs: readonly FreeScene[],
  scene: FreeRunSpec,
  env: CaptureEnv,
  progress?: Progress
): Promise<{
  cases: CaptureFreeRun[];
  moveUsPerMs: { class1: number; class2: number };
}> {
  const host = env;
  const examples = host.examplesDir();
  const projectDir = host.join(examples, scene.project);
  const root = host.makeTemp("sfab-capture-");
  const cases: CaptureFreeRun[] = [];
  const moveUsPerMs = { class1: 0, class2: 0 };
  try {
    host.copyTree(projectDir, root);
    if (scene.stallFrom && scene.stallDir) {
      const from = host.join(examples, scene.stallFrom, scene.stallDir);
      host.mkdir(host.join(root, scene.stallDir));
      host.copyFile(
        host.join(from, "stall.hex"),
        host.join(root, scene.stallDir, "stall.hex")
      );
      host.copyFile(
        host.join(from, "stall.ino"),
        host.join(root, scene.stallDir, "stall.ino")
      );
    }
    writeStop(root, env);
    for (const spec of specs) {
      writeScene(root, `${spec.name}-c1`, spec, 1, scene, env);
      writeScene(root, `${spec.name}-c2`, spec, 2, scene, env);
      progress?.check();
      const t1 = host.now();
      const low = await runWorld(
        root,
        `${spec.name}-c1.world.json`,
        spec.ms,
        env
      );
      const wall1 = host.now() - t1;
      await progress?.step(`${spec.name}, class 1`);
      progress?.check();
      const t2 = host.now();
      const high = await runWorld(
        root,
        `${spec.name}-c2.world.json`,
        spec.ms,
        env
      );
      const wall2 = host.now() - t2;
      await progress?.step(`${spec.name}, class 2`);
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
    env.removeTree(root);
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

function runWorld(
  project: string,
  world: string,
  ms: number,
  env: CaptureEnv
): Promise<{ state: WorldState; read: RecordingRead }> {
  return env.runWorld(project, world, ms);
}

function writeStop(dir: string, env: CaptureEnv): void {
  env.writeText(
    env.join(dir, "robot", "flag-stop.urdf"),
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
  env.writeText(
    env.join(dir, "parts", "sfab", "flag-stop@1.0.0.json"),
    jsonText({
      format: "sfab.part@1",
      id: "sfab/flag-stop@1.0.0",
      type: "flag-hinge",
      foreign: false,
      sources: [{ title: "stall stop", ref: "upper limit 0.05 rad" }],
      axes: {
        behaviour: {
          "1": {
            default: "rigid",
            variants: {
              rigid: {
                kind: "form",
                form: "multibody@1",
                params: {},
                omits: ["joint flexibility"],
              },
            },
          },
        },
        body: {
          "1": {
            default: "urdf",
            variants: {
              urdf: {
                kind: "urdf",
                file: "robot/flag-stop.urdf",
                omits: ["link flex"],
              },
            },
          },
        },
        visual: {
          "0": {
            default: "box",
            variants: {
              box: {
                kind: "box",
                size: [0.08, 0.04, 0.02],
                omits: ["link meshes"],
              },
            },
          },
        },
      },
    })
  );
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Free-run scene from the entry. Names and wires are the entry's data. */
function writeScene(
  dir: string,
  name: string,
  spec: FreeScene,
  behaviour: 1 | 2,
  scene: FreeRunSpec,
  env: CaptureEnv
): void {
  const levels =
    behaviour === 2
      ? { default: 1, paths: { [scene.board]: { behaviour: 2 } } }
      : { default: 1 };
  const none = (what: string) => ({
    default: "none",
    variants: { none: { kind: "none", omits: [what] } },
  });
  env.writeText(
    env.join(dir, "parts", "sfab", `${name}-scene@1.0.0.json`),
    jsonText({
      format: "sfab.part@1",
      id: `sfab/${name}-scene@1.0.0`,
      type: "assembly",
      foreign: false,
      axes: {
        behaviour: {
          "2": {
            default: "netlist",
            variants: {
              netlist: {
                kind: "composite",
                omits: ["no snapshot of this assembly"],
                netlist: {
                  instances: {
                    [scene.flagInstance]: { part: spec.flag },
                    [scene.board]: {
                      part: scene.boardPart,
                      params: { firmware: spec.firmware, source: spec.source },
                    },
                    [scene.supplyInstance]: { part: scene.supplyPart },
                    [scene.currentPart]: { part: spec.load },
                  },
                  wires: scene.wires,
                  expose: {},
                },
              },
            },
          },
        },
        body: { "0": none("assembly adds no body") },
        visual: { "0": none("assembly adds no visual") },
      },
    })
  );
  env.writeText(
    env.join(dir, `${name}.world.json`),
    jsonText({
      version: 2,
      environment: { ground: { plane: true }, gravity: [0, 0, -9.81] },
      run: { seed: 1, levels },
      root: { id: "scene", part: `sfab/${name}-scene@1.0.0` },
    })
  );
}
