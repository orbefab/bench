/**
 * A world: several assemblies in one root, at mixed levels, on separate and
 * shared supplies, with the run's cost measured (layered-sim unit 7).
 *
 * `examples/arm/parts/sfab/arm-world@1.0.0.json` instances the arm scene
 * twice, the second placed beside the first. Its levels run one copy
 * detailed and the other on the unit 6 snapshot side (path rules under that
 * instance). The check reads the assemblies from the plan's tree (role
 * `assembly`), never by part id, and asserts:
 *
 * - each assembly runs its own supply, one island each, and reads exactly
 *   what the same assembly reads alone at the same levels: another
 *   assembly on a separate supply changes nothing;
 * - only the second assembly runs snapshots;
 * - wired GND to GND and 5V to 5V, the two supplies are one island, both
 *   carry current, and each assembly's rail moves from its run alone;
 * - cost: wall ms per simulated second, printed with the machine; asserted
 *   only as ratios (the world against its two assemblies alone, and four
 *   detailed copies against one), never as absolute time.
 *
 * The gap each assembly carries against its detailed run is the assembly
 * check's (`checks/sfab/arm-bench@1.0.0.json`); this check states no
 * world-level error budget.
 */

import { ok as expect } from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  type LevelSpec,
  RECORD_FRAME_MS,
  type WorldViewNode,
} from "@sfab-bench/contract";
import { sha256Bytes } from "@sfab-bench/parts";
import { Sim } from "@sfab-bench/sim/sim";
import { powerIslands } from "@sfab-bench/sim/wiring";
import { projectReal, readerFor, readInside } from "./world/files";
import { packageVersion } from "./world/package-version";
import { planWorld } from "./world/plan";
import { nodePlanEnv } from "./world/plan-host";

const example = fileURLToPath(
  new URL("../../../examples/arm/", import.meta.url)
);
const WORLD = "parts/sfab/arm-world@1.0.0.json";
const MS = 1000;
/** Port quantities read on every assembly, relative to its instance. */
const QUANTITIES = [
  "servo.shaft.angle",
  "servo.V+.current",
  "uno.5V.voltage",
  "uno.VBUS.voltage",
];

type Levels = { default: LevelSpec; paths?: Record<string, LevelSpec> };
type PartFile = {
  id: string;
  play: { levels?: Levels };
  axes: {
    behaviour: Record<
      string,
      {
        variants: Record<
          string,
          {
            netlist?: {
              instances: Record<string, { part: string; pose?: unknown }>;
              wires: [string, string][];
            };
          }
        >;
      }
    >;
  };
};

type Run = {
  series: Map<string, number[]>;
  supplies: Map<string, number[]>;
  snapshots: string[];
  wallMs: number;
};

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
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

/** The netlist of a root part's composite behaviour. */
function netlistOf(part: PartFile) {
  for (const cls of Object.values(part.axes.behaviour)) {
    for (const variant of Object.values(cls.variants)) {
      if (variant.netlist) return variant.netlist;
    }
  }
  throw new Error(`${part.id}: no composite netlist`);
}

/** Write `part` under a new name in `root`; returns its file. */
function writeRoot(root: string, part: PartFile, name: string): string {
  const id = part.id.replace(/\/[^/@]+@/, `/${name}@`);
  const rel = `parts/sfab/${id.slice(id.indexOf("/") + 1)}.json`;
  writeFileSync(join(root, rel), JSON.stringify({ ...part, id }));
  return rel;
}

/** Instance paths the plan's tree marks as assemblies, below the root. */
function assembliesOf(root: string, world: string): string[] {
  const planned = planWorld(root, world);
  if (!planned.ok) {
    throw new Error(planned.errors.map((row) => row.message).join("; "));
  }
  const out: string[] = [];
  const walk = (nodes: readonly WorldViewNode[]) => {
    for (const node of nodes) {
      if (node.role === "assembly" && node.id.includes(".") === false) {
        out.push(node.id);
      }
      walk(node.children);
    }
  };
  walk(planned.plan.tree?.nodes ?? []);
  return out.filter((id) => id !== "$root").sort();
}

function islandsOf(root: string, world: string): string[] {
  const planned = planWorld(root, world);
  if (!planned.ok) {
    throw new Error(planned.errors.map((row) => row.message).join("; "));
  }
  return powerIslands(planned.plan).map((island) => island.supplyIds.join("+"));
}

/**
 * Run `world` for `MS`, reading `quantities` and every supply each frame.
 * The first frame is a warmup; the wall clock covers the rest of the steps.
 */
