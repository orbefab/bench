/** Ported from layered-sim E4 (fd10742). Quality is granted here, never read from the file. */
import type {
  Diagnostic,
  Quantity,
  Range,
  SnapshotFile,
  SnapshotQuality,
} from "@sfab-bench/contract";

import { makeDiag, siValue } from "./parts/si";
import { envelopeOf, tableLawOf, tableVoltage } from "./snapshot-law";

export type SnapshotLintContext = {
  plausible?: Partial<Record<Quantity, Range>>;
  /** A servo or motor must publish `V+.current`. */
  actuator: boolean;
};

const RANK: Record<SnapshotQuality, number> = {
  Q0: 0,
  Q1: 1,
  Q2a: 2,
  Q2b: 2,
  Q3: 3,
};

function exceeds(claim: SnapshotQuality, grant: SnapshotQuality): boolean {
  if (claim === grant) return false;
  if (
    (claim === "Q2a" && grant === "Q2b") ||
    (claim === "Q2b" && grant === "Q2a")
  ) {
    return true;
  }
  return RANK[claim] > RANK[grant];
}

function numeric(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && "v" in value) {
    const v = (value as { v: unknown }).v;
    return typeof v === "number" ? v : null;
  }
  return null;
}

function quantityOf(key: string): Quantity | null {
  if (key.endsWith(".voltage")) return "Voltage";
  if (key.endsWith(".currentLimit")) return "Current";
  if (key.endsWith(".current")) return "Current";
  if (key.endsWith(".resistance")) return "Resistance";
  if (key.endsWith(".torque")) return "Torque";
  return null;
}

/**
 * Same scale note as `parts/check.ts`: a current of 10 A or more is
 * called out in mA so a missed prefix is visible.
 */
function scaleNote(quantity: Quantity, value: number): string {
  if (quantity === "Current" && Math.abs(value) >= 10) {
    return `; ${value * 1000} mA`;
  }
  return "";
}

