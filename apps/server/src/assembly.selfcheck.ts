/**
 * Every assembly check in the examples, remeasured (layered-sim unit 6).
 * An assembly check (`sfab.assembly-check@1`, `<project>/checks/…`) is one
 * assembly run twice on its own fixture: every child at its detailed level,
 * and every child that has a snapshot as that snapshot. Its rows state the
 * gap at the named port quantities, read through `Sim.portReading`.
 *
 * The record names its observations (`@sfab-bench/sim/observe`): each
 * quantity at the `frame` cadence (every 10 ms, the measure unit 4 uses for
 * a group) and at the `step` cadence (every master step). The two sides
 * pair at the same instant and each row is a named metric over the pairs
 * (`@sfab-bench/sim/compare`). The `frame` rows keep their first names,
 * `free-run-max-abs` and `free-run-rms`: they are `frame-max` and
 * `frame-rms`, and their numbers have not moved. `step-max` carries the
 * time and both values of its pair.
 *
 * The record also states what each side reported about its own validity
 * (`domain`): envelope excursions, stale and unchecked snapshots, degraded
 * parts. A known excursion stays green; a new or vanished one is red.
 *
 * Nothing here names a part. The record says which document, which two
 * level specs, which snapshots the snapshot side runs and which ports it
 * states. The check fails when:
 *
 * - the document or its lockfile is not the one the record was measured on;
 * - a child snapshot's source no longer hashes to the record's `fromHash`
 *   (the child is stale, so the assembly row is), or the snapshot file
 *   itself no longer hashes to its `hash`;
 * - the detailed side runs any snapshot, or the snapshot side runs a
 *   different set than `children`;
 * - the observations, the metric definitions or the code that takes and
 *   reduces them are not the ones the record names (`identity`);
 * - a recomputed metric sits more than `DRIFT` from its row, or a pair
 *   count moved;
 * - either side's validity differs from the record's `domain`.
 *
 * Pass is "the remeasure matches the stored gap". An acceptance bound per
 * quantity is not stated yet. Any other world, supply, firmware, seed or
 * timestep is unchecked; so is engine code, except through the remeasure.
 * The lockfile is hashed as a file, its pins are not re-resolved.
 *
 * `--write` remeasures and rewrites each record's hashes, identity, rows
 * and domain.
 */

import { ok as expect } from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import type { LevelSpec, SnapshotFile } from "@sfab-bench/contract";
import { contentHash, parsePartRef, sha256Bytes } from "@sfab-bench/parts";
import {
  comparisonIdentity,
  type MetricName,
  metricsFor,
  pairByKey,
  reduce,
  validityDiff,
} from "@sfab-bench/sim/compare";
import { provenanceHash } from "@sfab-bench/sim/freshness";
import {
  type Cadence,
  checkDescriptor,
  describe,
  descriptorId,
  type ObservationDescriptor,
  type ObservedRun,
  observeRun,
  type Validity,
} from "@sfab-bench/sim/observe";
import { Sim } from "@sfab-bench/sim/sim";
import { observerBuild } from "./observer-build";
import { projectReal, readerFor, readInside } from "./world/files";
import { packageVersion } from "./world/package-version";
import { nodePlanEnv, nodeStampEnv } from "./world/plan-host";

const catalog = fileURLToPath(new URL("../catalog/", import.meta.url));
const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));
const FORMAT = "sfab.assembly-check@1";
/** How far a recomputed gap may sit from its row, relative (unit 4's). */
const DRIFT = 1e-4;
const write = process.argv.includes("--write");

type Levels = { default: LevelSpec; paths?: Record<string, LevelSpec> };

type Child = {
  path: string;
  axis: string;
  ref: string;
  hash: string;
  fromHash: string;
};

/** The cadences each quantity is observed at. */
const CADENCES: Cadence[] = ["frame", "step"];

/** The `frame` metrics' first names, kept so their rows do not move. */
const FIRST_NAMES: Partial<Record<MetricName, string>> = {
  "frame-max": "free-run-max-abs",
  "frame-rms": "free-run-rms",
};

type Row = {
  metric: string;
  quantity: string;
  value: number;
  heldOut: "fixture";
  baseline: "detailed";
  /** Paired observations. Absent on the `frame` rows' first form. */
  pairs?: number;
  /** Observations with no counterpart on the other side. */
  unmatched?: number;
  /** The pair that set a `-max` metric. */
  at?: { ms: number; detailed: number; snapshot: number };
};

type AssemblyCheck = {
  format: string;
  document: string;
  fixture: { ms: number; hash: string; lock: string };
  detailed: Levels;
  snapshot: Levels;
  children: Child[];
  quantities: string[];
  observations?: ObservationDescriptor[];
  identity?: string;
  error: Row[];
  domain?: { detailed: Validity; snapshot: Validity };
};