async function run(
  root: string,
  world: string,
  quantities: string[]
): Promise<Run> {
  const sim = newSim();
  try {
    const loaded = await sim.load({ project: root, world, generation: 1 });
    if (!loaded.ok) {
      throw new Error(loaded.errors.map((row) => row.message).join("; "));
    }
    const series = new Map(quantities.map((q) => [q, [] as number[]]));
    const supplies = new Map<string, number[]>();
    const sample = () => {
      for (const quantity of quantities) {
        const parts = quantity.split(".");
        const field = parts.pop() as "voltage" | "current" | "angle";
        const port = parts.pop() ?? "";
        const value = sim.portReading(parts.join("."), port)?.[field];
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new Error(`${world}: ${quantity} has no reading`);
        }
        series.get(quantity)?.push(value);
      }
      for (const [id, state] of Object.entries(sim.state()?.supplies ?? {})) {
        const list = supplies.get(id) ?? [];
        list.push(state.current);
        supplies.set(id, list);
      }
    };
    await sim.step(RECORD_FRAME_MS);
    sample();
    let wallMs = 0;
    for (let t = RECORD_FRAME_MS; t < MS; t += RECORD_FRAME_MS) {
      const start = performance.now();
      await sim.step(RECORD_FRAME_MS);
      wallMs += performance.now() - start;
      sample();
    }
    const snapshots = (sim.report()?.snapshots ?? [])
      .map((row) => `${row.path} ${row.axis}`)
      .sort();
    return { series, supplies, snapshots, wallMs };
  } finally {
    sim.dispose();
  }
}

function maxGap(a: number[] = [], b: number[] = []): number {
  expect(
    a.length === b.length && a.length > 0,
    `frames ${a.length}/${b.length}`
  );
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    max = Math.max(max, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  }
  return max;
}

const mean = (values: number[] = []) =>
  values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);

/** Wall ms per simulated second, over the timed steps. */
const perSecond = (r: Run) => (r.wallMs / (MS - RECORD_FRAME_MS)) * 1000;

