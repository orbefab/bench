/**
 * Every assembly check in the examples, remeasured and judged (layered-sim
 * unit 6; run 7 units 3a and 3b). An assembly check
 * (`sfab.assembly-check@2`, `<project>/checks/…`) is one assembly run twice
 * on its own fixture: every child at its detailed level (side a, the
 * source), and every child that has a snapshot as that snapshot (side b).
 *
 * Each stated quantity is observed at the `frame` cadence (every 10 ms)
 * and the `step` cadence (every master step), and the two sides pair at
 * the same instant (`@sfab-bench/sim/observe`, `@sfab-bench/sim/compare`).
 * Its row holds the named metrics over every pair: `frame-max` and
 * `frame-rms` (the numbers `@1` called `free-run-max-abs` and
 * `free-run-rms`), and `step-max`, with its time and both values, and
 * `step-rms`.
 *
 * Each resolution the quantity's instance states for that field at that
 * port is one criterion on the row (`criteriaFor`). A precision is judged
 * by `settled-max` over the pairs its conditions qualify (`steady@1` on
 * side a); a reader by `event-max` over its conversions. A criterion
 * stores its threshold and where it came from, its coverage (qualified
 * pairs, and the rest by reason) and its verdict: `within`, `over` by how
 * much, or `none` with the reason. A quantity no resolution covers has no
 * criterion, and its row says `none`, "no resolution".
 *
 * The record also states what each side reported about its own validity
 * (`domain`), and `inDomain`: no snapshot ran outside its envelope, stale
 * or unchecked. A verdict on a run out of domain is still stated, and
 * the record says both.
 *
 * Nothing here names a part. The check is green only when all four of the
 * plan's checks pass (run 7 § 7). They are independent: a `none` verdict
 * never exempts a row from reproduction.
 *
 * - Identity: the document, its lock and each child snapshot are the ones
 *   measured (`fixture`, `children`); the observations, the metric
 *   definitions and the observer code are (`identity`); and so are the
 *   criteria and the settle predicate (`policy`).
 * - Reproduction: every stored metric of every row and criterion sits
 *   within `DRIFT` (`assembly-check.ts`) of its re-measure, with the same pair counts, and a max
 *   is set at the same time between the same values.
 * - Domain: each side's validity equals `domain`.
 * - Applicability and verdict: each criterion's threshold, coverage and
 *   verdict equal the stored ones. Within to over, over to within, either
 *   to `none` and back are all red.
 *
 * Any other world, supply, firmware, seed or timestep is unchecked; so is
 * engine code, except through the remeasure. The lockfile is hashed as a
 * file, its pins are not re-resolved.
 *
 * `--write` remeasures and rewrites each record, reading an `@1` record's
 * levels and quantities.
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
import {
  contentHash,
  type LiveInstance,
  loadWorldV2,
  parsePartRef,
  sha256Bytes,
} from "@sfab-bench/parts";
import {
  type Criterion,
  comparisonIdentity,
  criteriaFor,
  descriptorFor,
  judge,
  metricsFor,
  type Paired,
  pairByKey,
  policyIdentity,
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
import {
  criterionRow,
  metricRow,
  type QuantityRow,
  rowProblems,
} from "./assembly-check";
import { observerBuild } from "./observer-build";
import { projectReal, readerFor, readInside } from "./world/files";
import { nodeStore } from "./world/node-store";
import { packageVersion } from "./world/package-version";
import { nodePlanEnv, nodeStampEnv } from "./world/plan-host";

const catalog = fileURLToPath(new URL("../catalog/", import.meta.url));
const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));
const FORMAT = "sfab.assembly-check@2";
/** The first format: its levels and quantities seed a `--write`. */
const FIRST_FORMAT = "sfab.assembly-check@1";
const write = process.argv.includes("--write");

type Levels = { default: LevelSpec; paths?: Record<string, LevelSpec> };

type Child = {
  path: string;
  axis: string;
  ref: string;
  hash: string;
  fromHash: string;
};