type Side = ObservedRun & {
  snapshots: { path: string; axis: string; ref: string }[];
};

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function jsonUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((ent) => {
      const at = join(dir, ent.name);
      if (ent.isDirectory()) return jsonUnder(at);
      return ent.name.endsWith(".json") ? [at] : [];
    });
}

/** Every assembly check in the examples, with its project. */
function records(): { project: string; file: string }[] {
  return readdirSync(examples)
    .sort()
    .flatMap((project) =>
      jsonUnder(join(examples, project, "checks"))
        .filter((file) => readJson<{ format?: string }>(file).format === FORMAT)
        .map((file) => ({ project, file }))
    );
}

function newSim(): Sim {
  return new Sim({
    post() {},
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
}

/** The document with `levels` as its play levels; returns its file. */
function writeSide(
  root: string,
  document: string,
  name: string,
  levels: Levels
): string {
  const file = readJson<{ id: string; play: { levels?: Levels } }>(
    join(root, document)
  );
  const ref = parsePartRef(file.id);
  if (!ref) throw new Error(`${document}: no part id`);
  file.id = `${ref.publisher}/${name}@${ref.version}`;
  file.play.levels = levels;
  const rel = `parts/${ref.publisher}/${name}@${ref.version}.json`;
  writeFileSync(join(root, rel), JSON.stringify(file));
  return rel;
}

async function runSide(
  root: string,
  world: string,
  observations: ObservationDescriptor[],
  ms: number
): Promise<Side> {
  const sim = newSim();
  try {
    const loaded = await sim.load({ project: root, world, generation: 1 });
    if (!loaded.ok) {
      throw new Error(loaded.errors.map((row) => row.message).join("; "));
    }
    const observed = await observeRun(sim, observations, ms).catch(
      (err: unknown) => {
        throw new Error(`${world}: ${String(err)}`);
      }
    );
    const snapshots = (sim.report()?.snapshots ?? [])
      .map((row) => ({ path: row.path, axis: row.axis, ref: row.ref }))
      .sort((a, b) =>
        `${a.path} ${a.axis}`.localeCompare(`${b.path} ${b.axis}`)
      );
    return { ...observed, snapshots };
  } finally {
    sim.dispose();
  }
}

/** The snapshot file `ref`: the project's own, then the catalog's. */
function snapshotOf(project: string, ref: string): SnapshotFile {
  const parsed = parsePartRef(ref);
  if (!parsed) throw new Error(`${ref}: not a snapshot id`);
  const rel = join(
    "snapshots",
    parsed.publisher,
    `${parsed.name}@${parsed.version}.json`
  );
  const own = join(project, rel);
  return readJson<SnapshotFile>(existsSync(own) ? own : join(catalog, rel));
}

/** The source hash a child snapshot has today, or why it has none. */
function sourceHash(project: string, ref: string): string {
  const fresh = provenanceHash(
    snapshotOf(project, ref),
    { catalogDir: catalog, worldDir: project },
    nodeStampEnv
  );
  if (!fresh.checked) throw new Error(`${ref}: ${fresh.reason}`);
  return fresh.hash;
}

function fixtureOf(project: string, document: string) {
  const lock = join(project, document.replace(/\.json$/, ".lock.json"));
  return {
    hash: contentHash(readJson<unknown>(join(project, document))),
    lock: contentHash(readJson<unknown>(lock)),
  };
}

const found = records();
expect(found.length > 0, "the examples have an assembly check");
const observer = observerBuild();
const temps: string[] = [];
try {
  for (const { project, file } of found) {
    const record = readJson<AssemblyCheck>(file);
    const dir = join(examples, project);
    const at = `${project}/${record.document}`;
    const fixture = fixtureOf(dir, record.document);
    const observations = write
      ? record.quantities.flatMap((quantity) =>
          CADENCES.map((cadence) => describe(quantity, cadence))
        )
      : (record.observations ?? []);
    const identity = comparisonIdentity(observations, observer);
    if (!write) {
      expect(
        fixture.hash === record.fixture.hash &&
          fixture.lock === record.fixture.lock,
        `${at}: the document or its lock changed since the record was measured`
      );
      for (const child of record.children) {
        const file = contentHash(snapshotOf(dir, child.ref));
        expect(
          file === child.hash,
          `${at}: ${child.path} ${child.ref} changed since the record was measured (${file} vs ${child.hash})`
        );
        const now = sourceHash(dir, child.ref);
        expect(
          now === child.fromHash,
          `${at}: ${child.path} ${child.ref} is stale (${now} vs ${child.fromHash})`
        );
      }
      expect(
        observations.length > 0,
        `${at}: the record names no observations; remeasure`
      );
      for (const row of observations) checkDescriptor(row);
      expect(
        identity === record.identity,
        `${at}: the observations, a metric definition or the observer code changed since the record was measured (${identity} vs ${String(record.identity)}); remeasure and state why`
      );
    }

    const root = mkdtempSync(join(tmpdir(), "sfab-assembly-"));
    temps.push(root);
    cpSync(dir, root, { recursive: true });
    const ms = record.fixture.ms;
    const a = await runSide(
      root,
      writeSide(root, record.document, "assembly-detailed", record.detailed),
      observations,
      ms
    );
    const b = await runSide(
      root,
      writeSide(root, record.document, "assembly-snapshot", record.snapshot),
      observations,
      ms
    );
    expect(
      a.snapshots.length === 0,
      `${at}: the detailed side runs ${JSON.stringify(a.snapshots)}`
    );
    const named = record.children
      .map(({ path, axis, ref }) => ({ path, axis, ref }))
      .sort((x, y) =>
        `${x.path} ${x.axis}`.localeCompare(`${y.path} ${y.axis}`)
      );
    expect(
      write || JSON.stringify(b.snapshots) === JSON.stringify(named),
      `${at}: the snapshot side runs ${JSON.stringify(b.snapshots)}, the record names ${JSON.stringify(named)}`
    );
    console.log(
      `assembly: ${at}, ${ms} ms; snapshot side runs ${b.snapshots.map((row) => `${row.path} ${row.ref}`).join(", ")}`
    );

    const rows: Row[] = [];
    for (const descriptor of observations) {
      const id = descriptorId(descriptor);
      const paired = pairByKey(a.series.get(id) ?? [], b.series.get(id) ?? []);
      // Both sides run one document, so every frame and step pairs.
      expect(
        descriptor.cadence === "events" || paired.unmatched.length === 0,
        `${at}: ${id} has ${paired.unmatched.length} samples on one side only`
      );
      const said: string[] = [];
      for (const metric of metricsFor(descriptor.cadence)) {
        const got = reduce(metric, paired.pairs);
        expect(got || write, `${at}: ${id} has no pairs for ${metric}`);
        if (!got) continue;
        said.push(`${metric} ${got.value.toPrecision(6)}`);
        const first = FIRST_NAMES[metric];
        const row: Row = {
          metric: first ?? metric,
          quantity: descriptor.quantity,
          value: Number(got.value.toPrecision(10)),
          heldOut: "fixture",
          baseline: "detailed",
          ...(first
            ? {}
            : { pairs: got.pairs, unmatched: paired.unmatched.length }),
          ...(got.at && !first
            ? {
                at: {
                  ms: got.at.ms,
                  detailed: Number(got.at.a.toPrecision(10)),
                  snapshot: Number(got.at.b.toPrecision(10)),
                },
              }
            : {}),
        };
        rows.push(row);
        if (write) continue;
        const stored = record.error.find(
          (item) => item.metric === row.metric && item.quantity === row.quantity
        );
        expect(stored, `${at}: no ${row.metric} row for ${row.quantity}`);
        if (!stored) continue;
        const drift =
          (got.value - stored.value) / Math.max(Math.abs(stored.value), 1e-12);
        expect(
          Math.abs(drift) <= DRIFT,
          `${at}: ${row.quantity} ${row.metric} ${got.value} vs the stated ${stored.value} (${drift.toExponential(2)})`
        );
        expect(
          stored.pairs === row.pairs && stored.unmatched === row.unmatched,
          `${at}: ${row.quantity} ${row.metric} pairs ${row.pairs}/${row.unmatched} unmatched vs the stated ${stored.pairs}/${stored.unmatched}`
        );
      }
      console.log(`  ${id}: ${said.join(", ")}`);
    }
    if (!write) {
      const extra = record.error.filter(
        (item) =>
          !rows.some(
            (row) =>
              row.metric === item.metric && row.quantity === item.quantity
          )
      );
      expect(
        extra.length === 0,
        `${at}: rows no observation measures: ${JSON.stringify(extra)}`
      );
    }
    const domain = { detailed: a.validity, snapshot: b.validity };
    for (const side of ["detailed", "snapshot"] as const) {
      for (const row of domain[side].envelope) {
        console.log(
          `  ${side}: ${row.path} ${row.port} ${row.quantity} outside ${row.ref}'s envelope ${row.range}`
        );
      }
      if (write) continue;
      const moved = record.domain
        ? validityDiff(record.domain[side], domain[side])
        : ["the record states no domain"];
      expect(
        moved.length === 0,
        `${at}: the ${side} side's validity moved: ${moved.join("; ")}`
      );
    }
    if (write) {
      const next: AssemblyCheck = {
        ...record,
        fixture: { ms, ...fixture },
        children: b.snapshots.map((row) => ({
          ...row,
          hash: contentHash(snapshotOf(dir, row.ref)),
          fromHash: sourceHash(dir, row.ref),
        })),
        observations,
        identity,
        error: rows,
        domain,
      };
      writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
      console.log(`  wrote ${file}`);
    }
  }
} finally {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
}

console.log(`assembly.selfcheck ok (${found.length} assembly checks)`);
