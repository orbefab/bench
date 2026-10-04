/**
 * Every group snapshot in the catalog, held against its group at its own
 * ports (layered-sim unit 4). A group snapshot is a behaviour snapshot
 * taken from a composite level. Nothing here names a part: the snapshot
 * file says which part, which level it came from and which port
 * quantities it stands for; the part file says which option runs it; the
 * example worlds say where that part runs.
 *
 * For each group snapshot, in one example world that holds its part (the
 * snapshot's own fixture when that is an example world):
 *
 * - the world runs twice, the group in detail and the group as its
 *   snapshot, and each run's report says so;
 * - every port quantity the snapshot names is read on both runs through
 *   `Sim.portReading`, every 10 ms frame;
 * - on the fixture the capture recorded, the gap is the stated error
 *   (free-run max-abs and rms) to `DRIFT`;
 * - elsewhere the gap is printed beside the stated error. A world that is
 *   not the snapshot's fixture has no budget yet.
 */

import { ok as expect } from "node:assert/strict";
import {
  cpSync,
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
  type AxisLevel,
  type LevelSpec,
  RECORD_FRAME_MS,
} from "@sfab-bench/contract";
import { sha256Bytes } from "@sfab-bench/parts";
import { Sim } from "@sfab-bench/sim/sim";
import { projectReal, readerFor, readInside } from "./world/files";
import { packageVersion } from "./world/package-version";
import { nodePlanEnv } from "./world/plan-host";

const catalog = fileURLToPath(new URL("../catalog/", import.meta.url));
const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));

/** How long a world without a capture recipe runs. */
const RUN_MS = 1000;
/**
 * How far a recomputed error may sit from the stated one, relative. The
 * rows were captured on an earlier build; they agree to about 5e-6.
 */
const DRIFT = 1e-4;

type ErrorRow = { metric: string; quantity: string; value: number };

type SnapshotFile = {
  part: string;
  axis: string;
  ports: { inputs: string[]; outputs: string[] };
  error: ErrorRow[];
  provenance: {
    variant?: string;
    from: { level: string };
    fixture?: { ref: string };
  };
};

type Variant = { kind: string; ref?: string };
type BehaviourAxis = Record<
  string,
  { default: string; variants: Record<string, Variant> }
>;

type Recipe = {
  id: string;
  scene?: { project: string; world: string; instance: string; ms: number };
  deep?: LevelSpec;
  snap?: LevelSpec;
};

type Group = {
  id: string;
  snapshot: SnapshotFile;
  deep: AxisLevel;
  snap: AxisLevel;
};

type Scene = { project: string; world: string; path: string };

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

/** `pub/name@version` for every snapshot file in the catalog, sorted. */
function catalogSnapshots(): { id: string; file: string }[] {
  const root = join(catalog, "snapshots");
  return readdirSync(root)
    .sort()
    .flatMap((publisher) =>
      readdirSync(join(root, publisher))
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => ({
          id: `${publisher}/${name.slice(0, -".json".length)}`,
          file: join(root, publisher, name),
        }))
    );
}

