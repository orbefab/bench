/**
 * C1 hold-out: a table snapshot's stated `static-max-abs` error holds on
 * currents the capture never evaluated. Each committed table is compared
 * with its class-2 stamp on a grid of its own (thirteen points per knot
 * interval at non-dyadic offsets, and a 3^-j ladder in an interval that
 * starts at 0 A, where a diode knee sits).
 */

import { ok as expect } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { SnapshotFile, TableLaw } from "@sfab-bench/contract";
import { tableVoltage } from "@sfab-bench/engine-circuit";
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
  const law = snap.params as unknown as TableLaw;
  const stamp = assemblyStampOf(entry.part, entry.variant, {
    catalogDir: catalog,
    boardId: entry.instance,
    across: entry.across,
  });
  let worst = 0;
  let worstAt = 0;
  for (const amps of heldOutGrid(law.iAxis)) {
    const volts = branchDc(stamp, entry.across[0], entry.across[1], amps);
    const err = Math.abs(volts - tableVoltage(law, amps));
    if (err > worst) {
      worst = err;
      worstAt = amps;
    }
  }
  const line = `${entry.id}: held-out max ${(worst * 1000).toFixed(3)} mV at ${worstAt.toExponential(2)} A, stated ${(row.value * 1000).toFixed(3)} mV`;
  expect(worst <= row.value + 1e-9, `${line}: the stated error is optimistic`);
  console.log(`snapshot-holdout: ${line}`);
  checked++;
}
expect(checked >= 2, `only ${checked} table snapshots state an error`);
console.log(
  `snapshot-holdout: ${checked} table snapshots hold their stated error on held-out currents`
);
