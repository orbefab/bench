/**
 * Observations, their pairing and their identity (run 7 unit 3a). The
 * assembly check uses them on the arm bench; this file bites the parts the
 * arm bench does not reach:
 *
 * - a series and its reverse: equal bands, a paired gap of the whole range;
 * - conversions pair by instant: a schedule that differs between the sides,
 *   a reader on one side only, and several conversions in one master step
 *   (one extra conversion first, which pairing by order would shift);
 * - a descriptor is refused when it states a phase the run does not read
 *   at, or a reference this unit does not take;
 * - the identity moves with a descriptor, a metric definition, or a token
 *   of the observer's code, and reads no package version; a format pass, a
 *   comment and a function the observer does not use do not move it;
 * - a validity item that appears or vanishes is named;
 * - a live run converts several channels inside one master step, each with
 *   its own instant and latched reference, and the same run twice pairs
 *   every conversion with no gap.
 */

import { ok as expect } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
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

import { sha256Bytes } from "@sfab-bench/parts";
import {
  comparisonIdentity,
  METRICS,
  pairByKey,
  reduce,
  validityDiff,
} from "@sfab-bench/sim/compare";
import {
  checkDescriptor,
  describe,
  descriptorId,
  OBSERVER_SOURCES,
  type Observation,
  type ObservationDescriptor,
  observeRun,
  type Validity,
} from "@sfab-bench/sim/observe";
import { Sim } from "@sfab-bench/sim/sim";
import { observerBuild, observerDir } from "./observer-build";
import { projectReal, readerFor, readInside } from "./world/files";
import { packageVersion } from "./world/package-version";
import { nodePlanEnv } from "./world/plan-host";

const adcDir = fileURLToPath(new URL("../fixtures/adc/", import.meta.url));

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

function frames(values: number[]): Observation[] {
  return values.map((value, i) => ({
    key: `step ${i * 10}`,
    ms: i * 10,
    value,
  }));
}

function conversions(rows: [number, number][]): Observation[] {
  return rows.map(([cycle, value]) => ({
    key: `conversion 0:${cycle}`,
    ms: cycle / 16_000,
    value,
  }));
}

function throwsWith(fn: () => unknown, text: string): void {
  try {
    fn();
  } catch (err: unknown) {
    expect(String(err).includes(text), `${String(err)} lacks "${text}"`);
    return;
  }
  expect(false, `no error with "${text}"`);
}

// A series and its reverse. Each side's own band is 0..5, so subtracting
// bands says 0. Paired at the same instants the gap is 5 at both ends.
{
  const a = frames([0, 1, 2, 3, 4, 5]);
  const b = frames([5, 4, 3, 2, 1, 0]);
  const band = (rows: Observation[]) =>
    Math.max(...rows.map((row) => row.value)) -
    Math.min(...rows.map((row) => row.value));
  expect(band(a) - band(b) === 0, "the bands are equal");
  const paired = pairByKey(a, b);
  const max = reduce("frame-max", paired.pairs);
  const rms = reduce("frame-rms", paired.pairs);
  expect(
    max?.value === 5 && max.at?.ms === 0 && max.at.a === 0 && max.at.b === 5,
    `reversed max ${JSON.stringify(max)}`
  );
  expect(
    rms?.value === Math.sqrt(70 / 6) && rms.pairs === 6,
    `reversed rms ${JSON.stringify(rms)}`
  );
  console.log(
    "observe: a series and its reverse have equal bands and a paired gap of 5"
  );
}