function plausibleErrors(
  snap: SnapshotFile,
  ctx: SnapshotLintContext
): Diagnostic[] {
  const ranges = ctx.plausible;
  if (!ranges) return [];
  const diags: Diagnostic[] = [];
  const seen = new Set<string>();
  const check = (field: string, quantity: Quantity, value: number) => {
    const range = ranges[quantity];
    if (!range) return;
    const lo = siValue(range[0]);
    const hi = siValue(range[1]);
    if (value >= lo && value <= hi) return;
    const key = `${field}|${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    diags.push(
      makeDiag({
        severity: "error",
        path: snap.part,
        port: field,
        quantity,
        left: `${value}${scaleNote(quantity, value)}`,
        right: `${lo}..${hi}`,
        detail: `field ${field} is outside the plausible range for ${snap.partType}`,
      })
    );
  };
  for (const [key, value] of Object.entries(snap.params)) {
    if (Array.isArray(value)) {
      const quantity =
        quantityOf(key) ??
        (key === "iAxis"
          ? "Current"
          : key === "vAxis"
            ? "Voltage"
            : key === "supplyRef"
              ? "Voltage"
              : null);
      if (!quantity) continue;
      for (const item of value) {
        const n = numeric(item);
        if (n !== null) check(key, quantity, n);
      }
      continue;
    }
    const n = numeric(value);
    if (n === null) continue;
    const quantity =
      key === "supplyRef" || key === "drop" || key === "V"
        ? "Voltage"
        : key === "Rs" || key === "R"
          ? "Resistance"
          : key === "Ilimit"
            ? "Current"
            : null;
    if (quantity) check(key, quantity, n);
  }
  for (const [key, bound] of Object.entries(snap.envelope.bounds)) {
    const quantity = quantityOf(key);
    if (!quantity || !Array.isArray(bound)) continue;
    for (const item of bound) {
      const n = numeric(item);
      if (n !== null) check(key, quantity, n);
    }
  }
  return diags;
}

function provenanceMissing(snap: SnapshotFile): boolean {
  const p = snap.provenance;
  if (!p || typeof p !== "object") return true;
  if (!p.source || !p.bench || typeof p.created !== "string" || !p.created) {
    return true;
  }
  if (p.source === "captured" && (!p.from || !p.fixture || !p.tool))
    return true;
  if (p.source === "measured" && !p.data) return true;
  return false;
}

function tableCoverage(snap: SnapshotFile): string | null {
  if (snap.form !== "table@1") return null;
  const law = tableLawOf(snap);
  const env = envelopeOf(snap);
  if (!law || !env) return "table does not cover its envelope";
  const i0 = law.iAxis[0] ?? 0;
  const i1 = law.iAxis[law.iAxis.length - 1] ?? 0;
  if (env.current[0] < i0 - 1e-12 || env.current[1] > i1 + 1e-12) {
    return "table does not cover its envelope";
  }
  for (let k = 1; k < law.iAxis.length; k++) {
    if ((law.iAxis[k] ?? 0) <= (law.iAxis[k - 1] ?? 0)) {
      return "table does not cover its envelope";
    }
  }
  if (law.supplyPort === undefined) return null;
  const supply = env.supply;
  const ref = law.supplyRef;
  if (!supply || ref === undefined || law.supplyAffine === undefined) {
    return "table does not cover its envelope";
  }
  if (law.supplyAffine === 1) {
    if (ref < supply[0] || ref > supply[1]) {
      return "table does not cover its envelope";
    }
    return null;
  }
  if (supply[0] < ref - 1e-12 || supply[1] > ref + 1e-12) {
    return "table does not cover its envelope";
  }
  return null;
}

function nonPhysical(snap: SnapshotFile): boolean {
  const law = tableLawOf(snap);
  const env = envelopeOf(snap);
  if (!law || !env || !env.supply) return false;
  if (!(env.supply[0] <= 0 && env.supply[1] >= 0)) return false;
  for (const amps of law.iAxis) {
    if (amps < env.current[0] || amps > env.current[1]) continue;
    const volts = tableVoltage(law, 0, amps);
    if (Math.abs(volts) > 1e-6) return true;
  }
  return false;
}

function freeRunMeasured(snap: SnapshotFile): boolean {
  if (!Array.isArray(snap.error)) return false;
  return snap.error.some(
    (row) =>
      (row.metric === "free-run-max-abs" || row.metric === "free-run-rms") &&
      Boolean(row.baseline) &&
      Boolean(row.heldOut)
  );
}

function earned(snap: SnapshotFile, blocked: boolean): SnapshotQuality {
  if (blocked || provenanceMissing(snap)) return "Q0";
  const captured =
    snap.provenance.source === "captured" && freeRunMeasured(snap);
  const measured =
    snap.provenance.source === "measured" && freeRunMeasured(snap);
  if (captured && measured) return "Q3";
  if (measured) return "Q2b";
  if (captured) return "Q2a";
  return "Q1";
}

export function lintSnapshot(
  snap: SnapshotFile,
  ctx: SnapshotLintContext
): { diagnostics: Diagnostic[]; quality: SnapshotQuality } {
  const diagnostics: Diagnostic[] = [];
  if (provenanceMissing(snap)) {
    diagnostics.push(
      makeDiag({
        severity: "error",
        path: snap.part || "snapshot",
        port: "provenance",
        quantity: "Snapshot",
        left: "missing",
        right: "provenance",
        detail: "missing provenance",
      })
    );
  }
  const coverage = tableCoverage(snap);
  if (coverage) {
    diagnostics.push(
      makeDiag({
        severity: "error",
        path: snap.part || "snapshot",
        port: "envelope",
        quantity: "Snapshot",
        left: "table",
        right: "envelope",
        detail: coverage,
      })
    );
  }
  if (ctx.actuator && !snap.ports.outputs.includes("V+.current")) {
    diagnostics.push(
      makeDiag({
        severity: "error",
        path: snap.part || "snapshot",
        port: "V+",
        quantity: "Current",
        left: snap.ports.outputs.join(","),
        right: "V+.current",
        detail: "actuator is missing V+.current",
      })
    );
  }
  diagnostics.push(...plausibleErrors(snap, ctx));
  if (nonPhysical(snap)) {
    diagnostics.push(
      makeDiag({
        severity: "error",
        path: snap.part || "snapshot",
        port: "supply.voltage",
        quantity: "Voltage",
        left: "nonzero",
        right: "0",
        detail: "non-physical output at a 0 V setpoint",
      })
    );
  }
  const quality = earned(snap, diagnostics.length > 0);
  if (snap.quality && exceeds(snap.quality, quality)) {
    diagnostics.push(
      makeDiag({
        severity: "error",
        path: snap.part || "snapshot",
        port: "quality",
        quantity: "Snapshot",
        left: snap.quality,
        right: quality,
        detail: `quality claim ${snap.quality} is above the linter grant ${quality}`,
      })
    );
  }
  return { diagnostics, quality };
}
