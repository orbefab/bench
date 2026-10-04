/**
 * C1 hold-out: a plain-branch snapshot's stated `static-max-abs` error
 * holds on currents the capture never evaluated. Each committed table, or
 * law fitted to the sweep, is compared with its class-2 stamp on a grid of
 * its own (thirteen points per knot or sweep interval at non-dyadic
 * offsets, and a 3^-j ladder in an interval that starts at 0 A, where a
 * diode knee sits). A fitted `diode@1` is solved by the run's engine.
 */

import { ok as expect } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { FixtureFile, SnapshotFile, TableLaw } from "@sfab-bench/contract";
import {
  Diode,
  Engine,
  ISource,
  tableVoltage,
} from "@sfab-bench/engine-circuit";
import { branchDc } from "@sfab-bench/sim";

import type { CaptureEntry, CaptureFile } from "./capture";
import { assemblyStampOf } from "./world/circuit-stamp";

const catalog = fileURLToPath(new URL("../catalog/", import.meta.url));

function snapshotFile(id: string): string {
  const slash = id.indexOf("/");
  const at = id.lastIndexOf("@");
  return join(
    catalog,
    "snapshots",
    id.slice(0, slash),
    `${id.slice(slash + 1, at)}@${id.slice(at + 1)}.json`
  );
}

/** Currents strictly inside each knot interval, none of them a capture point. */
function heldOutGrid(knots: readonly number[]): number[] {
  const out: number[] = [];
  for (let k = 0; k + 1 < knots.length; k++) {
    const lo = knots[k]!;
    const hi = knots[k + 1]!;
    for (let j = 0; j < 13; j++) out.push(lo + ((hi - lo) * (j + 0.381)) / 13);
    if (lo === 0) for (let j = 1; j <= 8; j++) out.push(hi / 3 ** j);
  }
  return out;
}

/** The snapshot's own law at `amps`: the table, or the fitted diode solved. */
function lawVoltage(snap: SnapshotFile): (amps: number) => number {
  if (snap.form === "table@1") {
    const law = snap.params as unknown as TableLaw;
    return (amps) => tableVoltage(law, amps);
  }
  const { Is, N, Rs } = snap.params as { Is: number; N: number; Rs: number };
  return (amps) => {
    const engine = new Engine(
      [
        new Diode("d", "a", "0", { Is, N, Rs, tempC: 25 }),
        new ISource("is", "0", "a", { kind: "dc", value: amps }),
      ],
      { method: "be", h: 1e-3, atol: 1e-14, rtol: 1e-12 }
    );
    engine.operatingPoint();
    return engine.voltage("a");
  };
}

function sweepOf(entry: CaptureEntry): number[] {
  const fixture = JSON.parse(
    readFileSync(
      join(catalog, "fixtures", `${entry.sweep.fixture}.fixture.json`),
      "utf8"
    )
  ) as FixtureFile;
  const row = fixture.sweeps.find(
    (item) => item.port === (entry.sweep.currentPort ?? entry.through)
  );
  if (!row) throw new Error(`${entry.id} fixture has no current sweep`);
  return row.values;
}

const config = JSON.parse(
  readFileSync(join(catalog, "fixtures", "capture.config.json"), "utf8")
) as CaptureFile<CaptureEntry | { form: string }>;

let checked = 0;
for (const entry of config.entries) {
  if ("form" in entry || !entry.staticError || !entry.across) continue;
  const snap = JSON.parse(
    readFileSync(snapshotFile(entry.id), "utf8")
  ) as SnapshotFile;
  const row = Array.isArray(snap.error)
    ? snap.error.find((item) => item.metric === "static-max-abs")
    : undefined;
  expect(row, `${entry.id} states no static-max-abs error`);
  const voltage = lawVoltage(snap);
  const grid =
    snap.form === "table@1"
      ? (snap.params as unknown as TableLaw).iAxis
      : sweepOf(entry);
  const stamp = assemblyStampOf(entry.part, entry.variant, {
    catalogDir: catalog,
    boardId: entry.instance,
    across: entry.across,
  });
  let worst = 0;
  let worstAt = 0;
  for (const amps of heldOutGrid(grid)) {
    const volts = branchDc(stamp, entry.across[0], entry.across[1], amps);
    const err = Math.abs(volts - voltage(amps));
    if (err > worst) {
      worst = err;
      worstAt = amps;
    }
  }
  const line = `${entry.id}: held-out max ${(worst * 1000).toFixed(3)} mV at ${worstAt.toExponential(2)} A, stated ${(row.value * 1000).toFixed(3)} mV`;
  expect(worst <= row.value + 1e-9, `${line}: the stated error is optimistic`);
  console.log(`snapshot-holdout: ${line} (${snap.form})`);
  checked++;
}
expect(checked >= 3, `only ${checked} plain-branch snapshots state an error`);
console.log(
  `snapshot-holdout: ${checked} plain-branch snapshots hold their stated error on held-out currents`
);