// Conversions pair by instant, never by order.
{
  // The schedule depends on data: the second conversion lands at another
  // cycle on each side. One pair, and one unmatched conversion per side.
  const moved = pairByKey(
    conversions([
      [1000, 2],
      [2664, 3],
    ]),
    conversions([
      [1000, 2.5],
      [3000, 3],
    ])
  );
  expect(
    moved.pairs.length === 1 &&
      reduce("event-max", moved.pairs)?.value === 0.5 &&
      JSON.stringify(moved.unmatched.map((row) => `${row.side} ${row.key}`)) ===
        JSON.stringify(["a conversion 0:2664", "b conversion 0:3000"]),
    `moved schedule ${JSON.stringify(moved)}`
  );
  // A reader that converts on one side only: nothing to reduce.
  const oneSided = pairByKey(
    conversions([
      [1000, 2],
      [2000, 2],
    ]),
    []
  );
  expect(
    oneSided.pairs.length === 0 &&
      oneSided.unmatched.length === 2 &&
      reduce("event-max", oneSided.pairs) === null,
    `one-sided ${JSON.stringify(oneSided)}`
  );
  // Three conversions inside one 1 ms step on side a; side b converts once
  // more, first. In order the pairs would be 1–9, 2–1, 3–2 (gap 8). By
  // instant they are equal, and the extra one is unmatched.
  const a = conversions([
    [100, 1],
    [1764, 2],
    [3428, 3],
  ]);
  const b = conversions([
    [50, 9],
    [100, 1],
    [1764, 2],
    [3428, 3],
  ]);
  const zipped = Math.max(
    ...a.map((row, i) => Math.abs(row.value - (b[i]?.value ?? 0)))
  );
  const byInstant = pairByKey(a, b);
  expect(
    zipped === 8 &&
      reduce("event-max", byInstant.pairs)?.value === 0 &&
      byInstant.pairs.length === 3 &&
      byInstant.unmatched.length === 1 &&
      byInstant.unmatched[0]?.key === "conversion 0:50",
    `one step ${JSON.stringify(byInstant)}`
  );
  throwsWith(() => pairByKey([...a, ...a], b), "twice on side a");
  console.log(
    "observe: conversions pair by instant (a moved schedule, a one-sided reader, three in one step)"
  );
}

// A descriptor states what the run delivers, or it is refused.
{
  expect(describe("servo.shaft.angle", "step").phase === "body", "angle phase");
  expect(describe("uno.5V.voltage", "frame").phase === "rail", "rail phase");
  expect(
    describe("nano.A0.voltage", "events").phase === "conversion",
    "event phase"
  );
  throwsWith(
    () =>
      checkDescriptor({
        ...describe("servo.shaft.angle", "step"),
        phase: "rail",
      }),
    "the run reads it at body"
  );
  throwsWith(
    () =>
      checkDescriptor({
        ...describe("nano.A0.voltage", "events"),
        reference: {
          kind: "ratio-to",
        } as unknown as ObservationDescriptor["reference"],
      }),
    "is not supported"
  );
  throwsWith(() => describe("nano.A0.current", "events"), "observes a voltage");
  throwsWith(() => describe("A0.voltage", "step"), "not instance.port.field");
  console.log(
    "observe: a descriptor with another phase or reference is refused"
  );
}

