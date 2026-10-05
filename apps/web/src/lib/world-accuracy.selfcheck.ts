/**
 * The document's assembly check on the cards (run 7 unit 3c): a verdict
 * only where the check is this run's, on the card of the part it was
 * measured at; the document card's summary; the out-of-domain lines; and
 * an `over-budget` warning at its path like any other.
 */
import { ok as expect } from "node:assert/strict";
import type { AccuracyRow, RunReport } from "@sfab-bench/contract";

import { accuracySummary, accuracyView } from "./world-accuracy";
import { warningsFromRun } from "./world-warnings";

const shaft: AccuracyRow = {
  quantity: "rig.actuator.shaft.angle",
  path: "rig.actuator",
  port: "shaft",
  field: "angle",
  gap: { max: 0.005436726271, rms: 0.001149827248 },
  criteria: [
    {
      kind: "precision",
      from: "sfab/sg90@1.0.0 shaft",
      threshold: 0.01692668455597949,
      window: 0.06,
      metric: "settled-max",
      value: 0.001394080567,
      coverage: {
        qualified: 2010,
        excluded: { "start or end": 120, moving: 871 },
      },
      verdict: "within",
    },
  ],
};
const supply: AccuracyRow = {
  quantity: "uno.power.VIN.voltage",
  path: "uno.power",
  port: "VIN",
  field: "voltage",
  gap: { max: 0.02, rms: 0.01 },
  criteria: [],
};

function report(accuracy: RunReport["accuracy"]): RunReport {
  return {
    warnings: [],
    errors: [],
    snapshots: [
      { path: "rig.actuator", axis: "behaviour", ref: "a", quality: "Q2a" },
    ],
    ...(accuracy ? { accuracy } : {}),
  } as unknown as RunReport;
}
const accuracy = (
  applies: boolean,
  rows: AccuracyRow[]
): NonNullable<RunReport["accuracy"]> => ({
  record: "checks/sfab/arm-bench@1.0.0.json",
  applies,
  inDomain: true,
  domain: [],
  snapshots: ["rig.actuator sfab/sg90-servo@1.0.0"],
  rows,
});

// No check, no block; a part with no row of the check, none either.
expect(accuracyView(report(undefined)) === null, "no check, no view");
expect(
  accuracyView(report(accuracy(true, [shaft, supply])), "rig.reader") === null,
  "a part the check did not measure shows nothing"
);

// The instance card: its own rows, gap, threshold, coverage and verdict.
const onServo = accuracyView(
  report(accuracy(true, [shaft, supply])),
  "rig.actuator"
);
const line = onServo?.lines[0];
const precision = line?.criteria[0];
expect(
  onServo?.applies === true &&
    onServo.lines.length === 1 &&
    onServo.domain.length === 0 &&
    line?.quantity === "shaft angle" &&
    line.gap === "gap max 0.00544 rad, rms 0.00115 rad" &&
    precision?.verdict === "within" &&
    precision.tone === "ok" &&
    precision.against ===
      "precision 0.0169 rad from sfab/sg90@1.0.0 shaft, steady@1 W 0.06 s" &&
    precision.measured ===
      "settled-max 0.00139 rad on 2010 of 3001 steps (120 start or end, 871 moving)",
  `the servo's card: ${JSON.stringify(onServo)}`
);

// The document card: every row, and its counts.
const whole = accuracyView(report(accuracy(true, [shaft, supply])));
expect(
  whole?.lines.length === 2 &&
    whole.lines[0]?.quantity === "rig.actuator.shaft angle" &&
    whole.lines[1]?.quantity === "uno.power.VIN voltage" &&
    whole.lines[1].criteria.length === 0 &&
    accuracySummary(whole) === "1 within, 1 no resolution",
  `the document's card: ${JSON.stringify(whole)}`
);

