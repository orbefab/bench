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
import {
  Diode,
  type DiodeParams,
  Engine,
  ISource,
  tableVoltage,
  thermalVoltage,
} from "@sfab-bench/engine-circuit";
import {
  contentHash,
  lintSnapshot,
  type Store,
  sortValue,
} from "@sfab-bench/parts";
import {
  type HingeCaptureEntry,
  writeHingeSnapshot,
} from "./body/hinge-capture";
import { branchDc } from "./branch-dc";
import { acrossFor, captureProblem, currentSweep } from "./capture-recipe";
import { stampSignature } from "./capture-signature";
import {
  type CaptureSource,
  captureSource,
  readFixtureFile,
} from "./capture-source";
import { assemblyStampOf, type BoardStamp } from "./circuit-stamp";
import type { StampEnv } from "./env";
import { type GroupCaptureEntry, writeGroupSnapshot } from "./group-capture";
import type { PlanResult } from "./plan";

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

export type AnyCaptureEntry =
  | CaptureEntry
  | HingeCaptureEntry
  | GroupCaptureEntry;

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
  /** Write this two-port law, fitted to the sweep, instead of a table. */
  fit?: "diode@1";
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
  /** The run plan of a world, for a group capture's reduction. */
  plan(project: string, world: string): PlanResult;
};

