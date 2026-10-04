/**
 * Every assembly check in the examples, remeasured (layered-sim unit 6).
 * An assembly check (`sfab.assembly-check@1`, `<project>/checks/…`) is one
 * assembly run twice on its own fixture: every child at its detailed level,
 * and every child that has a snapshot as that snapshot. Its rows state the
 * gap at the named port quantities, read through `Sim.portReading` every
 * 10 ms frame, the measure unit 4 uses for a group.
 *
 * Nothing here names a part. The record says which document, which two
 * level specs, which snapshots the snapshot side runs and which ports it
 * states. The check fails when:
 *
 * - the document or its lockfile is not the one the record was measured on;
 * - a child snapshot's source no longer hashes to the record's `fromHash`
 *   (the child is stale, so the assembly row is);
 * - the detailed side runs any snapshot, or the snapshot side runs a
 *   different set than `children`;
 * - a recomputed max-abs or rms sits more than `DRIFT` from its row.
 *
 * Pass is "the remeasure matches the stored gap". An acceptance bound per
 * quantity is not stated yet. Any other world, supply, firmware, seed or
 * timestep is unchecked.
 *
 * `--write` remeasures and rewrites each record's hashes and rows.
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

import {
  type LevelSpec,
  RECORD_FRAME_MS,
  type SnapshotFile,
} from "@sfab-bench/contract";
import { contentHash, parsePartRef, sha256Bytes } from "@sfab-bench/parts";
import { provenanceHash } from "@sfab-bench/sim/freshness";
import { Sim } from "@sfab-bench/sim/sim";
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

type Child = { path: string; axis: string; ref: string; fromHash: string };

type Row = {
  metric: "free-run-max-abs" | "free-run-rms";
  quantity: string;
  value: number;
  heldOut: "fixture";
  baseline: "detailed";
};

type AssemblyCheck = {
  format: string;
  document: string;
  fixture: { ms: number; hash: string; lock: string };
  detailed: Levels;
  snapshot: Levels;
  children: Child[];
  quantities: string[];
  error: Row[];
};

type Side = {
  series: Map<string, number[]>;
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

/** `path.port.field`: a port name has no dot, an instance path may. */
function splitQuantity(quantity: string): {
  path: string;
  port: string;
  field: "voltage" | "current" | "angle";
} {
  const parts = quantity.split(".");
  const field = parts.pop();
  const port = parts.pop();
  if (
    !port ||
    parts.length === 0 ||
    (field !== "voltage" && field !== "current" && field !== "angle")
  ) {
    throw new Error(`${quantity}: not instance.port.field`);
  }
  return { path: parts.join("."), port, field };
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
  quantities: string[],
  ms: number
): Promise<Side> {
  const sim = newSim();
  try {
    const loaded = await sim.load({ project: root, world, generation: 1 });
    if (!loaded.ok) {
      throw new Error(loaded.errors.map((row) => row.message).join("; "));
    }
    const series = new Map(quantities.map((q) => [q, [] as number[]]));
    const sample = () => {
      for (const quantity of quantities) {
        const { path, port, field } = splitQuantity(quantity);
        const value = sim.portReading(path, port)?.[field];
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new Error(`${world}: ${quantity} has no reading`);
        }
        series.get(quantity)?.push(value);
      }
    };
    sample();
    for (let t = 0; t < ms; t += RECORD_FRAME_MS) {
      await sim.step(RECORD_FRAME_MS);
      sample();
    }
    const snapshots = (sim.report()?.snapshots ?? [])
      .map((row) => ({ path: row.path, axis: row.axis, ref: row.ref }))
      .sort((a, b) =>
        `${a.path} ${a.axis}`.localeCompare(`${b.path} ${b.axis}`)
      );
    return { series, snapshots };
  } finally {
    sim.dispose();
  }
}

function gap(a: number[], b: number[]): { maxAbs: number; rms: number } {
  expect(
    a.length === b.length && a.length > 0,
    `frame counts ${a.length} and ${b.length}`
  );
  let maxAbs = 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs((a[i] ?? 0) - (b[i] ?? 0));
    if (d > maxAbs) maxAbs = d;
    sum += d * d;
  }
  return { maxAbs, rms: Math.sqrt(sum / a.length) };
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
    const { quantities } = record;
    const ms = record.fixture.ms;
    const a = await runSide(
      root,
      writeSide(root, record.document, "assembly-detailed", record.detailed),
      quantities,
      ms
    );
    const b = await runSide(
      root,
      writeSide(root, record.document, "assembly-snapshot", record.snapshot),
      quantities,
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
    for (const quantity of quantities) {
      const { maxAbs, rms } = gap(
        a.series.get(quantity) ?? [],
        b.series.get(quantity) ?? []
      );
      console.log(
        `  ${quantity}: gap max ${maxAbs.toPrecision(6)}, rms ${rms.toPrecision(6)}`
      );
      for (const [metric, got] of [
        ["free-run-max-abs", maxAbs],
        ["free-run-rms", rms],
      ] as const) {
        rows.push({
          metric,
          quantity,
          value: Number(got.toPrecision(10)),
          heldOut: "fixture",
          baseline: "detailed",
        });
        if (write) continue;
        const row = record.error.find(
          (item) => item.metric === metric && item.quantity === quantity
        );
        expect(row, `${at}: no ${metric} row for ${quantity}`);
        if (!row) continue;
        const drift = (got - row.value) / Math.max(Math.abs(row.value), 1e-12);
        expect(
          Math.abs(drift) <= DRIFT,
          `${at}: ${quantity} ${metric} ${got} vs the stated ${row.value} (${drift.toExponential(2)})`
        );
      }
    }
    if (write) {
      const next: AssemblyCheck = {
        ...record,
        fixture: { ms, ...fixture },
        children: b.snapshots.map((row) => ({
          ...row,
          fromHash: sourceHash(dir, row.ref),
        })),
        error: rows,
      };
      writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
      console.log(`  wrote ${file}`);
    }
  }
} finally {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
}

console.log(`assembly.selfcheck ok (${found.length} assembly checks)`);