// Over, and no verdict, keep their reason and tone.
const over = accuracyView(
  report(
    accuracy(true, [
      {
        ...shaft,
        criteria: shaft.criteria.map((row) => ({
          ...row,
          verdict: "over" as const,
          by: 0.002,
        })),
      },
      {
        ...supply,
        criteria: [
          {
            kind: "precision",
            from: "sfab/uno-r3@1.0.0 VIN",
            threshold: 0.05,
            metric: "settled-max",
            coverage: { qualified: 0, excluded: { moving: 3001 } },
            verdict: "none",
            reason: "no settled samples",
          },
        ],
      },
    ])
  )
);
expect(
  over?.lines[0]?.criteria[0]?.verdict === "over by 0.002 rad" &&
    over.lines[0].criteria[0].tone === "warn" &&
    over.lines[1]?.criteria[0]?.verdict === "no verdict: no settled samples" &&
    over.lines[1].criteria[0].tone === "none" &&
    over.lines[1].criteria[0].measured ===
      "settled-max — on 0 of 3001 steps (3001 moving)" &&
    accuracySummary(over) === "1 over, 1 no verdict",
  `over and none: ${JSON.stringify(over)}`
);

// A reader judged against a ratio: no unit, the ratio named, conversions.
const reader = accuracyView(
  report(
    accuracy(true, [
      {
        ...supply,
        quantity: "rig.board.A0.voltage",
        path: "rig.board",
        port: "A0",
        criteria: [
          {
            kind: "reader",
            from: "arduino-uno-r3 A0",
            threshold: 0.0009765625,
            ratioTo: "5V.voltage",
            metric: "event-max",
            value: 0.0005,
            coverage: { qualified: 40, excluded: { "no counterpart": 2 } },
            verdict: "within",
          },
        ],
      },
    ])
  ),
  "rig.board"
);
const ratio = reader?.lines[0]?.criteria[0];
expect(
  ratio?.against === "reader 0.000977 of 5V.voltage from arduino-uno-r3 A0" &&
    ratio.measured ===
      "event-max 0.0005 of 5V.voltage on 40 of 42 conversions (2 no counterpart)",
  `a ratio-to reader: ${JSON.stringify(reader)}`
);

// Not this run's: the record is named, no rows, and the card says why.
const other = accuracyView(report(accuracy(false, [])));
expect(
  other?.applies === false &&
    other.lines.length === 0 &&
    other.domain.length === 0 &&
    accuracySummary(other).startsWith("Not this run"),
  `another run: ${JSON.stringify(other)}`
);
expect(
  accuracyView(report(accuracy(false, [])), "rig.actuator") === null,
  "another run shows no verdict on the part's card"
);

// Out of domain: the record's run, a stale or unchecked snapshot, and
// this run leaving an envelope.
const outside = report({
  ...accuracy(true, [shaft]),
  inDomain: false,
  domain: [
    "the check's snapshot side took uno.power VBUS current outside 0..0.5 A",
  ],
});
outside.snapshots = [
  {
    path: "rig.actuator",
    axis: "behaviour",
    ref: "sfab/sg90-servo@1.0.0",
    quality: "Q2a",
    stale: true,
    envelope: ["shaft.angle 3.4 rad above 3.14 rad"],
  },
  {
    path: "uno.power",
    axis: "behaviour",
    ref: "sfab/uno-power-input@1.0.0",
    quality: "Q1",
    unchecked: "a measured snapshot",
  },
];
const domain = accuracyView(outside, "rig.actuator")?.domain ?? [];
expect(
  JSON.stringify(domain) ===
    JSON.stringify([
      "the check's snapshot side took uno.power VBUS current outside 0..0.5 A",
      "rig.actuator sfab/sg90-servo@1.0.0 is stale",
      "uno.power sfab/uno-power-input@1.0.0 is unchecked",
      "this run took rig.actuator outside its envelope",
    ]),
  `out of domain: ${JSON.stringify(domain)}`
);

// An over-budget warning sits at its path, like any other warning.
const warned = report(accuracy(true, [shaft]));
warned.warnings = [
  {
    severity: "warning",
    code: "over-budget",
    path: "rig.actuator",
    port: "shaft",
    message: "rig.actuator port shaft quantity angle: over its resolution",
  },
] as RunReport["warnings"];
const atPath = warningsFromRun(warned).get("rig.actuator") ?? [];
expect(
  atPath.some((row) => row.code === "over-budget" && row.port === "shaft"),
  `the warning at its path: ${JSON.stringify(atPath)}`
);

console.log("world-accuracy.selfcheck ok");
