/** Ported from layered-sim E4 (fd10742). Quality is granted here, never read from the file. */
import type {
  Diagnostic,
  PortDecl,
  Quantity,
  Range,
  SnapshotFile,
  SnapshotQuality,
} from "@sfab-bench/contract";

import { bindProblems } from "./bind";
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

/** Each bound form port is one the form stamps, on a distinct port the part declares. */
function bindErrors(
  snap: SnapshotFile,
  ctx: SnapshotLintContext
): Diagnostic[] {
  if (!snap.bind || !ctx.ports) return [];
  return bindProblems(snap.form, snap.bind, ctx.ports, snap.partType).map(
    (row) =>
      makeDiag({
        severity: "error",
        code: "snapshot",
        path: snap.part || "snapshot",
        port: row.value,
        quantity: "Snapshot",
        left: row.key,
        right: snap.partType,
        detail: row.reason,
      })
  );
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

const METRICS = new Set([
  "static-max-abs",
  "free-run-max-abs",
  "free-run-rms",
  "step-rise",
]);
const HELD_OUT = new Set(["fixture", "use-like", "both"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/**
 * The file's shape, before any rule reads a field: the fields every form
 * has, with the right kinds. A file that fails here is not linted.
 */
export function parseSnapshot(
  raw: unknown,
  id: string
): { file: SnapshotFile | null; diagnostics: Diagnostic[] } {
  const wrong = (field: string, want: string): Diagnostic =>
    makeDiag({
      severity: "error",
      code: "schema",
      path: id,
      port: field,
      quantity: "Snapshot",
      left: "invalid",
      right: want,
      detail: `snapshot field ${field} is not ${want}`,
    });
  if (!isRecord(raw))
    return { file: null, diagnostics: [wrong("file", "an object")] };
  const diagnostics: Diagnostic[] = [];
  for (const key of ["format", "part", "partType", "form"] as const) {
    if (typeof raw[key] !== "string") diagnostics.push(wrong(key, "a string"));
  }
  if (raw.axis !== "behaviour" && raw.axis !== "body") {
    diagnostics.push(wrong("axis", "behaviour or body"));
  }
  if (!isRecord(raw.params)) diagnostics.push(wrong("params", "an object"));
  const ports = raw.ports;
  if (
    !isRecord(ports) ||
    !isStrings(ports.inputs) ||
    !isStrings(ports.outputs)
  ) {
    diagnostics.push(wrong("ports", "inputs and outputs, lists of port.field"));
  }
  if (!isRecord(raw.envelope) || !isRecord(raw.envelope.bounds)) {
    diagnostics.push(wrong("envelope", "an object with bounds"));
  } else {
    // The run checks the bounds and nothing else, so a statistical
    // envelope (`data`) or any other field is refused, not ignored.
    for (const key of Object.keys(raw.envelope)) {
      if (key === "bounds") continue;
      diagnostics.push(
        makeDiag({
          severity: "error",
          code: "schema",
          path: id,
          port: `envelope.${key}`,
          quantity: "Snapshot",
          left: "present",
          right: "bounds only",
          detail: `snapshot field envelope.${key} is not supported: the envelope is its bounds`,
        })
      );
    }
  }
  if (
    raw.error !== "none-available" &&
    !(Array.isArray(raw.error) && raw.error.every(isRecord))
  ) {
    diagnostics.push(wrong("error", "none-available or a list of rows"));
  }
  if (!isRecord(raw.provenance))
    diagnostics.push(wrong("provenance", "an object"));
  if (raw.bind !== undefined && !isRecord(raw.bind)) {
    diagnostics.push(wrong("bind", "an object"));
  }
  if (diagnostics.length > 0) return { file: null, diagnostics };
  return { file: raw as unknown as SnapshotFile, diagnostics };
}

/** `port.field` on a port the type declares, with a field its domain has. */
function portQuantity(item: string, ports: Record<string, PortDecl>): boolean {
  const dot = item.lastIndexOf(".");
  if (dot <= 0) return false;
  return (
    ports[item.slice(0, dot)] !== undefined &&
    boundQuantity(item, ports) !== null
  );
}

/**
 * What the evidence says, checked against what it can mean: each error
 * row a known metric on a declared port quantity, finite and not
 * negative; each bound finite and ordered; each named port quantity the
 * part's; each number finite.
 */
function evidenceErrors(
  snap: SnapshotFile,
  ctx: SnapshotLintContext
): Diagnostic[] {
  const path = snap.part || "snapshot";
  const diags: Diagnostic[] = [];
  const say = (port: string, left: string, right: string, detail: string) =>
    diags.push(
      makeDiag({
        severity: "error",
        code: "snapshot",
        path,
        port,
        quantity: "Snapshot",
        left,
        right,
        detail,
      })
    );
  for (const [key, value] of Object.entries(snap.params)) {
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      const n = numeric(item);
      if (n !== null && !Number.isFinite(n)) {
        say(key, String(n), "finite", `param ${key} is not finite`);
      }
    }
  }
  for (const [key, bound] of Object.entries(snap.envelope.bounds)) {
    const lo = Array.isArray(bound) ? numeric(bound[0]) : null;
    const hi = Array.isArray(bound) ? numeric(bound[1]) : null;
    if (
      lo === null ||
      hi === null ||
      !Number.isFinite(lo) ||
      !Number.isFinite(hi) ||
      lo > hi
    ) {
      say(
        key,
        JSON.stringify(bound),
        "[low, high]",
        `envelope ${key} is not a finite low to high range`
      );
    }
  }
  if (Array.isArray(snap.error)) {
    for (const row of snap.error) {
      const where = String(row.quantity);
      if (!METRICS.has(row.metric)) {
        say(
          where,
          String(row.metric),
          "a known metric",
          `error metric ${row.metric} is not known`
        );
      }
      if (!HELD_OUT.has(row.heldOut)) {
        say(
          where,
          String(row.heldOut),
          "fixture, use-like or both",
          `error row ${where} has no held-out set`
        );
      }
      if (
        typeof row.value !== "number" ||
        !Number.isFinite(row.value) ||
        row.value < 0
      ) {
        say(
          where,
          String(row.value),
          ">= 0",
          `error ${where} is not a finite non-negative number`
        );
      }
      const base = row.baseline?.value;
      if (
        row.baseline !== undefined &&
        (typeof base !== "number" || !Number.isFinite(base))
      ) {
        say(
          where,
          String(base),
          "finite",
          `error ${where} baseline is not finite`
        );
      }
      if (
        ctx.ports &&
        (typeof row.quantity !== "string" ||
          !portQuantity(row.quantity, ctx.ports))
      ) {
        say(
          where,
          where,
          snap.partType,
          `error quantity ${where} is not a port quantity of ${snap.partType}`
        );
      }
    }
  }
  // A hinge names its own rotational ports (`hingeErrors`).
  if (ctx.ports && snap.form !== "hinge@1") {
    for (const item of [...snap.ports.inputs, ...snap.ports.outputs]) {
      if (portQuantity(item, ctx.ports)) continue;
      say(
        item,
        item,
        snap.partType,
        `port quantity ${item} is not on ${snap.partType}`
      );
    }
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
  diagnostics.push(...evidenceErrors(snap, ctx));
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
