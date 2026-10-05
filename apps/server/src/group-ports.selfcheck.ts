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
 * - every port quantity the snapshot names is observed on both runs at
 *   the `frame` cadence (t = 0 and every 10 ms), and a port name the part
 *   does not have reads nothing;
 * - on the fixture the capture recorded, the gap is the stated error
 *   (free-run max-abs and rms, which are `frame-max` and `frame-rms`) to
 *   `DRIFT`;
 * - elsewhere the gap is printed beside the stated error. A world that is
 *   not the snapshot's fixture has no budget yet.
 *
 * Both sides of a world run from one frozen context of it
 * (`@sfab-bench/sim/run-context`), at their own levels.
 */

import { ok as expect } from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AxisLevel, LevelSpec } from "@sfab-bench/contract";
import { pairByKey, reduce } from "@sfab-bench/sim/compare";
import { describe, descriptorId } from "@sfab-bench/sim/observe";
import {
  openContext,
  type RunContext,
  runSide,
  type Selection,
} from "@sfab-bench/sim/run-context";
import { nodeRunClock, nodeRunFiles } from "./world/run-host";

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

/** Behaviour paths per part id, from each example world as authored. */
function whereParts(): Map<string, Scene[]> {
  const out = new Map<string, Scene[]>();
  for (const { project, world } of exampleWorlds()) {
    const planned = openContext(
      nodeRunFiles,
      join(examples, project),
      world
    ).authored;
    if (!planned.ok) continue;
    for (const row of planned.plan.report?.levels ?? []) {
      if (row.axis !== "behaviour") continue;
      const list = out.get(row.part) ?? [];
      list.push({ project, world, path: row.path });
      out.set(row.part, list);
    }
  }
  return out;
}

type Side = {
  /** Per quantity, the observations at each frame. */
  series: Map<string, { key: string; ms: number; value: number }[]>;
  impl: string;
  snapshot: string | null;
};

/** One side of `context`, every frame, at `path`'s own quantities. */
async function sideOf(
  context: RunContext,
  selection: Selection,
  path: string,
  quantities: string[],
  ms: number
): Promise<Side> {
  const run = await runSide(
    context,
    selection,
    quantities.map((quantity) => describe(`${path}.${quantity}`, "frame")),
    { ms, host: nodeRunClock }
  );
  return {
    series: new Map(
      quantities.map((quantity) => [
        quantity,
        run.series.get(
          descriptorId(describe(`${path}.${quantity}`, "frame"))
        ) ?? [],
      ])
    ),
    impl:
      run.report.levels.find(
        (row) => row.path === path && row.axis === "behaviour"
      )?.impl ?? "",
    snapshot:
      run.report.snapshots.find(
        (row) => row.path === path && row.axis === "behaviour"
      )?.ref ?? null,
  };
}

/** A port name the part does not have reads nothing: its side refuses it. */
async function readsNothing(
  context: RunContext,
  selection: Selection,
  path: string
): Promise<boolean> {
  return runSide(
    context,
    selection,
    [describe(`${path}.no-such-port.voltage`, "frame")],
    { ms: 0, host: nodeRunClock }
  ).then(
    () => false,
    (err: unknown) => String(err).includes("has no reading")
  );
}

/** The detailed side's range, so a gap has a scale. */
function span(values: number[]): string {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return `${lo.toPrecision(4)} to ${hi.toPrecision(4)}`;
}

/** The world's own levels with `path`'s set to `levels`. */
function withPath(
  document: { play?: { levels?: Selection } },
  path: string,
  levels: LevelSpec
): Selection {
  const own = document.play?.levels ?? { default: 1 };
  return { ...own, paths: { ...own.paths, [path]: levels } };
}

const recipes = readJson<{ entries: Recipe[] }>(
  join(catalog, "fixtures/capture.config.json")
).entries;
const where = whereParts();
let groups = 0;
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

  const document = readJson<{ play?: { levels?: Selection } }>(
    join(examples, scene.project, scene.world)
  );
  const sides = [
    withPath(document, scene.path, deep),
    withPath(document, scene.path, snap),
  ] as const;
  const context = openContext(
    nodeRunFiles,
    join(examples, scene.project),
    scene.world,
    { selections: sides }
  );
  const quantities = [
    ...snapshot.ports.inputs,
    ...snapshot.ports.outputs,
  ].sort();
  const a = await sideOf(context, sides[0], scene.path, quantities, ms);
  const b = await sideOf(context, sides[1], scene.path, quantities, ms);
  for (const selection of sides) {
    expect(
      await readsNothing(context, selection, scene.path),
      `${id}: ${scene.path}.no-such-port has a reading`
    );
  }
  expect(
    context.late().length === 0,
    `${id}: the sides read files after the context opened: ${context.late().join(", ")}`
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
    const paired = pairByKey(detailed, b.series.get(quantity) ?? []);
    expect(
      paired.pairs.length === detailed.length && paired.unmatched.length === 0,
      `${id}: ${quantity} frames ${detailed.length} and ${b.series.get(quantity)?.length}`
    );
    const maxAbs = reduce("frame-max", paired.pairs)?.value ?? Number.NaN;
    const rms = reduce("frame-rms", paired.pairs)?.value ?? Number.NaN;
    const stated = snapshot.error.filter((row) => row.quantity === quantity);
    const said = stated.length
      ? stated.map((row) => `${row.metric} ${row.value}`).join(", ")
      : "no stated row";
    console.log(
      `  ${quantity}: ${span(detailed.map((row) => row.value))}; gap max ${maxAbs.toPrecision(4)}, rms ${rms.toPrecision(4)} (${said})`
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
      const drift = (got - row.value) / Math.max(Math.abs(row.value), 1e-12);
      console.log(`    ${row.metric}: ${drift.toExponential(2)} off`);
      expect(
        Math.abs(drift) <= DRIFT,
        `${id}: ${quantity} ${row.metric} on its fixture is the stated ${row.value}: ${got}`
      );
    }
  }
}
expect(groups > 0, "the catalog has a group snapshot to check");

console.log(`group-ports.selfcheck ok (${groups} group snapshots)`);