// The identity: descriptors, metric definitions, observer code.
const temps: string[] = [];
try {
  const rows = [
    describe("servo.shaft.angle", "frame"),
    describe("servo.shaft.angle", "step"),
  ];
  const build = observerBuild();
  const base = comparisonIdentity(rows, build);
  expect(base === comparisonIdentity(rows, build), "the identity is stable");
  expect(
    base !== comparisonIdentity([rows[0] as ObservationDescriptor], build),
    "a dropped cadence moves the identity"
  );
  expect(
    base !==
      comparisonIdentity(
        [
          rows[0] as ObservationDescriptor,
          describe("servo.V+.current", "step"),
        ],
        build
      ),
    "another quantity moves the identity"
  );
  const definition = METRICS["step-rms"] as { definition: string };
  const was = definition.definition;
  definition.definition = `${was}, time-weighted`;
  const redefined = comparisonIdentity(rows, build);
  definition.definition = was;
  expect(base !== redefined, "a metric definition moves the identity");
  expect(
    base === comparisonIdentity(rows, build),
    "the definition is restored"
  );

  // The observer's code as a tree: a reflow and a comment are not a
  // change; a changed token in a listed function is, in any listed file,
  // with every package version as it is; an unlisted function is not.
  const from = observerDir();
  const copyOf = () => {
    const root = mkdtempSync(join(tmpdir(), "sfab-observer-"));
    temps.push(root);
    const dir = join(root, "packages", "sim", "src");
    for (const { file } of OBSERVER_SOURCES) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      cpSync(join(from, file), join(dir, file));
    }
    return dir;
  };
  const copy = copyOf();
  expect(observerBuild(copy) === build, "a copy has the same fingerprint");
  execFileSync(
    "npx",
    [
      "biome",
      "format",
      "--write",
      "--line-width=40",
      "--indent-style=tab",
      "--javascript-formatter-quote-style=single",
      "--semicolons=as-needed",
      "--trailing-commas=none",
      ...OBSERVER_SOURCES.map(({ file }) => join(copy, file)),
    ],
    { stdio: "pipe" }
  );
  for (const { file } of OBSERVER_SOURCES) {
    appendFileSync(join(copy, file), "\n// a comment\n");
  }
  expect(
    observerBuild(copy) === build,
    "a reflow and a comment keep the fingerprint"
  );
  const edits: [string, string, string, boolean][] = [
    ["compare.ts", "pair.gap > worst.gap", "pair.gap >= worst.gap", true],
    ["observe.ts", "`step ${n}`", "`step ${n + 1}`", true],
    [
      "session/ports.ts",
      "return { voltage: 0,",
      "return { voltage: 1e-9,",
      true,
    ],
    [
      "sim.ts",
      "for (const observer of s.observers) observer.step?.(n, s.perMs);",
      "",
      true,
    ],
    [
      "session/boards.ts",
      "if (board.cycles() === 0)",
      "if (board.cycles() === 1)",
      true,
    ],
    ["session/boards.ts", "startStep / s.perMs", "startStep", true],
    [
      "../../engine-mcu/src/board-adc.ts",
      "cycle: cpu.cycles,",
      "cycle: 0,",
      true,
    ],
    ["session/boards.ts", "ms: stepEndMs(s),", "ms: stepEndMs(s) + 1,", false],
  ];
  for (const [file, was, now, moves] of edits) {
    const dir = copyOf();
    const text = readFileSync(join(dir, file), "utf8");
    expect(text.includes(was), `${file} has ${was}`);
    writeFileSync(join(dir, file), text.replace(was, now));
    const moved = observerBuild(dir);
    expect(
      (moved !== build) === moves &&
        (comparisonIdentity(rows, moved) !== base) === moves,
      `${file}: ${was} → ${now} should ${moves ? "move" : "keep"} the identity`
    );
  }
  console.log(
    `observe: the identity moves with a descriptor, a metric definition and a token of the observer's code in ${OBSERVER_SOURCES.map(({ file }) => file).join(", ")}; a reflow, a comment and an unlisted function do not`
  );
} finally {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
}

// A validity item that appears or vanishes is named; an equal set is quiet.
{
  const none: Validity = {
    envelope: [],
    stale: [],
    unchecked: [],
    degraded: [],
  };
  const out: Validity = {
    ...none,
    envelope: [
      {
        path: "p",
        ref: "pub/snap@1.0.0",
        port: "VBUS",
        quantity: "Current",
        range: "0..0.5",
      },
    ],
  };
  expect(validityDiff(out, out).length === 0, "an equal set is quiet");
  const gone = validityDiff(out, none);
  const added = validityDiff(none, {
    ...none,
    stale: [{ path: "p", ref: "pub/snap@1.0.0" }],
  });
  expect(
    gone.length === 1 && gone[0]?.startsWith("gone envelope") === true,
    `gone ${JSON.stringify(gone)}`
  );
  expect(
    added.length === 1 && added[0]?.startsWith("new stale") === true,
    `added ${JSON.stringify(added)}`
  );
  console.log("observe: a validity item that appears or vanishes is named");
}