/** The cadences each stated quantity is observed at. */
const CADENCES: Cadence[] = ["frame", "step"];

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
  policy?: string;
  rows?: QuantityRow[];
  domain?: { detailed: Validity; snapshot: Validity };
  inDomain?: boolean;
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
        .filter((file) => {
          const format = readJson<{ format?: string }>(file).format;
          return format === FORMAT || (write && format === FIRST_FORMAT);
        })
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

/** The instances `world` resolves to, as the loader reads them. */
function instancesOf(root: string, world: string): LiveInstance[] {
  return loadWorldV2(join(root, world), {
    store: nodeStore,
    catalogDir: catalog,
    assetRoot: root,
  }).resolved;
}

/**
 * The stated quantities at every cadence, and each criterion's own
 * observation. One descriptor read twice keeps one copy, with the union of
 * the quantities read beside it.
 */
function descriptorsFor(
  quantities: readonly string[],
  criteria: readonly Criterion[]
): ObservationDescriptor[] {
  const out = new Map<string, ObservationDescriptor>();
  const add = (row: ObservationDescriptor) => {
    const id = descriptorId(row);
    const was = out.get(id);
    if (!was) {
      out.set(id, row);
      return;
    }
    const read = [...(was.with ?? []), ...(row.with ?? [])];
    out.set(id, describe(row.quantity, row.cadence, row.reference, read));
  };
  for (const quantity of quantities) {
    for (const cadence of CADENCES) add(describe(quantity, cadence));
  }
  for (const criterion of criteria) add(descriptorFor(criterion));
  return [...out.values()];
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
    }

    const root = mkdtempSync(join(tmpdir(), "sfab-assembly-"));
    temps.push(root);
    cpSync(dir, root, { recursive: true });
    const ms = record.fixture.ms;
    const detailedWorld = writeSide(
      root,
      record.document,
      "assembly-detailed",
      record.detailed
    );
    const snapshotWorld = writeSide(
      root,
      record.document,
      "assembly-snapshot",
      record.snapshot
    );
    // Side a is the source: its instances say what judges each quantity.
    const instances = instancesOf(root, detailedWorld);
    const criteria = record.quantities.flatMap((quantity) =>
      criteriaFor(instances, quantity)
    );
    const policy = policyIdentity(criteria);
    const observations = write
      ? descriptorsFor(record.quantities, criteria)
      : (record.observations ?? []);
    const identity = comparisonIdentity(observations, observer);
    if (!write) {
      expect(
        observations.length > 0,
        `${at}: the record names no observations; remeasure`
      );
      for (const row of observations) checkDescriptor(row);
      expect(
        identity === record.identity,
        `${at}: the observations, a metric definition or the observer code changed since the record was measured (${identity} vs ${String(record.identity)}); remeasure and state why`
      );
      expect(
        policy === record.policy,
        `${at}: a resolution or the settle predicate changed since the record was measured (${policy} vs ${String(record.policy)}); remeasure and state why`
      );
    }

    const a = await runSide(root, detailedWorld, observations, ms);
    const b = await runSide(root, snapshotWorld, observations, ms);
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

    const domain = { detailed: a.validity, snapshot: b.validity };
    const inDomain = (["detailed", "snapshot"] as const).every(
      (side) =>
        domain[side].envelope.length === 0 &&
        domain[side].stale.length === 0 &&
        domain[side].unchecked.length === 0
    );
    const paired = new Map<string, Paired>();
    const pairsOf = (row: ObservationDescriptor): Paired => {
      const id = descriptorId(row);
      let found = paired.get(id);
      if (!found) {
        found = pairByKey(a.series.get(id) ?? [], b.series.get(id) ?? []);
        paired.set(id, found);
      }
      return found;
    };
    const rows: QuantityRow[] = [];
    for (const quantity of record.quantities) {
      const metrics: QuantityRow["metrics"] = [];
      for (const cadence of CADENCES) {
        const row = describe(quantity, cadence);
        const pairs = pairsOf(row);
        // Both sides run one document, so every frame and step pairs.
        expect(
          pairs.unmatched.length === 0 && pairs.excluded.length === 0,
          `${at}: ${descriptorId(row)} has ${pairs.unmatched.length} samples on one side only and ${pairs.excluded.length} excluded`
        );
        for (const metric of metricsFor(cadence)) {
          const got = reduce(metric, pairs.pairs);
          expect(got, `${at}: ${quantity} has no pairs for ${metric}`);
          if (got) {
            metrics.push({
              ...metricRow(metric, got),
              unmatched: pairs.unmatched.length,
            });
          }
        }
      }
      const judged = criteria
        .filter((row) => row.quantity === quantity)
        .map((criterion) => {
          const row = descriptorFor(criterion);
          const id = descriptorId(row);
          const source = a.series.get(id) ?? [];
          const stepMs = (source[1]?.ms ?? 0) - (source[0]?.ms ?? 0);
          return criterionRow(
            criterion,
            judge(criterion, pairsOf(row), source, ms, stepMs)
          );
        });
      rows.push({
        quantity,
        metrics,
        criteria: judged,
        ...(judged.length === 0
          ? { verdict: "none" as const, reason: "no resolution" }
          : {}),
        inDomain,
      });
      const said = metrics.map(
        (row) => `${row.metric} ${row.value.toPrecision(6)}`
      );
      for (const row of judged) {
        const verdict =
          row.verdict === "none"
            ? `none (${row.reason})`
            : row.verdict === "over"
              ? `over by ${row.by.toPrecision(3)}`
              : "within";
        said.push(
          `${row.kind} ${row.threshold.toPrecision(4)} from ${row.from}: ${verdict}, ${row.coverage.qualified} qualified ${JSON.stringify(row.coverage.excluded)}${row.metrics.map((m) => `, ${m.metric} ${m.value.toPrecision(6)}`).join("")}`
        );
      }
      if (judged.length === 0) said.push("none (no resolution)");
      console.log(`  ${quantity}: ${said.join("; ")}`);
    }
    for (const side of ["detailed", "snapshot"] as const) {
      for (const row of domain[side].envelope) {
        console.log(
          `  ${side}: ${row.path} ${row.port} ${row.quantity} outside ${row.ref}'s envelope ${row.range}`
        );
      }
    }

    if (!write) {
      const stored = record.rows ?? [];
      expect(
        JSON.stringify(stored.map((row) => row.quantity)) ===
          JSON.stringify(rows.map((row) => row.quantity)),
        `${at}: the record's rows ${JSON.stringify(stored.map((row) => row.quantity))} are not its quantities`
      );
      for (const row of rows) {
        const was = stored.find((item) => item.quantity === row.quantity);
        if (!was) continue;
        const problems = rowProblems(was, row);
        expect(
          problems.length === 0,
          `${at}: ${row.quantity}: ${problems.join("; ")}`
        );
      }
      for (const side of ["detailed", "snapshot"] as const) {
        const diff = record.domain
          ? validityDiff(record.domain[side], domain[side])
          : ["the record states no domain"];
        expect(
          diff.length === 0,
          `${at}: the ${side} side's validity moved: ${diff.join("; ")}`
        );
      }
      expect(
        record.inDomain === inDomain,
        `${at}: in domain ${inDomain}, the record says ${record.inDomain}`
      );
    }
    if (write) {
      const next: AssemblyCheck = {
        format: FORMAT,
        document: record.document,
        fixture: { ms, ...fixture },
        detailed: record.detailed,
        snapshot: record.snapshot,
        children: b.snapshots.map((row) => ({
          ...row,
          hash: contentHash(snapshotOf(dir, row.ref)),
          fromHash: sourceHash(dir, row.ref),
        })),
        quantities: record.quantities,
        observations,
        identity,
        policy,
        rows,
        domain,
        inDomain,
      };
      writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
      console.log(`  wrote ${file}`);
    }
  }
} finally {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
}

console.log(`assembly.selfcheck ok (${found.length} assembly checks)`);
