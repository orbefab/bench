/**
 * The document's assembly check on a live run (run 7 unit 3c).
 *
 * - The arm bench at its own levels is not the run its check measured:
 *   the report names the record, says it does not apply, and carries no
 *   verdict.
 * - At the record's snapshot levels it is: every stored row reaches the
 *   report, with its gap, threshold, coverage and verdict, and a `within`
 *   verdict raises no warning.
 * - An `over` verdict is an `over-budget` warning at the quantity's path
 *   and port, naming the snapshots and the record, with the record's
 *   out-of-domain qualifier.
 * - An edited part, another stored context, or a record of another
 *   document gives no verdict.
 */

import { ok as expect } from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AssemblyCheckFile, RunReport } from "@sfab-bench/contract";
import { planWorld } from "./world/plan";

const armDir = fileURLToPath(
  new URL("../../../examples/arm/", import.meta.url)
);
const DOCUMENT = "parts/sfab/arm-bench@1.0.0.json";
const RECORD = "checks/sfab/arm-bench@1.0.0.json";

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

const dir = mkdtempSync(join(tmpdir(), "sfab-accuracy-"));
try {
  cpSync(armDir, dir, { recursive: true });
  const record = readJson<AssemblyCheckFile>(join(dir, RECORD));
  const document = readJson<{ play: { levels: unknown } }>(join(dir, DOCUMENT));
  const report = (): RunReport => {
    const planned = planWorld(dir, DOCUMENT);
    if (!planned.ok) {
      throw new Error(planned.errors.map((row) => row.message).join("; "));
    }
    if (!planned.plan.report) throw new Error("no report");
    return planned.plan.report;
  };
  const writeRecord = (next: AssemblyCheckFile) =>
    writeFileSync(join(dir, RECORD), JSON.stringify(next));
  const overBudget = (got: RunReport) =>
    got.warnings.filter((row) => row.code === "over-budget");

  // 1. At its own levels: the record is named, and does not apply.
  const own = report();
  expect(
    own.accuracy?.record === RECORD &&
      own.accuracy.applies === false &&
      own.accuracy.rows.length === 0 &&
      overBudget(own).length === 0,
    `at its own levels: ${JSON.stringify(own.accuracy)}`
  );

  // 2. At the record's snapshot levels: every stored row, as stored.
  writeFileSync(
    join(dir, DOCUMENT),
    JSON.stringify({
      ...document,
      play: { ...document.play, levels: record.snapshot },
    })
  );
  const checked = report();
  const rows = checked.accuracy?.rows ?? [];
  const shaft = rows.find((row) => row.quantity === "servo.shaft.angle");
  const stored = record.rows.find(
    (row) => row.quantity === "servo.shaft.angle"
  );
  const precision = shaft?.criteria[0];
  expect(
    checked.accuracy?.applies === true &&
      checked.accuracy.inDomain === record.inDomain &&
      JSON.stringify(checked.accuracy.snapshots) ===
        JSON.stringify(
          record.children.map((row) => `${row.path} ${row.ref}`)
        ) &&
      JSON.stringify(rows.map((row) => row.quantity)) ===
        JSON.stringify(record.quantities) &&
      shaft?.path === "servo" &&
      shaft.port === "shaft" &&
      shaft.field === "angle" &&
      shaft.gap.max ===
        stored?.metrics.find((row) => row.metric === "step-max")?.value &&
      shaft.criteria.length === 1 &&
      precision?.verdict === "within" &&
      precision.from === "sfab/sg90@1.0.0 shaft" &&
      precision.window === 0.06 &&
      precision.metric === "settled-max" &&
      precision.value === stored?.criteria[0]?.metrics[0]?.value &&
      JSON.stringify(precision.coverage) ===
        JSON.stringify(stored?.criteria[0]?.coverage) &&
      rows
        .filter((row) => row !== shaft)
        .every((row) => row.criteria.length === 0) &&
      overBudget(checked).length === 0,
    `at the snapshot levels: ${JSON.stringify(checked.accuracy)}`
  );
  console.log(
    `accuracy: ${RECORD} applies at its snapshot levels only; ${rows.length} rows, shaft ${precision?.verdict} (${precision?.value} rad against ${precision?.threshold}), no warning`
  );

  // 3. An over verdict is a warning at the quantity's port, qualified.
  const overRecord: AssemblyCheckFile = {
    ...record,
    rows: record.rows.map((row) =>
      row.quantity === "servo.shaft.angle"
        ? {
            ...row,
            criteria: row.criteria.map((criterion) => ({
              ...criterion,
              verdict: "over" as const,
              by: 0.002,
            })),
          }
        : row
    ),
  };
  writeRecord(overRecord);
  const over = overBudget(report());
  const warning = over[0];
  expect(
    over.length === 1 &&
      warning?.path === "servo" &&
      warning.port === "shaft" &&
      warning.severity === "warning" &&
      warning.message.includes("over its resolution by 0.002 rad") &&
      warning.message.includes(
        "servo sfab/sg90-servo@1.0.0, uno.power sfab/uno-power-input@1.0.0 as snapshots"
      ) &&
      warning.message.includes(RECORD) &&
      warning.message.includes(
        "out of domain: the check's snapshot side took uno.power VBUS current outside 0..0.5 A"
      ),
    `an over verdict: ${JSON.stringify(over)}`
  );
  writeRecord({ ...overRecord, inDomain: true });
  const inDomain = overBudget(report());
  expect(
    inDomain.length === 1 && !inDomain[0]?.message.includes("out of domain"),
    `an over verdict in domain is not qualified: ${JSON.stringify(inDomain)}`
  );
  console.log(
    `accuracy: an over verdict warns at servo shaft: ${warning?.message}`
  );

  // A no-verdict criterion is card-only; a nested path keeps all of it.
  const shaftRow = record.rows.find(
    (row) => row.quantity === "servo.shaft.angle"
  );
  if (!shaftRow) throw new Error("no shaft row");
  writeRecord({
    ...record,
    rows: [
      ...record.rows.map((row) =>
        row === shaftRow
          ? {
              ...row,
              criteria: row.criteria.map((criterion) => ({
                ...criterion,
                verdict: "none" as const,
                reason: "no settled samples",
              })),
            }
          : row
      ),
      {
        ...shaftRow,
        quantity: "rig.arm.servo.shaft.angle",
        criteria: shaftRow.criteria.map((criterion) => ({
          ...criterion,
          verdict: "over" as const,
          by: 0.002,
        })),
      },
    ],
  });
  const nested = overBudget(report());
  expect(
    nested.length === 1 &&
      nested[0]?.path === "rig.arm.servo" &&
      nested[0].port === "shaft",
    `none is card-only, a nested path is whole: ${JSON.stringify(nested)}`
  );

  // 4. Not this run's: another context, an edited part, another document.
  writeRecord({ ...record, context: "0".repeat(64) });
  const other = report();
  expect(
    other.accuracy?.applies === false && other.accuracy.rows.length === 0,
    "another stored context does not apply"
  );
  writeRecord(record);
  const sg90 = join(dir, "parts/sfab/sg90@1.0.0.json");
  const catalogSg90 = fileURLToPath(
    new URL("../catalog/parts/sfab/sg90@1.0.0.json", import.meta.url)
  );
  const edited = readJson<{ ratings: Record<string, Record<string, unknown>> }>(
    catalogSg90
  );
  edited.ratings["V+"] = { ...edited.ratings["V+"], current: [0, 0.65] };
  writeFileSync(sg90, JSON.stringify(edited));
  const shadowed = report();
  rmSync(sg90);
  expect(
    shadowed.accuracy?.applies === false,
    `an edited part: ${JSON.stringify(shadowed.accuracy)}`
  );
  writeRecord({ ...record, document: "parts/sfab/arm-world@1.0.0.json" });
  expect(
    report().accuracy === undefined,
    "a record of another document is not this document's check"
  );
  const { children: _children, ...truncated } = record;
  writeRecord(truncated as AssemblyCheckFile);
  expect(
    report().accuracy === undefined,
    "a record missing what the card reads is not this document's check"
  );
  rmSync(join(dir, RECORD));
  expect(report().accuracy === undefined, "no record, no accuracy");
  console.log(
    "accuracy: another context, an edited part, a record of another document, a truncated one or none: no verdict"
  );

  // 5. The bytes the run reads are the run: a rebuilt firmware image, a
  // heavier link in the URDF, an edited mesh or a forced net level is not
  // the run the check measured.
  writeRecord(record);
  const text = (edit: (was: string) => string) => (was: Buffer) =>
    Buffer.from(edit(was.toString("utf8")), "utf8");
  const edits: [string, string, (was: Buffer) => Buffer][] = [
    [
      "firmware",
      "firmware/hold/hold.hex",
      text((was) => was.replace(/^:10/m, ":11")),
    ],
    [
      "URDF",
      "robot/arm.urdf",
      text((was) => was.replace(/<mass value="([^"]*)"/, '<mass value="1$1"')),
    ],
    [
      "mesh",
      "robot/meshes/base.stl",
      (was) => Buffer.concat([was, Buffer.from([0])]),
    ],
  ];
  for (const [what, file, edit] of edits) {
    const abs = join(dir, file);
    const was = readFileSync(abs);
    const next = edit(was);
    expect(!next.equals(was), `${what}: the edit changed nothing`);
    writeFileSync(abs, next);
    const got = report();
    writeFileSync(abs, was);
    expect(
      got.accuracy?.applies === false,
      `an edited ${what} still applies: ${JSON.stringify(got.accuracy)}`
    );
  }
  expect(report().accuracy?.applies === true, "restored, it applies again");
  const digital = checked.nets.find((net) => net.level === "digital");
  if (!digital) throw new Error("no digital net on the arm");
  writeFileSync(
    join(dir, DOCUMENT),
    JSON.stringify({
      ...document,
      play: {
        ...document.play,
        levels: { ...record.snapshot, nets: { [digital.id]: "analog" } },
      },
    })
  );
  const forced = report();
  expect(
    forced.accuracy?.applies === false,
    `a forced net level ${digital.id} still applies`
  );
  console.log(
    `accuracy: a rebuilt firmware image, a URDF mass, a mesh, or net ${digital.id} forced analog: no verdict`
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("accuracy.selfcheck ok");
