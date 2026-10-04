/** Ported from layered-sim E4 (fd10742). Quality is granted here, never read from the file. */
import type {
  Diagnostic,
  PortDecl,
  Quantity,
  Range,
  SnapshotFile,
  SnapshotQuality,
} from "@sfab-bench/contract";

import { makeDiag, siValue } from "./si";
import { envelopeOf, tableLawOf } from "./snapshot-law";

export type SnapshotLintContext = {
  plausible?: Partial<Record<Quantity, Range>>;
  /** Expanded ports of the part type. Absent, port checks are skipped. */
  ports?: Record<string, PortDecl>;
  /** Outputs the type requires. Absent, none are required. */
  requiredOutputs?: readonly string[];
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

function domainQuantity(
  domain: string,
  kind: "across" | "through"
): Quantity | null {
  if (domain === "electrical") return kind === "across" ? "Voltage" : "Current";
  if (domain === "rotational") return kind === "across" ? "Angle" : "Torque";
  if (domain === "translational") {
    return kind === "across" ? "Position" : "Force";
  }
  if (domain === "thermal") {
    return kind === "across" ? "Temperature" : "HeatFlow";
  }
  return null;
}

/** The form says which param is the through or across sample. The type says the quantity. */
function paramQuantity(
  snap: SnapshotFile,
  key: string,
  ctx: SnapshotLintContext
): Quantity | null {
  const law = snap.form === "table@1" ? tableLawOf(snap) : null;
  if (law && key === "iAxis") {
    return domainQuantity(ctx.ports?.[law.across[0]]?.domain ?? "", "through");
  }
  if (law && key === "vAxis") {
    return domainQuantity(ctx.ports?.[law.across[0]]?.domain ?? "", "across");
  }
  if (snap.form === "hinge@1") {
    if (key === "armature") return "Inertia";
    if (key === "damping") return "TorquePerAngularVelocity";
    if (key === "frictionloss") return "Torque";
  }
  if (key === "drop" || key === "V") return "Voltage";
  if (key === "Rs" || key === "R") return "Resistance";
  if (key === "Ilimit") return "Current";
  return null;
}

/**
 * A bound key is `port.field`. A declared port takes the domain's across
 * or through quantity. `supply` is not a port of the part.
 */
function boundQuantity(
  key: string,
  ports: SnapshotLintContext["ports"]
): Quantity | null {
  const dot = key.lastIndexOf(".");
  if (dot <= 0) return null;
  const port = key.slice(0, dot);
  const field = key.slice(dot + 1);
  const domain = ports?.[port]?.domain;
  if (field === "resistance") return "Resistance";
  if (field === "current" || field === "currentLimit") {
    return domain ? domainQuantity(domain, "through") : "Current";
  }
  if (field === "voltage") {
    return domain ? domainQuantity(domain, "across") : "Voltage";
  }
  if (field === "torque") return "Torque";
  if (field === "speed") return "AngularVelocity";
  if (field === "angle") return "Angle";
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
        code: "snapshot",
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
      const quantity = paramQuantity(snap, key, ctx);
      if (!quantity) continue;
      for (const item of value) {
        const n = numeric(item);
        if (n !== null) check(key, quantity, n);
      }
      continue;
    }
    const n = numeric(value);
    if (n === null) continue;
    const quantity = paramQuantity(snap, key, ctx);
    if (quantity) check(key, quantity, n);
  }
  for (const [key, bound] of Object.entries(snap.envelope.bounds)) {
    const quantity = boundQuantity(key, ctx.ports);
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
  return null;
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

function tablePorts(
  snap: SnapshotFile,
  ctx: SnapshotLintContext
): Diagnostic[] {
  if (snap.form !== "table@1") return [];
  const law = tableLawOf(snap);
  if (!law || !ctx.ports) return [];
  const diags: Diagnostic[] = [];
  const path = snap.part || "snapshot";
  const through = `${law.across[0]}.current`;
  const voltage = `${law.across[0]}.voltage`;
  if (!snap.ports.inputs.includes(through)) {
    diags.push(
      makeDiag({
        severity: "error",
        code: "snapshot",
        path,
        port: law.across[0],
        quantity: "Current",
        left: snap.ports.inputs.join(","),
        right: through,
        detail: `table input is missing ${through}`,
      })
    );
  }
  if (!snap.ports.outputs.includes(voltage)) {
    diags.push(
      makeDiag({
        severity: "error",
        code: "snapshot",
        path,
        port: law.across[0],
        quantity: "Voltage",
        left: snap.ports.outputs.join(","),
        right: voltage,
        detail: `table output is missing ${voltage}`,
      })
    );
  }
  return diags;
}

/**
 * A capture across a port pair, in any form: both ports are the part's.
 * The stale check stamps that pair again.
 */
function acrossPorts(
  snap: SnapshotFile,
  ctx: SnapshotLintContext
): Diagnostic[] {
  const across = snap.params.across;
  if (!Array.isArray(across) || !ctx.ports) return [];
  const diags: Diagnostic[] = [];
  for (const name of across) {
    if (typeof name === "string" && ctx.ports[name]) continue;
    diags.push(
      makeDiag({
        severity: "error",
        code: "snapshot",
        path: snap.part || "snapshot",
        port: String(name),
        quantity: "Snapshot",
        left: String(name),
        right: snap.partType,
        detail: `across port ${name} is not on ${snap.partType}`,
      })
    );
  }
  return diags;
}

/** Each bound form port lands on a distinct port the part declares. */
function bindErrors(
  snap: SnapshotFile,
  ctx: SnapshotLintContext
): Diagnostic[] {
  if (!snap.bind || !ctx.ports) return [];
  const diags: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const [form, part] of Object.entries(snap.bind)) {
    const reason = !ctx.ports[part]
      ? `bind ${form} → ${part}: ${part} is not on ${snap.partType}`
      : seen.has(part)
        ? `bind ${form} → ${part}: ${part} is bound twice`
        : null;
    seen.add(part);
    if (!reason) continue;
    diags.push(
      makeDiag({
        severity: "error",
        code: "snapshot",
        path: snap.part || "snapshot",
        port: part,
        quantity: "Snapshot",
        left: form,
        right: snap.partType,
        detail: reason,
      })
    );
  }
  return diags;
}