const root = mkdtempSync(join(tmpdir(), "sfab-world-"));
try {
  cpSync(example, root, { recursive: true });
  const part = readJson<PartFile>(join(root, WORLD));
  const levels = part.play.levels;
  if (!levels) throw new Error(`${WORLD}: no play levels`);
  const net = netlistOf(part);

  // The assemblies, from the tree.
  const assemblies = assembliesOf(root, WORLD);
  expect(assemblies.length === 2, `assemblies ${assemblies.join(", ")}`);
  const [first, second] = assemblies as [string, string];
  // Which one the path rules move to its snapshots.
  const ruled = (prefix: string) =>
    Object.keys(levels.paths ?? {}).some((path) =>
      path.startsWith(`${prefix}.`)
    );
  const snapshotSide = ruled(first) ? first : second;
  const detailedSide = snapshotSide === first ? second : first;
  expect(
    ruled(snapshotSide) && !ruled(detailedSide),
    "one assembly carries the path rules"
  );

  // The world, and each assembly alone: the same root with one instance.
  const alone = (keep: string, name: string, rules: Levels): string => {
    const instances = Object.fromEntries(
      Object.entries(net.instances).filter(
        ([id]) => id === keep || !assemblies.includes(id)
      )
    );
    const one: PartFile = structuredClone(part);
    const oneNet = netlistOf(one);
    oneNet.instances = instances;
    oneNet.wires = [];
    one.play.levels = rules;
    return writeRoot(root, one, name);
  };
  const scoped = (prefix: string): Levels => ({
    default: levels.default,
    paths: Object.fromEntries(
      Object.entries(levels.paths ?? {}).filter(([path]) =>
        path.startsWith(`${prefix}.`)
      )
    ),
  });
  const across = (prefix: string) => QUANTITIES.map((q) => `${prefix}.${q}`);

  // A lone non-environment instance unwraps to the root: its paths lose
  // the prefix, so the alone runs read the bare quantities.
  const worldRun = await run(root, WORLD, [
    ...across(detailedSide),
    ...across(snapshotSide),
  ]);
  const detailedAlone = await run(
    root,
    alone(detailedSide, "world-detailed-alone", scoped(detailedSide)),
    QUANTITIES
  );
  const snapshotAlone = await run(
    root,
    alone(snapshotSide, "world-snapshot-alone", {
      default: levels.default,
      paths: Object.fromEntries(
        Object.entries(levels.paths ?? {}).map(([path, spec]) => [
          path.slice(snapshotSide.length + 1),
          spec,
        ])
      ),
    }),
    QUANTITIES
  );

  // Separate supplies: one island each, nothing crosses.
  const islands = islandsOf(root, WORLD);
  expect(
    islands.length === 2 && islands.every((id) => !id.includes("+")),
    `separate islands ${islands.join(", ")}`
  );
  expect(
    worldRun.snapshots.length > 0 &&
      worldRun.snapshots.every((row) => row.startsWith(`${snapshotSide}.`)),
    `snapshots ${worldRun.snapshots.join(", ")}`
  );
  expect(
    detailedAlone.snapshots.length === 0,
    `the detailed assembly alone runs ${detailedAlone.snapshots.join(", ")}`
  );
  expect(
    JSON.stringify(
      snapshotAlone.snapshots.map((row) => `${snapshotSide}.${row}`)
    ) === JSON.stringify(worldRun.snapshots),
    `alone ${snapshotAlone.snapshots.join(", ")} vs world ${worldRun.snapshots.join(", ")}`
  );
  let crossed = 0;
  for (const [prefix, aloneRun] of [
    [detailedSide, detailedAlone],
    [snapshotSide, snapshotAlone],
  ] as const) {
    for (const q of QUANTITIES) {
      crossed = Math.max(
        crossed,
        maxGap(worldRun.series.get(`${prefix}.${q}`), aloneRun.series.get(q))
      );
    }
  }
  expect(crossed < 1e-12, `an assembly on its own supply moved by ${crossed}`);
  const draws = [...worldRun.supplies.entries()]
    .map(([id, values]) => `${id} ${(mean(values) * 1e3).toFixed(2)} mA`)
    .join(", ");
  console.log(
    `world: ${detailedSide} runs detailed, ${snapshotSide} runs ${worldRun.snapshots.join(", ")}; islands ${islands.join(", ")}; each reads its run alone (max Δ ${crossed.toExponential(1)}); mean draw ${draws}`
  );

  // Shared: GND to GND and 5V to 5V. Two supplies on one rail.
  const tied: PartFile = structuredClone(part);
  netlistOf(tied).wires = [
    [`${first}.GND`, `${second}.GND`],
    [`${first}.5V`, `${second}.5V`],
  ];
  const tiedWorld = writeRoot(root, tied, "world-tied");
  const tiedIslands = islandsOf(root, tiedWorld);
  expect(
    tiedIslands.length === 1 && tiedIslands[0]?.split("+").length === 2,
    `tied islands ${tiedIslands.join(", ")}`
  );
  const tiedRun = await run(root, tiedWorld, [
    ...across(detailedSide),
    ...across(snapshotSide),
  ]);
  const shares = [...tiedRun.supplies.values()].map((values) => mean(values));
  expect(
    shares.length === 2 && shares.every((amps) => amps > 0.01),
    `tied supplies ${shares.join(", ")}`
  );
  const rail = Math.max(
    maxGap(
      tiedRun.series.get(`${detailedSide}.uno.5V.voltage`),
      worldRun.series.get(`${detailedSide}.uno.5V.voltage`)
    ),
    maxGap(
      tiedRun.series.get(`${snapshotSide}.uno.5V.voltage`),
      worldRun.series.get(`${snapshotSide}.uno.5V.voltage`)
    )
  );
  expect(rail > 1e-6, `tying the rails moved no 5V node (${rail})`);
  console.log(
    `world tied: island ${tiedIslands.join(", ")}; mean draw ${[...tiedRun.supplies.entries()].map(([id, values]) => `${id} ${(mean(values) * 1e3).toFixed(2)} mA`).join(", ")}; 5V moves up to ${(rail * 1e3).toFixed(3)} mV from separate`
  );

  // Cost. Four detailed copies against one, placed apart.
  const four: PartFile = structuredClone(part);
  const fourNet = netlistOf(four);
  const template = net.instances[detailedSide];
  if (!template) throw new Error("unreachable");
  fourNet.instances = Object.fromEntries([
    ...Object.entries(net.instances).filter(([id]) => !assemblies.includes(id)),
    ...[0, 1, 2, 3].map((i) => [
      `copy${i}`,
      {
        part: template.part,
        pose: { position: [0.35 * i, 0, 0], rotation: [1, 0, 0, 0] },
      },
    ]),
  ]);
  fourNet.wires = [];
  four.play.levels = { default: levels.default };
  const fourRun = await run(root, writeRoot(root, four, "world-four"), []);
  const one = perSecond(detailedAlone);
  const snap = perSecond(snapshotAlone);
  const both = perSecond(worldRun);
  const quad = perSecond(fourRun);
  const pair = both / (one + snap);
  const scale = quad / one;
  console.log(
    `world cost (${cpus()[0]?.model ?? "unknown cpu"}, wall ms per simulated s): detailed ${one.toFixed(0)}, snapshot ${snap.toFixed(0)}, world of both ${both.toFixed(0)} (${pair.toFixed(2)}× the two alone), four detailed ${quad.toFixed(0)} (${scale.toFixed(2)}× one)`
  );
  expect(pair > 0.6 && pair < 1.6, `world / both alone ${pair}`);
  expect(scale > 2.5 && scale < 6, `four / one ${scale}`);
  console.log("world.selfcheck ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