// A live reader: the ADC fixture converts A1, A2 and A3 inside one master
// step, then A1 again on the internal reference.
{
  const muxes = ["A0", "A1", "A2", "A3"];
  const rows = muxes.map((mux) => describe(`nano.${mux}.voltage`, "events"));
  const run = async () => {
    const sim = newSim();
    try {
      const loaded = await sim.load({
        project: adcDir,
        world: "channels.world.json",
        generation: 1,
      });
      expect(loaded.ok, "the ADC fixture loads");
      return await observeRun(sim, rows, 500);
    } finally {
      sim.dispose();
    }
  };
  const first = await run();
  const again = await run();
  const all = rows.flatMap((row) => first.series.get(descriptorId(row)) ?? []);
  const keys = new Set(all.map((row) => row.key));
  expect(keys.size === all.length, "every conversion has its own instant");
  const perStep = new Map<number, number>();
  for (const row of all) {
    const step = Math.floor(row.ms);
    perStep.set(step, (perStep.get(step) ?? 0) + 1);
  }
  const busiest = Math.max(...perStep.values());
  expect(busiest >= 3, `at most ${busiest} conversions in one master step`);
  const a1 = first.series.get("nano.A1.voltage events") ?? [];
  const modes = a1.map((row) => row.reference?.mode).join(",");
  expect(modes === "avcc,bandgap", `A1 references ${modes}`);
  // A1 is wired to the board's own 5 V: on AVCC the held sample is the
  // latched reference itself; on the internal reference that is 1.1 V.
  const [onAvcc, onBandgap] = a1;
  expect(
    onAvcc !== undefined &&
      onAvcc.value > 4 &&
      onAvcc.value === onAvcc.reference?.volts &&
      onBandgap?.reference?.volts === 1.1 &&
      onBandgap.value === onAvcc.value,
    `A1 samples ${JSON.stringify(a1)}`
  );
  for (const row of rows) {
    const id = descriptorId(row);
    const paired = pairByKey(
      first.series.get(id) ?? [],
      again.series.get(id) ?? []
    );
    expect(
      paired.pairs.length > 0 &&
        paired.unmatched.length === 0 &&
        reduce("event-max", paired.pairs)?.value === 0,
      `${id} twice: ${JSON.stringify(paired.unmatched)}`
    );
  }
  console.log(
    `observe: ${all.length} live conversions, ${busiest} in one master step, A1 on ${modes}; the same run twice pairs them all with no gap`
  );

  // A reload restarts the CPU's cycles at 0. Its conversions count from
  // the step the new CPU first runs in, so the same cycle is a new instant.
  // Two reloads at one boundary: only the second CPU ever runs.
  const reloaded = async (reloads: number) => {
    const sim = newSim();
    try {
      const loaded = await sim.load({
        project: adcDir,
        world: "channels.world.json",
        generation: 1,
      });
      expect(loaded.ok, "the ADC fixture loads");
      const before = await observeRun(sim, rows, 11);
      for (let i = 0; i < reloads; i++) {
        await sim.accept({ type: "reloadBoard", board: "nano", generation: 1 });
      }
      const after = await observeRun(sim, rows, 489);
      return rows.map((row) => [
        ...(before.series.get(descriptorId(row)) ?? []),
        ...(after.series.get(descriptorId(row)) ?? []),
      ]);
    } finally {
      sim.dispose();
    }
  };
  for (const reloads of [1, 2]) {
    const [a0 = []] = await reloaded(reloads);
    const [boot, reload] = a0;
    expect(
      a0.length === 2 &&
        boot !== undefined &&
        reload !== undefined &&
        boot.key !== reload.key &&
        boot.key.endsWith(reload.key.slice(reload.key.indexOf(":"))) &&
        Math.abs(reload.ms - boot.ms - 11) < 1e-9,
      `${reloads} reload(s): A0 ${JSON.stringify(a0)}`
    );
    expect(
      pairByKey(a0, a0).pairs.length === 2,
      "the reloaded run pairs with itself"
    );
  }
  const once = await reloaded(1);
  const twice = await reloaded(2);
  for (const [i, row] of rows.entries()) {
    const paired = pairByKey(once[i] ?? [], twice[i] ?? []);
    expect(
      paired.unmatched.length === 0 &&
        reduce("event-max", paired.pairs)?.value === 0,
      `${descriptorId(row)} one reload vs two: ${JSON.stringify(paired.unmatched)}`
    );
  }
  console.log(
    "observe: a reload converts the same cycle again at a new instant, 11 ms later; one reload and two at the same boundary pair with no gap"
  );
}

console.log("observe.selfcheck ok");