const ROTATIONAL_FIELD: Record<string, Quantity> = {
  angle: "Angle",
  speed: "AngularVelocity",
  torque: "Torque",
};

function hingeErrors(
  snap: SnapshotFile,
  ctx: SnapshotLintContext
): Diagnostic[] {
  if (snap.form !== "hinge@1" && snap.axis !== "body") return [];
  const path = snap.part || "snapshot";
  const diags: Diagnostic[] = [];
  if (snap.form === "hinge@1" && snap.axis !== "body") {
    diags.push(
      makeDiag({
        severity: "error",
        code: "snapshot",
        path,
        port: "axis",
        quantity: "Form",
        left: snap.form,
        right: String(snap.axis),
        detail: "hinge@1 is a body-axis form",
      })
    );
  }
  if (snap.axis === "body" && snap.form !== "hinge@1") {
    diags.push(
      makeDiag({
        severity: "error",
        code: "snapshot",
        path,
        port: "axis",
        quantity: "Form",
        left: snap.form,
        right: "body",
        detail: `${snap.form} is a behaviour form on the body axis`,
      })
    );
  }
  if (snap.form !== "hinge@1") return diags;
  for (const key of ["armature", "damping", "frictionloss"] as const) {
    const value = numeric(snap.params[key]);
    const ok =
      value !== null &&
      Number.isFinite(value) &&
      value >= 0 &&
      (key !== "armature" || value > 0);
    if (ok) continue;
    diags.push(
      makeDiag({
        severity: "error",
        code: "snapshot",
        path,
        port: key,
        quantity: key === "armature" ? "Inertia" : "Torque",
        left: String(snap.params[key]),
        right: key === "armature" ? "> 0" : ">= 0",
        detail: `hinge param ${key} must be finite and non-negative`,
      })
    );
  }
  if (!ctx.ports) return diags;
  for (const item of [...snap.ports.inputs, ...snap.ports.outputs]) {
    const dot = item.lastIndexOf(".");
    const port = dot > 0 ? item.slice(0, dot) : "";
    const field = dot > 0 ? item.slice(dot + 1) : "";
    const decl = ctx.ports[port];
    const quantity =
      decl?.domain === "rotational" ? ROTATIONAL_FIELD[field] : undefined;
    if (decl && quantity) continue;
    diags.push(
      makeDiag({
        severity: "error",
        code: "snapshot",
        path,
        port: port || item,
        quantity: "Snapshot",
        left: item,
        right: snap.partType,
        detail: `port quantity ${item} is not on ${snap.partType}`,
      })
    );
  }
  for (const key of Object.keys(snap.envelope.bounds)) {
    const dot = key.lastIndexOf(".");
    const port = dot > 0 ? key.slice(0, dot) : "";
    const decl = ctx.ports[port];
    if (decl?.domain === "rotational") continue;
    diags.push(
      makeDiag({
        severity: "error",
        code: "snapshot",
        path,
        port: port || key,
        quantity: "Snapshot",
        left: key,
        right: "shaft",
        detail: `envelope ${key} is not on the shaft`,
      })
    );
  }
  return diags;
}

