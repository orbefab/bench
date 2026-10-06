/**
 * Resolutions and the verdicts they give (run 7 unit 3b).
 *
 * - Library lint accepts the run 7 vocabulary and nothing else.
 * - `steady@1` qualifies a pair by the source side's whole-window
 *   excursion: at rest from t = 0 the first and last W are excluded; a
 *   turning point is moving although its speed is zero; a slow drift below
 *   the limit qualifies and motion above it does not; a slow candidate and
 *   a settled offset are judged; a gap equal to the threshold is within.
 * - `within-ratings` reads the effective instance ratings; a rated reading
 *   that is missing is a reason, never inside.
 * - A reader is judged at its conversions, as a ratio to the reference it
 *   latched: a varying reference cancels; a conversion on another
 *   reference, or on a zero one, is excluded with its reason; one with no
 *   counterpart is counted, never zipped by order.
 * - Two criteria on one quantity are judged apart.
 * - The gate on a stored row is red on any change to a criterion's
 *   coverage, threshold, source, verdict or numbers, and the policy hash
 *   moves with a resolution's value, window or source.
 * - Live: the ADC fixture's reader, a ratings override, and a renamed and
 *   wrapped reader and servo judge the same as the originals.
 */

import { ok as expect } from "node:assert/strict";
import {
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

import type {
  Diagnostic,
  PartFile,
  PartTypeFile,
  Resolution,
} from "@sfab-bench/contract";
import {
  expandPartType,
  type LiveInstance,
  lintResolutions,
  loadWorldV2,
  sha256Bytes,
  siValue,
} from "@sfab-bench/parts";
import {
  type Criterion,
  criteriaFor,
  descriptorFor,
  type Judged,
  judge,
  pairByKey,
  policyIdentity,
} from "@sfab-bench/sim/compare";
import {
  describe,
  descriptorId,
  type Observation,
  type ObservedRun,
  observeRun,
} from "@sfab-bench/sim/observe";
import {
  type ConversionEvent,
  Sim,
  type SimObserver,
} from "@sfab-bench/sim/sim";
import { type QuantityRow, rowProblems } from "./assembly-check";
import { projectReal, readerFor, readInside } from "./world/files";
import { nodeStore } from "./world/node-store";
import { packageVersion } from "./world/package-version";
import { nodePlanEnv } from "./world/plan-host";

const catalog = fileURLToPath(new URL("../catalog/", import.meta.url));
const adcDir = fileURLToPath(new URL("../fixtures/adc/", import.meta.url));
const armDir = fileURLToPath(
  new URL("../../../examples/arm/", import.meta.url)
);

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

const SOURCE = { title: "a datasheet", ref: "a table" };

// 1. Lint: the run 7 vocabulary, and nothing else.
{
  const type: PartTypeFile = {
    format: "sfab.part-type@1",
    id: "probe",
    ports: {
      "5V": { domain: "electrical", role: "power" },
      A0: { domain: "electrical", role: "analog" },
      I: { domain: "electrical", role: "power" },
      shaft: { domain: "rotational" },
    },
  };
  const precision: Resolution = {
    field: "angle",
    kind: "precision",
    value: 0.01,
    reference: { kind: "absolute" },
    conditions: [{ kind: "steady@1", window: 0.06 }],
    source: SOURCE,
  };
  const reader: Resolution = {
    field: "voltage",
    kind: "reader",
    value: 1 / 1024,
    reference: { kind: "ratio-to", quantity: "5V.voltage" },
    conditions: [{ kind: "within-ratings" }],
    source: SOURCE,
  };
  const lint = (resolution: Record<string, unknown[]>): Diagnostic[] => {
    const diags: Diagnostic[] = [];
    lintResolutions(
      {
        format: "sfab.part@1",
        id: "pub/probe@1.0.0",
        type: "probe",
        resolution: resolution as PartFile["resolution"],
        axes: {},
      } as PartFile,
      type,
      diags
    );
    return diags;
  };
  const clean = lint({ shaft: [precision], A0: [reader] });
  expect(
    clean.length === 0,
    `the vocabulary lints clean: ${clean[0]?.message}`
  );
  const refused: [string, Record<string, unknown[]>, string][] = [
    [
      "an unknown condition",
      { shaft: [{ ...precision, conditions: [{ kind: "settled-for" }] }] },
      "is not within-ratings or steady@1",
    ],
    [
      "an unknown reference",
      { shaft: [{ ...precision, reference: { kind: "offset-to" } }] },
      "is not absolute or ratio-to",
    ],
    [
      "a ratio whose units do not cancel",
      {
        A0: [
          { ...reader, reference: { kind: "ratio-to", quantity: "I.current" } },
        ],
      },
      "is not a Voltage",
    ],
    [
      "a ratio to a port the part does not have",
      {
        A0: [
          {
            ...reader,
            reference: { kind: "ratio-to", quantity: "AREF.voltage" },
          },
        ],
      },
      "is not PORT.field on this part",
    ],
    [
      "a ratio value tagged as a voltage",
      {
        A0: [
          {
            ...reader,
            value: { v: 0.001, q: "Voltage", d: { kg: 1, m: 2, s: -3, A: -1 } },
          },
        ],
      },
      "not Dimensionless",
    ],
    [
      "an absolute value in another quantity",
      {
        shaft: [
          {
            ...precision,
            value: { v: 0.01, q: "Voltage", d: { kg: 1, m: 2, s: -3, A: -1 } },
          },
        ],
      },
      "not Angle",
    ],
    [
      "a zero value",
      { shaft: [{ ...precision, value: 0 }] },
      "not finite and positive",
    ],
    [
      "no source",
      { shaft: [{ ...precision, source: { title: "", ref: "x" } }] },
      "no source",
    ],
    [
      "a precision without steady@1",
      { shaft: [{ ...precision, conditions: [] }] },
      "it needs steady@1",
    ],
    [
      "a reader with steady@1",
      { A0: [{ ...reader, conditions: [{ kind: "steady@1", window: 0.06 }] }] },
      "judged at its conversions",
    ],
    [
      "a window that is not a time",
      {
        shaft: [
          { ...precision, conditions: [{ kind: "steady@1", window: -1 }] },
        ],
      },
      "window -1 is not finite and positive",
    ],
    [
      "a field the domain does not carry",
      { A0: [{ ...precision, field: "angle" }] },
      "is not one a electrical port carries",
    ],
    [
      "an unknown key",
      { shaft: [{ ...precision, epsilon: 2 }] },
      "unknown key epsilon",
    ],
    [
      "a port the type does not have",
      { D9: [precision] },
      "resolution names a port the type does not have",
    ],
    [
      "a reader of an angle",
      {
        shaft: [
          {
            ...reader,
            field: "angle",
            reference: { kind: "absolute" },
            value: 0.01,
          },
        ],
      },
      "which read a voltage",
    ],
    [
      "two windows",
      {
        shaft: [
          {
            ...precision,
            conditions: [
              { kind: "steady@1", window: 0.06 },
              { kind: "steady@1", window: 0.01 },
            ],
          },
        ],
      },
      "steady@1 is stated twice",
    ],
    [
      "a ratio with another key",
      {
        A0: [
          {
            ...reader,
            reference: { kind: "ratio-to", quantity: "5V.voltage", note: "x" },
          },
        ],
      },
      "takes a quantity and nothing else",
    ],
    [
      "two of one field and kind",
      { shaft: [precision, precision] },
      "two angle precision resolutions",
    ],
  ];
  for (const [what, resolution, says] of refused) {
    const diags = lint(resolution);
    expect(
      diags.some(
        (diag) => diag.severity === "error" && diag.message.includes(says)
      ),
      `${what} is refused with "${says}": ${diags.map((diag) => diag.message).join(" | ") || "accepted"}`
    );
  }
  console.log(
    `budget: lint accepts the vocabulary and refuses ${refused.length} shapes outside it`
  );
}

// 2. Criteria come from the fields: a part's own replaces the type's, and
// two criteria on one quantity are judged apart.
const precisionOf = (value: number, windowS: number): Resolution => ({
  field: "voltage",
  kind: "precision",
  value,
  reference: { kind: "absolute" },
  conditions: [{ kind: "steady@1", window: windowS }],
  source: SOURCE,
});
{
  const reader: Resolution = {
    field: "voltage",
    kind: "reader",
    value: 0.01,
    reference: { kind: "absolute" },
    source: SOURCE,
  };
  const type = expandPartType({
    format: "sfab.part-type@1",
    id: "probe",
    ports: {},
    templates: [
      {
        id: "P{n}",
        n: [0, 1],
        domain: "electrical",
        role: "analog",
        resolution: [reader, precisionOf(0.5, 0.01)],
      },
    ],
  });
  const part = {
    id: "pub/probe@1.0.0",
    type: "probe",
    resolution: { P1: [precisionOf(0.02, 0.01)] },
  } as unknown as PartFile;
  const inst = { path: "x", type, part };
  const p0 = criteriaFor([inst], "x.P0.voltage");
  const p1 = criteriaFor([inst], "x.P1.voltage");
  expect(
    p0.length === 2 &&
      p0.every((row) => row.from === "probe P0") &&
      p1.length === 2 &&
      p1.find((row) => row.resolution.kind === "precision")?.from ===
        "pub/probe@1.0.0 P1" &&
      p1.find((row) => row.resolution.kind === "precision")?.threshold === 0.02,
    `criteria ${JSON.stringify([p0, p1].map((list) => list.map((row) => [row.from, row.threshold])))}`
  );
  // One quantity, two criteria: the precision judges settled steps, the
  // reader its conversions, each with its own threshold and verdict.
  const steps = (offset: number) =>
    Array.from({ length: 101 }, (_, n) => ({
      key: `step ${n}`,
      ms: n,
      value: 5 + offset,
    }));
  const events = (offset: number) => [
    { key: "conversion 0:100", ms: 50, value: 2 + offset },
  ];
  const [readerCriterion, precision] = p1;
  if (!readerCriterion || !precision) throw new Error("two criteria");
  const byPrecision = judge(
    precision,
    pairByKey(steps(0), steps(0.03)),
    steps(0),
    100,
    1
  );
  const byReader = judge(
    readerCriterion,
    pairByKey(events(0), events(0.005)),
    events(0),
    100,
    1
  );
  expect(
    byPrecision.verdict === "over" &&
      byPrecision.metrics[0]?.metric === "settled-max" &&
      byReader.verdict === "within" &&
      byReader.metrics[0]?.metric === "event-max",
    `two criteria: ${byPrecision.verdict} and ${byReader.verdict}`
  );
  console.log(
    "budget: a part's own resolution replaces the type's; one quantity's two criteria are judged apart"
  );
}

// 3. steady@1 on the source side's whole-window excursion.
{
  const H = 1000;
  const series = (fn: (t: number) => number): Observation[] =>
    Array.from({ length: H + 1 }, (_, t) => ({
      key: `step ${t}`,
      ms: t,
      value: fn(t),
    }));
  const criterion: Criterion = {
    quantity: "x.shaft.angle",
    from: "probe shaft",
    resolution: precisionOf(0.01, 0.06),
    threshold: 0.01,
    windowMs: 60,
  };
  const run = (a: (t: number) => number, b: (t: number) => number): Judged => {
    const source = series(a);
    return judge(criterion, pairByKey(source, series(b)), source, H, 1);
  };
  const qualifies = (judged: Judged, total: number) =>
    judged.coverage.qualified === total;

  const rest = run(
    () => 1,
    () => 1.005
  );
  expect(
    qualifies(rest, H + 1 - 120) &&
      rest.coverage.excluded["start or end of run"] === 120 &&
      rest.verdict === "within",
    `at rest from t = 0: ${JSON.stringify(rest.coverage)}`
  );
  // A turning point: zero speed at t = 500, yet the window moves 0.0144.
  const turn = run(
    (t) => 1 - 4e-6 * (t - 500) ** 2,
    (t) => 1 - 4e-6 * (t - 500) ** 2
  );
  expect(
    (turn.coverage.excluded.moving ?? 0) > 0 &&
      !qualifiedAt(criterion, (t) => 1 - 4e-6 * (t - 500) ** 2, 500),
    `a turning point is moving: ${JSON.stringify(turn.coverage)}`
  );
  // The whole window, not its ends: out and back within W is moving.
  expect(
    !qualifiedAt(criterion, (t) => (Math.abs(t - 500) < 30 ? 1.02 : 1), 500),
    "an excursion that returns inside the window is moving"
  );
  const drift = run(
    (t) => 1e-5 * t,
    (t) => 1e-5 * t
  );
  expect(
    qualifies(drift, H + 1 - 120),
    `a slow drift below the limit qualifies: ${JSON.stringify(drift.coverage)}`
  );
  const moving = run(
    (t) => 1e-3 * t,
    (t) => 1e-3 * t
  );
  expect(
    moving.verdict === "none" &&
      moving.reason === "no settled samples" &&
      moving.coverage.excluded.moving === H + 1 - 120,
    `motion above the limit all run: ${JSON.stringify(moving)}`
  );
  // A slow candidate against a source that settles: judged, and over.
  const slow = run(
    (t) => (t < 200 ? 0 : 1),
    (t) => (t < 200 ? 0 : 1 - Math.exp(-(t - 200) / 300))
  );
  expect(
    slow.verdict === "over" && slow.coverage.qualified > 600,
    `a slow candidate: ${slow.verdict}, ${JSON.stringify(slow.coverage)}`
  );
  const offset = run(
    () => 1,
    () => 1.02
  );
  // 0 and 0.01 are exact: the gap is the threshold itself.
  const edge = run(
    () => 0,
    () => 0.01
  );
  expect(
    offset.verdict === "over" &&
      Math.abs(offset.by - 0.01) < 1e-12 &&
      edge.verdict === "within",
    `a settled offset: ${offset.verdict}; on the threshold: ${edge.verdict}`
  );
  console.log(
    "budget: steady@1 excludes the first and last W, a turning point and an excursion inside the window; a slow drift qualifies; a slow candidate and an offset are judged over"
  );
}

/** Whether `steady@1` qualifies the pair at `t` of `fn` against itself. */
function qualifiedAt(
  criterion: Criterion,
  fn: (t: number) => number,
  t: number
): boolean {
  const source = Array.from({ length: 1001 }, (_, n) => ({
    key: `step ${n}`,
    ms: n,
    value: fn(n),
  }));
  const one = source.filter((row) => row.ms === t);
  return (
    judge(criterion, pairByKey(one, one), source, 1000, 1).coverage
      .qualified === 1
  );
}

// 4. within-ratings: a missing reading is a reason, never inside.
{
  const criterion: Criterion = {
    quantity: "x.A0.voltage",
    from: "probe A0",
    resolution: {
      field: "voltage",
      kind: "reader",
      value: 0.01,
      reference: { kind: "absolute" },
      conditions: [{ kind: "within-ratings" }],
      source: SOURCE,
    },
    threshold: 0.01,
    ratings: [
      { quantity: "x.5V.voltage", rating: "5V.voltage", range: [4.5, 5.5] },
    ],
  };
  const at = (supply: number | null): Observation[] => [
    {
      key: "conversion 0:1",
      ms: 1,
      value: 1,
      with: { "x.5V.voltage": supply },
    },
  ];
  const reasons = [5, 0, 6, null].map(
    (supply) =>
      judge(criterion, pairByKey(at(supply), at(supply)), [], 10, 1).coverage
        .excluded
  );
  expect(
    JSON.stringify(reasons) ===
      JSON.stringify([
        {},
        { "out of ratings: 5V.voltage": 1 },
        { "out of ratings: 5V.voltage": 1 },
        { "ratings not observed: x.5V.voltage": 1 },
      ]),
    `within-ratings reasons ${JSON.stringify(reasons)}`
  );
  const unobserved = judge(
    { ...criterion, unobserved: ["shaft.torque"] },
    pairByKey(at(5), at(5)),
    [],
    10,
    1
  );
  expect(
    unobserved.verdict === "none" &&
      unobserved.coverage.excluded["ratings not observed: shaft.torque"] === 1,
    `a rating no observation reads: ${JSON.stringify(unobserved)}`
  );
  console.log(
    "budget: within-ratings passes in range, and an unpowered, out-of-rating or unread source is a reason"
  );
}

// 5. A reader through observeRun, on a scripted run: each conversion
// divided by the reference it latched, bound to the port it was read on.
type Scripted = Omit<
  ConversionEvent,
  "board" | "mux" | "count" | "ms" | "startStep"
>;
function scriptedRun(
  events: Scripted[],
  supply: number | null
): Promise<ObservedRun> {
  let observer: SimObserver | null = null;
  let n = 0;
  const sim = {
    portReading(path: string, port: string) {
      if (path !== "b" || port !== "5V") return null;
      return { voltage: supply, current: null, angle: null };
    },
    observe(next: SimObserver) {
      observer = next;
      return () => {
        observer = null;
      };
    },
    async step(steps: number) {
      for (let i = 0; i < steps; i++) {
        for (const event of events.filter(
          (row) => row.cycle >= n * 16000 && row.cycle < (n + 1) * 16000
        )) {
          observer?.conversion?.({
            board: "b",
            mux: "A0",
            count: 0,
            startStep: 0,
            ms: event.cycle / 16000,
            ...event,
          });
        }
        n++;
        observer?.step?.(n, 1);
      }
    },
    report: () => null,
  } as unknown as Sim;
  const row = describe(
    "b.A0.voltage",
    "events",
    { kind: "ratio-to", quantity: "b.5V.voltage" },
    ["b.5V.voltage"]
  );
  return observeRun(sim, [row], 3);
}
{
  const criterion: Criterion = {
    quantity: "b.A0.voltage",
    from: "probe A0",
    resolution: {
      field: "voltage",
      kind: "reader",
      value: 1 / 1024,
      reference: { kind: "ratio-to", quantity: "5V.voltage" },
      conditions: [{ kind: "within-ratings" }],
      source: SOURCE,
    },
    threshold: 1 / 1024,
    ratings: [
      { quantity: "b.5V.voltage", rating: "5V.voltage", range: [4.5, 5.5] },
    ],
  };
  const id = descriptorId(descriptorFor(criterion));
  const avcc = (cycle: number, vRef: number, voltage = vRef): Scripted => ({
    cycle,
    ref: "avcc",
    vRef,
    referencePort: "5V",
    voltage,
  });
  const judgeRuns = async (a: Scripted[], b: Scripted[], supply = 5) => {
    const left = (await scriptedRun(a, supply)).series.get(id) ?? [];
    const right = (await scriptedRun(b, supply)).series.get(id) ?? [];
    return judge(criterion, pairByKey(left, right), left, 3, 1);
  };
  // The pin is tied to the rail: a varying reference cancels in the ratio.
  const varying = await judgeRuns(
    [avcc(100, 4.8), avcc(20000, 5.0), avcc(40000, 5.2)],
    [avcc(100, 5.1), avcc(20000, 4.9), avcc(40000, 5.0)]
  );
  expect(
    varying.verdict === "within" &&
      varying.coverage.qualified === 3 &&
      varying.metrics[0]?.value === 0,
    `a varying reference: ${JSON.stringify(varying)}`
  );
  // A conversion on the internal reference is not judged as a ratio to 5V,
  // nor one on a zero reference; one with no counterpart is counted.
  const bandgap: Scripted = {
    cycle: 300,
    ref: "bandgap",
    vRef: 1.1,
    referencePort: null,
    voltage: 1,
  };
  // An AVCC conversion read on another port: the port binds, not the mode.
  const vin: Scripted = { ...avcc(600, 5), referencePort: "VIN" };
  const excluded = await judgeRuns(
    [avcc(100, 5), bandgap, avcc(500, 0, 0), vin, avcc(700, 5)],
    [avcc(100, 5), bandgap, avcc(500, 0, 0), vin, avcc(900, 5)]
  );
  expect(
    excluded.verdict === "within" &&
      excluded.coverage.qualified === 1 &&
      excluded.coverage.excluded["a: reference bandgap is not 5V"] === 1 &&
      excluded.coverage.excluded["a: reference avcc is not 5V"] === 1 &&
      excluded.coverage.excluded[
        "a: reference avcc is not finite and non-zero"
      ] === 1 &&
      excluded.coverage.excluded["no counterpart"] === 2,
    `exclusions: ${JSON.stringify(excluded.coverage)}`
  );
  // A data-dependent schedule: three conversions in one step on each side,
  // at other instants on the other side. None zips with another by order.
  const moved = await judgeRuns(
    [avcc(100, 5), avcc(200, 5), avcc(300, 5, 1)],
    [avcc(150, 5), avcc(250, 5), avcc(300, 5, 1)]
  );
  expect(
    moved.coverage.qualified === 1 &&
      moved.coverage.excluded["no counterpart"] === 4,
    `a moved schedule: ${JSON.stringify(moved.coverage)}`
  );
  const silent = await judgeRuns([], []);
  const unpowered = await judgeRuns([avcc(100, 5)], [avcc(100, 5)], 0);
  expect(
    silent.verdict === "none" &&
      silent.reason === "not read" &&
      unpowered.verdict === "none" &&
      unpowered.reason === "no qualified conversions" &&
      unpowered.coverage.excluded["out of ratings: 5V.voltage"] === 1,
    `not read: ${JSON.stringify(silent)}; unpowered: ${JSON.stringify(unpowered)}`
  );
  console.log(
    "budget: a reader's ratio cancels a varying reference; another reference, a zero one, an unmatched or a moved conversion is excluded and counted; no conversion is not read"
  );
}

// 6. The gate on a stored row: every change to a criterion's applicability,
// verdict or numbers is red, and so is a change to what judges it.
{
  const record = readJson<{
    document: string;
    policy: string;
    quantities: string[];
    rows: QuantityRow[];
  }>(join(armDir, "checks/sfab/arm-bench@1.0.0.json"));
  const stored = record.rows.find((row) => row.criteria.length > 0);
  const bare = record.rows.find((row) => row.criteria.length === 0);
  if (!stored || !bare)
    throw new Error("the arm record judges one row and not another");
  expect(rowProblems(stored, stored).length === 0, "a row matches itself");
  type Row = QuantityRow;
  const criterion = (
    row: Row,
    edit: (c: Row["criteria"][number]) => Row["criteria"][number]
  ): Row => ({
    ...row,
    criteria: row.criteria.map((c, i) => (i === 0 ? edit(c) : c)),
  });
  const mutations: [string, Row, Row][] = [
    [
      "within to over",
      stored,
      criterion(stored, (c) => ({ ...c, verdict: "over", by: 1e-4 })),
    ],
    [
      "within to none",
      stored,
      criterion(stored, (c) => ({
        ...c,
        verdict: "none",
        reason: "no settled samples",
      })),
    ],
    [
      "one more qualified pair",
      stored,
      criterion(stored, (c) => ({
        ...c,
        coverage: { ...c.coverage, qualified: c.coverage.qualified + 1 },
      })),
    ],
    [
      "another exclusion count",
      stored,
      criterion(stored, (c) => ({
        ...c,
        coverage: {
          ...c.coverage,
          excluded: { ...c.coverage.excluded, moving: 0 },
        },
      })),
    ],
    [
      "another threshold",
      stored,
      criterion(stored, (c) => ({ ...c, threshold: c.threshold * 2 })),
    ],
    [
      "another source",
      stored,
      criterion(stored, (c) => ({ ...c, from: "probe shaft" })),
    ],
    [
      "settled-max x 1.001",
      stored,
      criterion(stored, (c) => ({
        ...c,
        metrics: c.metrics.map((m) =>
          m.metric === "settled-max" ? { ...m, value: m.value * 1.001 } : m
        ),
      })),
    ],
    [
      "settled-max set at another time",
      stored,
      criterion(stored, (c) => ({
        ...c,
        metrics: c.metrics.map((m) =>
          m.at ? { ...m, at: { ...m.at, ms: m.at.ms + 1 } } : m
        ),
      })),
    ],
    [
      "a criterion gone",
      stored,
      { ...stored, criteria: [], verdict: "none", reason: "no resolution" },
    ],
    [
      "a criterion where there was none",
      bare,
      {
        ...bare,
        criteria: stored.criteria,
        verdict: undefined,
        reason: undefined,
      },
    ],
    ["out of domain", bare, { ...bare, inDomain: !bare.inDomain }],
    [
      "a row's frame-max x 1.001",
      bare,
      {
        ...bare,
        metrics: bare.metrics.map((m) =>
          m.metric === "frame-max" ? { ...m, value: m.value * 1.001 } : m
        ),
      },
    ],
    [
      "the stored citation edited",
      stored,
      criterion(stored, (c) => ({
        ...c,
        source: { ...c.source, title: `${c.source.title}.` },
      })),
    ],
  ];
  for (const [what, was, now] of mutations) {
    expect(rowProblems(was, now).length > 0, `${what} is red`);
  }
  // The policy: today's criteria hash to the stored one; another value or
  // window for one resolution does not.
  const instances = instancesOf(armDir, record.document);
  const criteria = record.quantities.flatMap((quantity) =>
    criteriaFor(instances, quantity)
  );
  expect(
    policyIdentity(criteria) === record.policy,
    "the stored policy is today's"
  );
  const [first, ...rest] = criteria;
  if (!first) throw new Error("the arm has a criterion");
  const edited = (resolution: Resolution) =>
    policyIdentity([{ ...first, resolution }, ...rest]);
  expect(
    edited({
      ...first.resolution,
      value: siValue(first.resolution.value) * 2,
    }) !== record.policy &&
      edited({
        ...first.resolution,
        conditions: [{ kind: "steady@1", window: 0.08 }],
      }) !== record.policy &&
      policyIdentity([{ ...first, from: "probe shaft" }, ...rest]) !==
        record.policy,
    "another value, window or source is another policy"
  );
  console.log(
    `budget: the gate is red on ${mutations.length} row changes and on another value, window or source in the policy`
  );
}

// 7. Live readers and servos: the ADC fixture, a ratings override, and a
// renamed and wrapped reader and servo.
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

function instancesOf(project: string, world: string): LiveInstance[] {
  return loadWorldV2(join(project, world), {
    store: nodeStore,
    catalogDir: catalog,
    assetRoot: project,
  }).resolved;
}

/** The path of the instance of `part` in `world` (the test knows its parts). */
function pathOf(project: string, world: string, part: string): string {
  const found = instancesOf(project, world).find((row) => row.part.id === part);
  if (!found) throw new Error(`${world}: no instance of ${part}`);
  return found.path;
}

/** Each port field's criteria, judged on one run of `world` against itself. */
async function judgeLive(
  project: string,
  world: string,
  part: string,
  fields: string[],
  ms: number
): Promise<Judged[]> {
  const path = pathOf(project, world, part);
  const instances = instancesOf(project, world);
  const criteria = fields.flatMap((field) =>
    criteriaFor(instances, `${path}.${field}`)
  );
  const rows = criteria.map(descriptorFor);
  const sim = newSim();
  let run: ObservedRun;
  try {
    const loaded = await sim.load({ project, world, generation: 1 });
    if (!loaded.ok) {
      throw new Error(loaded.errors.map((row) => row.message).join("; "));
    }
    run = await observeRun(sim, rows, ms);
  } finally {
    sim.dispose();
  }
  return criteria.map((criterion, i) => {
    const row = rows[i];
    if (!row) throw new Error("a descriptor per criterion");
    const source = run.series.get(descriptorId(row)) ?? [];
    return judge(criterion, pairByKey(source, source), source, ms, 1);
  });
}

/** `judged` without what names the part: what a verdict must not depend on. */
function anonymous(judged: Judged[]): string {
  return JSON.stringify(
    judged.map(({ quantity: _q, from: _f, ...rest }) => rest)
  );
}

const temps: string[] = [];
function copyOf(name: string, from: string): string {
  const dir = mkdtempSync(join(tmpdir(), `sfab-budget-${name}-`));
  temps.push(dir);
  cpSync(from, dir, { recursive: true });
  return dir;
}
function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

/** An assembly part holding one instance, `name`, of `part`. */
function wrapper(id: string, name: string, part: string): PartFile {
  const none = (omit: string) => ({
    "0": {
      default: "none",
      variants: { none: { kind: "none", omits: [omit] } },
    },
  });
  return {
    format: "sfab.part@1",
    id,
    type: "assembly",
    foreign: false,
    axes: {
      behaviour: {
        "2": {
          default: "netlist",
          variants: {
            netlist: {
              kind: "composite",
              omits: ["a wrapper adds nothing"],
              netlist: {
                instances: { [name]: { part } },
                wires: [],
                expose: {},
              },
            },
          },
        },
      },
      body: none("assembly adds no body"),
      visual: none("assembly adds no visual"),
    },
  } as unknown as PartFile;
}

try {
  const WORLD = "channels.world.json";
  const NANO = "sfab/nano-ch340@1.0.0";
  const muxes = ["A0.voltage", "A1.voltage"];
  const live = await judgeLive(adcDir, WORLD, NANO, muxes, 500);
  const [, a1] = live;
  expect(
    live.length === 2 &&
      live.every((row) => row.verdict === "within") &&
      a1?.coverage.qualified === 1 &&
      Object.keys(a1.coverage.excluded).length === 1 &&
      Object.keys(a1.coverage.excluded)[0]?.startsWith("a: reference ") &&
      a1.from === "arduino-nano A1",
    `the ADC fixture's readers: ${JSON.stringify(live)}`
  );

  // A part's own rating narrows the board's 5V rail below what USB gives.
  const tight = copyOf("tight", adcDir);
  rmSync(join(tight, "channels.world.lock.json"));
  const nano = readJson<PartFile>(
    join(catalog, "parts/sfab/nano-ch340@1.0.0.json")
  );
  const TIGHT = "sfab/nano-tight@1.0.0";
  writeJson(join(tight, "parts/sfab/nano-tight@1.0.0.json"), {
    ...nano,
    id: TIGHT,
    ratings: { ...nano.ratings, "5V": { voltage: [5.3, 5.5] } },
  });
  const scene = join(tight, "parts/sfab/adc-channels-scene@1.0.0.json");
  writeFileSync(scene, readFileSync(scene, "utf8").replace(NANO, TIGHT));
  const [, overridden] = await judgeLive(tight, WORLD, TIGHT, muxes, 500);
  expect(
    overridden?.verdict === "none" &&
      overridden.reason === "no qualified conversions" &&
      overridden.coverage.excluded["out of ratings: 5V.voltage"] === 1,
    `a ratings override: ${JSON.stringify(overridden)}`
  );

  // Renamed and wrapped: another type id, part id and instance name, one
  // assembly deeper. The verdicts are the same.
  const renamed = copyOf("reader", adcDir);
  rmSync(join(renamed, "channels.world.lock.json"));
  const READER = "sfab/probe-reader@1.0.0";
  writeJson(join(renamed, "types/probe-board.json"), {
    ...readJson<PartTypeFile>(join(catalog, "types/arduino-nano.json")),
    id: "probe-board",
  });
  writeJson(join(renamed, "parts/sfab/probe-reader@1.0.0.json"), {
    ...nano,
    id: READER,
    type: "probe-board",
  });
  const inner = readFileSync(
    join(renamed, "parts/sfab/adc-channels-scene@1.0.0.json"),
    "utf8"
  )
    .replace(NANO, READER)
    .replaceAll('"nano', '"reader')
    .replace("sfab/adc-channels-scene@1.0.0", "sfab/probe-rig@1.0.0");
  writeFileSync(join(renamed, "parts/sfab/probe-rig@1.0.0.json"), inner);
  writeJson(
    join(renamed, "parts/sfab/adc-channels-scene@1.0.0.json"),
    wrapper("sfab/adc-channels-scene@1.0.0", "rig", "sfab/probe-rig@1.0.0")
  );
  const world = readJson<{
    run: { levels: { types: Record<string, unknown> } };
  }>(join(renamed, WORLD));
  world.run.levels.types = { "probe-board": { behaviour: 2 } };
  writeJson(join(renamed, WORLD), world);
  const again = await judgeLive(renamed, WORLD, READER, muxes, 500);
  expect(
    again[1]?.from === "probe-board A1" &&
      pathOf(renamed, WORLD, READER) !== "nano" &&
      anonymous(again) === anonymous(live),
    `a renamed and wrapped reader: ${JSON.stringify(again)} vs ${JSON.stringify(live)}`
  );
  console.log(
    `budget: the ADC fixture's readers are within; A1 excludes its other-reference conversion; a ratings override leaves none; renamed and wrapped (${pathOf(renamed, WORLD, READER)}), the same`
  );

  // The servo, renamed and wrapped one assembly deeper, judges the same.
  const arm = copyOf("servo", armDir);
  const SG90 = "sfab/sg90@1.0.0";
  const ACTUATOR = "sfab/probe-actuator@1.0.0";
  writeJson(join(arm, "types/probe-actuator.json"), {
    ...readJson<PartTypeFile>(join(catalog, "types/hobby-servo-3wire.json")),
    id: "probe-actuator",
  });
  writeJson(join(arm, "parts/sfab/probe-actuator@1.0.0.json"), {
    ...readJson<PartFile>(join(catalog, "parts/sfab/sg90@1.0.0.json")),
    id: ACTUATOR,
    type: "probe-actuator",
  });
  writeFileSync(
    join(arm, "parts/sfab/probe-scene@1.0.0.json"),
    readFileSync(join(arm, "parts/sfab/arm-scene@1.0.0.json"), "utf8")
      .replace(SG90, ACTUATOR)
      .replaceAll('"servo', '"actuator')
      .replace("sfab/arm-scene@1.0.0", "sfab/probe-scene@1.0.0")
  );
  writeJson(
    join(arm, "parts/sfab/probe-rig@1.0.0.json"),
    wrapper("sfab/probe-rig@1.0.0", "rig", "sfab/probe-scene@1.0.0")
  );
  const bench = readJson<PartFile & { play: Record<string, unknown> }>(
    join(arm, "parts/sfab/arm-bench@1.0.0.json")
  );
  const play = { ...bench.play, levels: { default: 2 } };
  const ORIGINAL = "parts/sfab/budget-original@1.0.0.json";
  const RENAMED = "parts/sfab/budget-renamed@1.0.0.json";
  writeJson(join(arm, ORIGINAL), {
    ...bench,
    id: "sfab/budget-original@1.0.0",
    play,
  });
  writeFileSync(
    join(arm, RENAMED),
    JSON.stringify({ ...bench, id: "sfab/budget-renamed@1.0.0", play }).replace(
      "sfab/arm-scene@1.0.0",
      "sfab/probe-rig@1.0.0"
    )
  );
  const ms = 1500;
  const original = await judgeLive(arm, ORIGINAL, SG90, ["shaft.angle"], ms);
  const actuator = await judgeLive(arm, RENAMED, ACTUATOR, ["shaft.angle"], ms);
  expect(
    original.length === 1 &&
      original[0]?.verdict === "within" &&
      (original[0]?.coverage.qualified ?? 0) > 0 &&
      actuator[0]?.from === `${ACTUATOR} shaft` &&
      anonymous(actuator) === anonymous(original),
    `a renamed and wrapped servo: ${JSON.stringify([original, actuator])}`
  );
  console.log(
    `budget: the servo renamed and wrapped (${pathOf(arm, RENAMED, ACTUATOR)}) judges the same: ${original[0]?.coverage.qualified} settled steps of ${ms + 1}, within`
  );
} finally {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
}

console.log("budget.selfcheck ok");