/** The group behind a snapshot, or why it is not one. */
function groupOf(id: string, snapshot: SnapshotFile): Group | string {
  if (snapshot.axis !== "behaviour") return `a ${snapshot.axis} snapshot`;
  const part = readJson<{ axes: { behaviour?: BehaviourAxis } }>(
    join(catalog, "parts", `${snapshot.part}.json`)
  );
  const levels = part.axes.behaviour ?? {};
  const from = snapshot.provenance.from.level;
  const level = levels[from];
  const variant = snapshot.provenance.variant ?? level?.default ?? "";
  const source = level?.variants[variant];
  if (source?.kind !== "composite") {
    return `class ${from} ${variant} is ${source?.kind ?? "absent"}, not a group`;
  }
  for (const [cls, row] of Object.entries(levels)) {
    for (const [name, option] of Object.entries(row.variants)) {
      if (option.kind === "snapshot" && option.ref === id) {
        return {
          id,
          snapshot,
          deep: { class: Number(from) as 0, variant },
          snap: { class: Number(cls) as 0, variant: name },
        };
      }
    }
  }
  return `no behaviour option of ${snapshot.part} runs it`;
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

/** Example worlds, sorted, as `project/parts/…json`. */
function exampleWorlds(): { project: string; world: string }[] {
  return readdirSync(examples)
    .sort()
    .flatMap((project) => {
      const parts = join(examples, project, "parts");
      return readdirSync(parts)
        .sort()
        .flatMap((publisher) =>
          readdirSync(join(parts, publisher))
            .sort()
            .map((name) => `parts/${publisher}/${name}`)
        )
        .filter((world) =>
          readFileSync(join(examples, project, world), "utf8").includes(
            '"play"'
          )
        )
        .map((world) => ({ project, world }));
    });
}

/** Behaviour paths per part id, from each example world's own report. */
async function whereParts(): Promise<Map<string, Scene[]>> {
  const out = new Map<string, Scene[]>();
  for (const { project, world } of exampleWorlds()) {
    const sim = newSim();
    try {
      const loaded = await sim.load({
        project: join(examples, project),
        world,
        generation: 1,
      });
      if (!loaded.ok) continue;
      for (const row of sim.report()?.levels ?? []) {
        if (row.axis !== "behaviour") continue;
        const list = out.get(row.part) ?? [];
        list.push({ project, world, path: row.path });
        out.set(row.part, list);
      }
    } finally {
      sim.dispose();
    }
  }
  return out;
}

type Side = {
  /** Per quantity, the reading at each frame. */
  series: Map<string, number[]>;
  impl: string;
  snapshot: string | null;
};

const FIELDS = ["voltage", "current", "angle"] as const;
type Field = (typeof FIELDS)[number];

function splitQuantity(quantity: string): { port: string; field: Field } {
  const dot = quantity.lastIndexOf(".");
  const field = quantity.slice(dot + 1);
  if (!(FIELDS as readonly string[]).includes(field)) {
    throw new Error(`${quantity}: no port reading has a ${field}`);
  }
  return { port: quantity.slice(0, dot), field: field as Field };
}

async function runSide(
  root: string,
  world: string,
  path: string,
  quantities: string[],
  ms: number
): Promise<Side> {
  const sim = newSim();
  try {
    const loaded = await sim.load({ project: root, world, generation: 1 });
    if (!loaded.ok) {
      throw new Error(loaded.errors.map((row) => row.message).join("; "));
    }
    const report = sim.report();
    const series = new Map(quantities.map((q) => [q, [] as number[]]));
    const sample = () => {
      for (const quantity of quantities) {
        const { port, field } = splitQuantity(quantity);
        const value = sim.portReading(path, port)?.[field];
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new Error(`${world}: ${path}.${quantity} has no reading`);
        }
        series.get(quantity)?.push(value);
      }
    };
    sample();
    for (let t = 0; t < ms; t += RECORD_FRAME_MS) {
      await sim.step(RECORD_FRAME_MS);
      sample();
    }
    return {
      series,
      impl:
        report?.levels.find(
          (row) => row.path === path && row.axis === "behaviour"
        )?.impl ?? "",
      snapshot:
        report?.snapshots.find(
          (row) => row.path === path && row.axis === "behaviour"
        )?.ref ?? null,
    };
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

/** The detailed side's range, so a gap has a scale. */
function span(values: number[]): string {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return `${lo.toPrecision(4)} to ${hi.toPrecision(4)}`;
}

/** Writes the world with `path`'s levels set; returns its file. */
function writeSide(
  root: string,
  world: string,
  name: string,
  path: string,
  levels: LevelSpec
): string {
  const file = readJson<{
    id: string;
    play: { levels?: { default: LevelSpec; paths?: Record<string, unknown> } };
  }>(join(root, world));
  const publisher = file.id.slice(0, file.id.indexOf("/"));
  const version = file.id.slice(file.id.lastIndexOf("@"));
  file.id = `${publisher}/${name}${version}`;
  const own = file.play.levels ?? { default: 1 };
  file.play.levels = { ...own, paths: { ...own.paths, [path]: levels } };
  const rel = `parts/${publisher}/${name}${version}.json`;
  writeFileSync(join(root, rel), JSON.stringify(file));
  return rel;
}

const recipes = readJson<{ entries: Recipe[] }>(
  join(catalog, "fixtures/capture.config.json")
).entries;
const where = await whereParts();
const temps: string[] = [];
let groups = 0;
try {
  for (const { id, file } of catalogSnapshots()) {
    const snapshot = readJson<SnapshotFile>(file);
    const group = groupOf(id, snapshot);
    if (typeof group === "string") {
      console.log(`${id}: not checked, ${group}`);
      continue;
    }
    groups++;
    const recipe = recipes.find((row) => row.id === id);
    const scenes = where.get(snapshot.part) ?? [];
    const fixture = snapshot.provenance.fixture?.ref;
    const own = scenes.find(
      (scene) => `${scene.project}/${scene.world}` === fixture
    );
    const scene = own ?? scenes[0];
    expect(scene, `${id}: no example world runs ${snapshot.part}`);
    if (!scene) continue;
    // The capture's own sides on its own fixture; else the group's
    // source option against the option that runs the snapshot.
    const captured =
      own &&
      recipe?.scene?.instance === own.path &&
      recipe.deep !== undefined &&
      recipe.snap !== undefined;
    const deep: LevelSpec =
      captured && recipe.deep ? recipe.deep : { behaviour: group.deep };
    const snap: LevelSpec =
      captured && recipe.snap ? recipe.snap : { behaviour: group.snap };
    const ms = captured && recipe.scene ? recipe.scene.ms : RUN_MS;

    const root = mkdtempSync(join(tmpdir(), "sfab-group-ports-"));
    temps.push(root);
    cpSync(join(examples, scene.project), root, { recursive: true });
    const quantities = [
      ...snapshot.ports.inputs,
      ...snapshot.ports.outputs,
    ].sort();
    const a = await runSide(
      root,
      writeSide(root, scene.world, "group-ports-deep", scene.path, deep),
      scene.path,
      quantities,
      ms
    );
    const b = await runSide(
      root,
      writeSide(root, scene.world, "group-ports-snap", scene.path, snap),
      scene.path,
      quantities,
      ms
    );
    const at = `${scene.project}/${scene.world} ${scene.path}`;
    expect(
      a.impl === "composite" && a.snapshot === null,
      `${id}: the detailed side runs the group: ${at} ${a.impl}`
    );
    expect(
      b.snapshot === id,
      `${id}: the snapshot side runs it: ${at} ${b.impl} ${b.snapshot}`
    );
    console.log(
      `${id}: ${at}, ${ms} ms${captured ? ", the capture's fixture" : ""}`
    );
    for (const quantity of quantities) {
      const detailed = a.series.get(quantity) ?? [];
      const { maxAbs, rms } = gap(detailed, b.series.get(quantity) ?? []);
      const stated = snapshot.error.filter((row) => row.quantity === quantity);
      const said = stated.length
        ? stated.map((row) => `${row.metric} ${row.value}`).join(", ")
        : "no stated row";
      console.log(
        `  ${quantity}: ${span(detailed)}; gap max ${maxAbs.toPrecision(4)}, rms ${rms.toPrecision(4)} (${said})`
      );
      if (!captured) continue;
      for (const row of stated) {
        const got =
          row.metric === "free-run-max-abs"
            ? maxAbs
            : row.metric === "free-run-rms"
              ? rms
              : null;
        if (got === null) continue;
        const drift = (got - row.value) / row.value;
        console.log(`    ${row.metric}: ${drift.toExponential(2)} off`);
        expect(
          Math.abs(drift) <= DRIFT,
          `${id}: ${quantity} ${row.metric} on its fixture is the stated ${row.value}: ${got}`
        );
      }
    }
  }
  expect(groups > 0, "the catalog has a group snapshot to check");
} finally {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
}

console.log(`group-ports.selfcheck ok (${groups} group snapshots)`);