/** A snapshot must not carry its fixture's supply. */
export const FIXTURE_SUPPLY = "a snapshot must not carry its fixture's supply";

/**
 * Envelope bounds on `supply.*`, or on a port this part does not declare.
 * The supply is a part in the scene. The table is a branch of its own ports.
 */
const FIXTURE_TERMS = ["supplyPort", "supplyRef", "supplyAffine"] as const;

function fixtureSupplyDiags(
  snap: SnapshotFile,
  ctx: SnapshotLintContext
): Diagnostic[] {
  const diags: Diagnostic[] = [];
  for (const key of FIXTURE_TERMS) {
    if (snap.params[key] === undefined) continue;
    diags.push(
      makeDiag({
        severity: "error",
        code: "snapshot",
        path: snap.part || "snapshot",
        port: "supply",
        quantity: "Snapshot",
        left: key,
        right: "the part's own ports",
        detail: FIXTURE_SUPPLY,
      })
    );
  }
  const bounds = snap.envelope?.bounds;
  if (!bounds) return diags;
  const ports = ctx.ports;
  for (const key of Object.keys(bounds).sort()) {
    const dot = key.lastIndexOf(".");
    const port = dot > 0 ? key.slice(0, dot) : "";
    const supply = port === "supply" || key.startsWith("supply.");
    const foreign =
      ports !== undefined && (port.length === 0 || ports[port] === undefined);
    if (!supply && !foreign) continue;
    diags.push(
      makeDiag({
        severity: "error",
        code: "snapshot",
        path: snap.part || "snapshot",
        port: port || key,
        quantity: "Snapshot",
        left: key,
        right: "the part's own ports",
        detail: FIXTURE_SUPPLY,
      })
    );
  }
  return diags;
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
        code: "snapshot",
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
        code: "snapshot",
        path: snap.part || "snapshot",
        port: "envelope",
        quantity: "Snapshot",
        left: "table",
        right: "envelope",
        detail: coverage,
      })
    );
  }
  for (const name of ctx.requiredOutputs ?? []) {
    if (snap.ports.outputs.includes(name)) continue;
    diagnostics.push(
      makeDiag({
        severity: "error",
        code: "snapshot",
        path: snap.part || "snapshot",
        port: name,
        quantity: "Snapshot",
        left: snap.ports.outputs.join(","),
        right: name,
        detail: `missing required output ${name}`,
      })
    );
  }
  diagnostics.push(...fixtureSupplyDiags(snap, ctx));
  diagnostics.push(...acrossPorts(snap, ctx));
  diagnostics.push(...tablePorts(snap, ctx));
  diagnostics.push(...bindErrors(snap, ctx));
  diagnostics.push(...hingeErrors(snap, ctx));
  diagnostics.push(...plausibleErrors(snap, ctx));
  const quality = earned(snap, diagnostics.length > 0);
  if (snap.quality && exceeds(snap.quality, quality)) {
    diagnostics.push(
      makeDiag({
        severity: "error",
        code: "snapshot",
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
