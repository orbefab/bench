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
 * Every document here (the world, each assembly alone, the tied world, the
 * four copies) is its own frozen run context (`@sfab-bench/sim/run-context`),
 * edited in memory. A stored verdict belongs to one context: the check
 * reports each assembly's context and the assembly check stored for it, if
 * any. The tied world is a context no assembly check measured, so it has
 * no budget of its own; this check states no world-level error budget.
 * Each supply's draw is its own positive port's current, which reads
 * negative because the supply sources it.
 */

import { ok as expect } from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type LevelSpec,
  RECORD_FRAME_MS,
  type WorldViewNode,
} from "@sfab-bench/contract";
import { describe, descriptorId } from "@sfab-bench/sim/observe";
import {
  openContext,
  planSide,
  type RunContext,
  runSide,
} from "@sfab-bench/sim/run-context";
import { powerIslands } from "@sfab-bench/sim/wiring";
import { nodeRunClock, nodeRunFiles } from "./world/run-host";

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
  context: string;
  wallMs: number;
};

/** The netlist of a root part's composite behaviour. */
function netlistOf(part: PartFile) {
  for (const cls of Object.values(part.axes.behaviour)) {
    for (const variant of Object.values(cls.variants)) {
      if (variant.netlist) return variant.netlist;
    }
  }
  throw new Error(`${part.id}: no composite netlist`);
}

/** `part` as its own context, at the world's path. */
const contextOf = (part: PartFile): RunContext =>
  openContext(nodeRunFiles, example, WORLD, { document: part });

/** Instance paths the plan's tree marks as assemblies, below the root. */
function assembliesOf(context: RunContext): string[] {
  const { plan } = planSide(context);
  const out: string[] = [];
  const walk = (nodes: readonly WorldViewNode[]) => {
    for (const node of nodes) {
      if (node.role === "assembly" && node.id.includes(".") === false) {
        out.push(node.id);
      }
      walk(node.children);
    }
  };
  walk(plan.tree?.nodes ?? []);
  return out.filter((id) => id !== "$root").sort();
}

function islandsOf(context: RunContext): string[] {
  return powerIslands(planSide(context).plan).map((island) =>
    island.supplyIds.join("+")
  );
}

/**
 * Run `context` for `MS`, reading `quantities` and every supply each
 * frame. The first frame is a warmup: t = 0 is not compared.
 */
async function run(context: RunContext, quantities: string[]): Promise<Run> {
  const supplyOf = new Map(
    planSide(context).plan.supplies.map((supply) => [
      describe(`${supply.id}.${supply.positivePin}.current`, "frame"),
      supply.id,
    ])
  );
  const read = new Map(
    quantities.map((quantity) => [describe(quantity, "frame"), quantity])
  );
  const side = await runSide(
    context,
    undefined,
    [...read.keys(), ...supplyOf.keys()],
    { ms: MS, host: nodeRunClock }
  );
  const after = (row: Parameters<typeof descriptorId>[0]) =>
    (side.series.get(descriptorId(row)) ?? [])
      .filter((point) => point.ms >= RECORD_FRAME_MS)
      .map((point) => point.value);
  return {
    series: new Map([...read].map(([row, quantity]) => [quantity, after(row)])),
    supplies: new Map(
      [...supplyOf].map(([row, id]) => [id, after(row).map((amps) => -amps)])
    ),
    snapshots: side.snapshots.map((row) => `${row.path} ${row.axis}`).sort(),
    context: side.context,
    wallMs: side.wallMs,
  };
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

/** Wall ms per simulated second. */
const perSecond = (r: Run) => (r.wallMs / MS) * 1000;

/** Every stored assembly check in the project, by the context it measured. */
function storedChecks(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, rel: string) => {
    if (!existsSync(dir)) return;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const at = join(dir, ent.name);
      const shown = `${rel}/${ent.name}`;
      if (ent.isDirectory()) walk(at, shown);
      else if (ent.name.endsWith(".json")) {
        const file = JSON.parse(readFileSync(at, "utf8")) as {
          format?: string;
          context?: string;
        };
        if (file.format === "sfab.assembly-check@2" && file.context) {
          out.set(file.context, shown);
        }
      }
    }
  };
  walk(join(example, "checks"), "checks");
  return out;
}