export type CaptureRun = {
  /** Overrides the fixture path in the config. The committed Nano capture uses this. */
  fixtureFile?: string;
  config?: CaptureFile<AnyCaptureEntry> | AnyCaptureEntry;
  catalogDir?: string;
  /**
   * The project the capture reads its source from, before the catalog:
   * parts, types and fixtures. Absent, the catalog alone.
   */
  projectDir?: string;
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

/** A snapshot capture that is not a table writes no table stats. */
function emptyStats(): CaptureStats {
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
  const projected = captureSource(catalog, opts.projectDir, env);
  const source = opts.fixtureFile
    ? withFixture(projected, opts.fixtureFile)
    : projected;
  const problem = captureProblem(config, source);
  if (problem) throw new Error(problem);
  if ("scene" in config) {
    const group = progressOf(opts, 1);
    group.check();
    await writeGroupSnapshot(
      {
        catalog,
        source,
        entry: config,
        created: file.created,
        tool: file.tool,
        bench: benchVersions(env),
        ...(opts.outFile ? { outFile: opts.outFile } : {}),
      },
      env
    );
    await group.step("group snapshot");
    return emptyStats();
  }
  if ("form" in config) {
    const hinge = progressOf(opts, 1);
    hinge.check();
    await writeHingeSnapshot(
      {
        catalog,
        source,
        entry: config,
        created: file.created,
        tool: file.tool,
        bench: benchVersions(env),
        ...(opts.outFile ? { outFile: opts.outFile } : {}),
      },
      env
    );
    await hinge.step("hinge snapshot");
    return emptyStats();
  }
  const across = acrossFor(config, typeOfPart(config.part, source));
  if (typeof across === "string") throw new Error(across);
  const stamp = assemblyStampOf(
    config.part,
    config.variant,
    {
      catalogDir: catalog,
      worldDir: source.worldDir,
      assetRoot: source.worldDir,
      boardId: config.instance,
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
    ? fixtureOf(source, config.sweep.fixture)
    : null;
  const sweep = fixture
    ? { current: sweepOf(fixture, config) }
    : { current: config.sweep.current ?? [] };
  const tripA = sweep.current[sweep.current.length - 1] ?? 0;
  const envelopeMaxA = sweep.current[sweep.current.length - 1];
  if (envelopeMaxA === undefined) {
    throw new Error(
      `${config.part} current sweep does not include the envelope end`
    );
  }
  const atTyp = sweep.current.map((amps) => dc(amps));
  monotone(config.part, sweep.current, atTyp);
  const fitted =
    config.fit === "diode@1" ? fitDiode(sweep.current, atTyp) : null;
  const lineMaxAbsMv = lineError(sweep.current, atTyp) * 1000;
  const knots = fitKnots(sweep.current, atTyp, config.fitV);
  const law: TableLaw = {
    across,
    iSense: config.iSense,
    iAxis: knots,
    vAxis: knots.map((amps) => round9(dc(amps))),
  };
  const staticMax = maxBetween(sweep.current, (amps) =>
    Math.abs(
      dc(amps) - (fitted ? diodeDc(fitted, amps) : tableVoltage(law, amps))
    )
  );

  const type = typeOfPart(config.part, source);
  const hash = stampSignature(stamp, {
    level: config.baseline.level,
    variant: config.variant,
  });
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
    partType: type.id,
    hash,
    bench,
    envelopeMaxA,
    ...(fitted ? { fitted } : {}),
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
    const lint = lintBoard(base, type);
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
  const lint = lintBoard(done, type);
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

/** The part's type as the source reads it: the project's, else the catalog's. */
function typeOfPart(partId: string, source: CaptureSource): PartTypeFile {
  const found = source.part(partId);
  if (!found) throw new Error(`${partId} did not load`);
  const type = source.typeOf(found.part);
  if (!type) throw new Error(`${partId} type did not load`);
  return type;
}
/** The source with one fixture file in place of the one it would read. */
function withFixture(source: CaptureSource, file: string): CaptureSource {
  return {
    ...source,
    fixture: () => file,
    readFixture: (id) => readFixtureFile(source.store, file, id),
  };
}
function lintBoard(snap: SnapshotFile, type: PartTypeFile) {
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
  /** A `diode@1` fitted to the sweep, written in place of the table. */
  fitted?: FittedDiode;
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
    ports: { inputs, outputs: [`${port}.voltage`] },
    ...(input.fitted
      ? {
          form: "diode@1" as const,
          // `across` is the swept pair; the stale check stamps it again.
          params: { ...input.fitted, across: [...input.law.across] },
          bind: { A: input.law.across[0], K: input.law.across[1] },
        }
      : {
          form: "table@1" as const,
          params: {
            across: [...input.law.across],
            iSense: input.law.iSense,
            iAxis: [...input.law.iAxis],
            vAxis: [...input.law.vAxis],
          },
        }),
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

function fixtureOf(source: CaptureSource, id: string): FixtureFile {
  const fixture = source.readFixture(id);
  if (typeof fixture === "string") throw new Error(fixture);
  return fixture;
}

function sweepOf(fixture: FixtureFile, entry: CaptureEntry): number[] {
  const current = currentSweep(fixture, entry);
  if (typeof current === "string") throw new Error(current);
  return current;
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

type FittedDiode = Pick<DiodeParams, "Is" | "N" | "Rs">;

/** A two-port DC sweep moves one way: a passive branch never folds back. */
function monotone(part: string, current: number[], volts: number[]): void {
  let up = false;
  let down = false;
  for (let k = 1; k < volts.length; k++) {
    const step = (volts[k] ?? 0) - (volts[k - 1] ?? 0);
    if (step > 0) up = true;
    if (step < 0) down = true;
    if (up && down) {
      throw new Error(
        `${part}: the drop turns back between ${current[k - 1]} A and ${current[k]} A`
      );
    }
  }
}

/**
 * `diode@1` from a forward sweep: `V = N·Vt·ln(I/Is) + Rs·I` is linear in
 * `N·Vt`, `−N·Vt·ln Is` and `Rs`, so least squares over the points above
 * 0 A. The `+1` inside the log is below 1e-10 of `I/Is` there.
 */
function fitDiode(current: number[], volts: number[]): FittedDiode {
  const rows = current
    .map((amps, k) => [amps, volts[k] ?? Number.NaN] as const)
    .filter(([amps]) => amps > 0);
  if (rows.length < 3) {
    throw new Error("a diode fit needs three sweep points above 0 A");
  }
  const scale = Math.max(...rows.map(([amps]) => amps));
  const ata = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const atb = [0, 0, 0];
  for (const [amps, v] of rows) {
    const f = [Math.log(amps), 1, amps / scale];
    for (let i = 0; i < 3; i++) {
      atb[i] = (atb[i] ?? 0) + (f[i] ?? 0) * v;
      for (let j = 0; j < 3; j++) {
        const row = ata[i] as number[];
        row[j] = (row[j] ?? 0) + (f[i] ?? 0) * (f[j] ?? 0);
      }
    }
  }
  const [a, b, rScaled] = solve3(ata, atb);
  const Rs = rScaled / scale;
  // A junction's N is about 1 or more. Far below that the sweep has no
  // knee (a resistor fits with N near 0), and the law would claim blocking.
  if (!(a / thermalVoltage(25) >= 0.5) || !(Rs >= 0)) {
    throw new Error(`the sweep is not a forward diode (N·Vt ${a}, Rs ${Rs})`);
  }
  const fit = {
    Is: round12(Math.exp(-b / a)),
    N: round12(a / thermalVoltage(25)),
    Rs: round12(Rs),
  };
  return fit;
}

function solve3(m: number[][], v: number[]): [number, number, number] {
  const a = m.map((row, i) => [...row, v[i] ?? 0]);
  for (let c = 0; c < 3; c++) {
    let pivot = c;
    for (let r = c + 1; r < 3; r++) {
      if (Math.abs(a[r]?.[c] ?? 0) > Math.abs(a[pivot]?.[c] ?? 0)) pivot = r;
    }
    [a[c], a[pivot]] = [a[pivot] as number[], a[c] as number[]];
    const top = a[c] as number[];
    for (let r = c + 1; r < 3; r++) {
      const row = a[r] as number[];
      const k = (row[c] ?? 0) / (top[c] ?? 1);
      for (let j = c; j < 4; j++) row[j] = (row[j] ?? 0) - k * (top[j] ?? 0);
    }
  }
  const x = [0, 0, 0];
  for (let r = 2; r >= 0; r--) {
    const row = a[r] as number[];
    let sum = row[3] ?? 0;
    for (let j = r + 1; j < 3; j++) sum -= (row[j] ?? 0) * (x[j] ?? 0);
    x[r] = sum / (row[r] ?? 1);
  }
  return [x[0] ?? 0, x[1] ?? 0, x[2] ?? 0];
}

/** The fitted law's drop, solved by the same engine the run uses. */
function diodeDc(fit: FittedDiode, amps: number): number {
  const engine = new Engine(
    [
      new Diode("d", "a", "0", { ...fit, tempC: 25 }),
      new ISource("is", "0", "a", { kind: "dc", value: amps }),
    ],
    { method: "be", h: 1e-3, atol: 1e-14, rtol: 1e-12 }
  );
  engine.operatingPoint();
  return engine.voltage("a");
}

function round12(n: number): number {
  return Number(n.toPrecision(12));
}

/**
 * The largest `err` over the sweep: what a `static-max-abs` row states. The
 * knots are sweep points, so the error that matters is between them. Each
 * interval is sampled at 32 steps, plus a halving ladder when it starts at
 * 0 A, where a diode knee sits; every local peak among the samples is then
 * refined between its neighbours. A peak narrower than the sample spacing can
 * still be missed; snapshot-holdout.selfcheck re-checks on its own grid.
 */
function maxBetween(
  current: readonly number[],
  err: (amps: number) => number
): number {
  let worst = 0;
  for (let k = 0; k + 1 < current.length; k++) {
    const lo = current[k] ?? 0;
    const hi = current[k + 1] ?? 0;
    const points = new Set([lo, hi]);
    for (let j = 1; j < 32; j++) points.add(lo + ((hi - lo) * j) / 32);
    if (lo === 0) for (let j = 1; j <= 12; j++) points.add(hi / 2 ** j);
    // From 0 A the search stays above the ladder's last point: below a few
    // nA the class-2 solve has no answer to compare (C1).
    const floor = lo === 0 ? hi / 2 ** 12 : lo;
    const sorted = [...points].sort((a, b) => a - b);
    const errs = sorted.map(err);
    for (let i = 0; i < errs.length; i++) {
      const here = errs[i] ?? 0;
      worst = Math.max(worst, here);
      if (here < (errs[i - 1] ?? 0) || here < (errs[i + 1] ?? 0)) continue;
      const around = goldenMax(
        err,
        Math.max(sorted[Math.max(i - 1, 0)] ?? lo, floor),
        sorted[Math.min(i + 1, sorted.length - 1)] ?? hi
      );
      worst = Math.max(worst, around);
    }
  }
  return worst;
}

/**
 * The maximum of `f` on `[a, b]` by golden-section search, when `f` has one
 * peak there. With more than one it returns one of them, not necessarily the
 * largest.
 */
function goldenMax(f: (x: number) => number, a: number, b: number): number {
  const r = (Math.sqrt(5) - 1) / 2;
  let lo = a;
  let hi = b;
  let c = hi - r * (hi - lo);
  let d = lo + r * (hi - lo);
  let fc = f(c);
  let fd = f(d);
  for (let i = 0; i < 40; i++) {
    if (fc > fd) {
      hi = d;
      d = c;
      fd = fc;
      c = hi - r * (hi - lo);
      fc = f(c);
    } else {
      lo = c;
      c = d;
      fc = fd;
      d = lo + r * (hi - lo);
      fd = f(d);
    }
  }
  return Math.max(fc, fd);
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