const short = (hash: string) => hash.slice(0, 12);

const world = openContext(nodeRunFiles, example, WORLD);
expect(world.authored.ok, `${WORLD} does not plan as authored`);
const part = world.document as PartFile;
const levels = part.play.levels;
if (!levels) throw new Error(`${WORLD}: no play levels`);
const net = netlistOf(part);
const checks = storedChecks();

// The assemblies, from the tree.
const assemblies = assembliesOf(world);
expect(assemblies.length === 2, `assemblies ${assemblies.join(", ")}`);
const [first, second] = assemblies as [string, string];
// Which one the path rules move to its snapshots.
const ruled = (prefix: string) =>
  Object.keys(levels.paths ?? {}).some((path) => path.startsWith(`${prefix}.`));
const snapshotSide = ruled(first) ? first : second;
const detailedSide = snapshotSide === first ? second : first;
expect(
  ruled(snapshotSide) && !ruled(detailedSide),
  "one assembly carries the path rules"
);

// The world, and each assembly alone: the same root with one instance.
const alone = (keep: string, rules: Levels): RunContext => {
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
  return contextOf(one);
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
const worldRun = await run(world, [
  ...across(detailedSide),
  ...across(snapshotSide),
]);
const detailedAlone = await run(
  alone(detailedSide, scoped(detailedSide)),
  QUANTITIES
);
const snapshotAlone = await run(
  alone(snapshotSide, {
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
const islands = islandsOf(world);
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

// Each assembly in its own context, and the check stored for it.
const contexts = [
  [detailedSide, detailedAlone.context],
  [snapshotSide, snapshotAlone.context],
] as const;
expect(
  new Set([worldRun.context, ...contexts.map(([, hash]) => hash)]).size === 3,
  "the world and each assembly alone are three contexts"
);
console.log(
  `world contexts: ${contexts
    .map(
      ([side, hash]) =>
        `${side} alone ${short(hash)} (${checks.get(hash) ?? "no stored check"})`
    )
    .join(", ")}; stored ${[...checks]
    .map(([hash, file]) => `${file} ${short(hash)}`)
    .join(", ")}`
);

// Shared: GND to GND and 5V to 5V. Two supplies on one rail.
const tied: PartFile = structuredClone(part);
netlistOf(tied).wires = [
  [`${first}.GND`, `${second}.GND`],
  [`${first}.5V`, `${second}.5V`],
];
const tiedContext = contextOf(tied);
const tiedIslands = islandsOf(tiedContext);
expect(
  tiedIslands.length === 1 && tiedIslands[0]?.split("+").length === 2,
  `tied islands ${tiedIslands.join(", ")}`
);
const tiedRun = await run(tiedContext, [
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
expect(
  !checks.has(tiedRun.context) &&
    contexts.every(([, hash]) => hash !== tiedRun.context),
  "the tied world is a context of its own"
);
console.log(
  `world tied: context ${short(tiedRun.context)} has no budget of its own: no assembly check measured it`
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
const fourRun = await run(contextOf(four), []);
const one = perSecond(detailedAlone);
const snap = perSecond(snapshotAlone);
const both = perSecond(worldRun);
const quad = perSecond(fourRun);
const pair = both / (one + snap);
const scale = quad / one;
// Wall time varies run to run: print it only on request, so the check's
// log stays byte-identical (docs/testing.md). The ratios still gate.
if (process.env.BENCH_TIMINGS === "1")
  console.log(
    `world cost (${cpus()[0]?.model ?? "unknown cpu"}, wall ms per simulated s): detailed ${one.toFixed(0)}, snapshot ${snap.toFixed(0)}, world of both ${both.toFixed(0)} (${pair.toFixed(2)}× the two alone), four detailed ${quad.toFixed(0)} (${scale.toFixed(2)}× one)`
  );
expect(pair > 0.6 && pair < 1.6, `world / both alone ${pair}`);
expect(scale > 2.5 && scale < 6, `four / one ${scale}`);
console.log("world.selfcheck ok");
