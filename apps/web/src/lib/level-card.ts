import type {
  AxisName,
  Range,
  RunReport,
  SnapshotFile,
} from "@sfab-bench/contract";

const AXES: readonly AxisName[] = ["behaviour", "body", "visual"];

export type LevelAxisLine = {
  axis: AxisName;
  /** `behaviour 1 · avr8js` */
  line: string;
  /** `path rule nano`, `type rule arduino-nano`, `parent class 2`, `default`, or `fallback from 2`. */
  reason: string;
};

export type LevelSnapshot = {
  /** Instance the snapshot ran on. The card's own path, or one nested under it. */
  path: string;
  ref: string;
  quality: string;
  /** `VBUS static max 1.5 mV vs class 2`, or a free-run `max` / `rms` pair. */
  errors: string[];
  /** `captured, from sfab/nano-ch340@1.0.0 class 2, fixture …, tool …` */
  provenance: string | null;
  /** The valid range the run checks: `IN current 0 to 20 mA`. */
  range: string[];
  /** Envelope warnings: the run went outside the valid range. */
  warnings: string[];
  /** The part changed since this snapshot was captured. */
  stale: boolean;
  /** Why freshness could not be checked. Null when it was. */
  unchecked: string | null;
};

/** What one inspector card shows for an instance. Null when the report has no row. */
export type LevelCard = {
  axes: LevelAxisLine[];
  /** Set when a snapshot ran on this instance. */
  snapshot: LevelSnapshot | null;
  /** Snapshots on children of this instance, such as `nano.power` on `nano`. */
  nested: LevelSnapshot[];
  /** Effects the chosen levels leave out. The card keeps this collapsed. */
  omits: string[];
};

/**
 * Map a run report and an instance path to the card's Level block.
 * The words come from the report; the card does not resolve levels itself.
 */
export function levelCard(
  report: RunReport | null,
  path: string
): LevelCard | null {
  if (!report) return null;
  const rows = report.levels.filter((row) => row.path === path);
  if (rows.length === 0) return null;
  const byAxis = new Map(rows.map((row) => [row.axis, row]));
  const axes: LevelAxisLine[] = [];
  for (const axis of AXES) {
    const row = byAxis.get(axis);
    if (!row) continue;
    axes.push({
      axis,
      line: axisLine(row.class, row.variant, axis),
      reason: reasonWords(row.reason, row.source),
    });
  }
  const omits: string[] = [];
  for (const row of report.notSimulated) {
    if (row.path !== path) continue;
    for (const effect of row.effects) omits.push(`${row.axis}: ${effect}`);
  }
  const snaps = report.snapshots.filter((row) => row.path === path);
  const nested = report.snapshots.filter((row) =>
    row.path.startsWith(`${path}.`)
  );
  return {
    axes,
    snapshot: snaps.length ? snapshotOf(path, snaps) : null,
    nested: groupedSnapshots(nested),
    omits,
  };
}

function groupedSnapshots(rows: RunReport["snapshots"]): LevelSnapshot[] {
  const byPath = new Map<string, RunReport["snapshots"]>();
  for (const row of rows) {
    const group = byPath.get(row.path) ?? [];
    group.push(row);
    byPath.set(row.path, group);
  }
  return [...byPath.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([rowPath, group]) => snapshotOf(rowPath, group));
}

function snapshotOf(path: string, rows: RunReport["snapshots"]): LevelSnapshot {
  const first = rows[0];
  if (!first) {
    return {
      path,
      ref: "",
      quality: "",
      errors: [],
      provenance: null,
      range: [],
      warnings: [],
      stale: false,
      unchecked: null,
    };
  }
  const errors: string[] = [];
  const range: string[] = [];
  const warnings: string[] = [];
  for (const row of rows) {
    if (row.error !== undefined) errors.push(...errorLines(row.error));
    for (const [key, bounds] of Object.entries(row.bounds ?? {})) {
      range.push(rangeLine(key, bounds));
    }
    for (const warning of row.envelope ?? []) warnings.push(warning);
  }
  return {
    path,
    ref: rows.map((row) => snapshotRef(row)).join(", "),
    quality: rows.map((row) => row.quality).join(", "),
    errors,
    provenance: provenanceLine(first.provenance),
    range,
    warnings,
    stale: rows.some((row) => row.stale === true),
    unchecked:
      rows
        .flatMap((row) => (row.unchecked ? [row.unchecked] : []))
        .join("; ") || null,
  };
}

/** `IN current 0 to 20 mA`: both ends in the same unit. */
export function rangeLine(key: string, bounds: Range): string {
  const dot = key.lastIndexOf(".");
  const port = dot > 0 ? key.slice(0, dot) : key;
  const field = dot > 0 ? key.slice(dot + 1) : "";
  const [lo, hi] = bounds.map((end) => (typeof end === "number" ? end : end.v));
  const unit = FIELD_UNIT[field] ?? "";
  const name = field ? `${port} ${field}` : port;
  if (lo === undefined || hi === undefined) return name;
  const milli =
    (unit === "V" || unit === "A") && Math.max(Math.abs(lo), Math.abs(hi)) < 1;
  const scale = milli ? 1000 : 1;
  const shown = milli ? `m${unit}` : unit;
  const span = `${sig(lo * scale)} to ${sig(hi * scale)}`;
  return shown ? `${name} ${span} ${shown}` : `${name} ${span}`;
}

function snapshotRef(row: { axis: AxisName; ref: string }): string {
  return row.axis === "body" ? `body ${row.ref}` : row.ref;
}

function provenanceLine(
  provenance: RunReport["snapshots"][number]["provenance"]
): string | null {
  if (!provenance) return null;
  const parts: string[] = [provenance.source];
  if (provenance.from) {
    parts.push(`from ${provenance.from.part} class ${provenance.from.level}`);
  }
  if (provenance.fixture) parts.push(`fixture ${provenance.fixture}`);
  if (provenance.tool) {
    parts.push(`tool ${provenance.tool.name} ${provenance.tool.version}`);
  }
  return parts.join(", ");
}

function errorLines(error: SnapshotFile["error"]): string[] {
  if (error === "none-available") return ["no free-run error"];
  const groups = new Map<
    string,
    {
      name: string;
      unit: string;
      max?: number;
      rms?: number;
      staticMax?: number;
      rise?: number;
      vs?: string;
    }
  >();
  for (const row of error) {
    const named = quantityName(row.quantity);
    const key = `${row.quantity}|${row.baseline?.level ?? ""}`;
    const group = groups.get(key) ?? {
      name: named.name,
      unit: named.unit,
      ...(row.baseline ? { vs: row.baseline.level } : {}),
    };
    if (row.metric === "free-run-max-abs") group.max = row.value;
    if (row.metric === "free-run-rms") group.rms = row.value;
    if (row.metric === "static-max-abs") group.staticMax = row.value;
    if (row.metric === "step-rise") group.rise = row.value;
    groups.set(key, group);
  }
  const lines: string[] = [];
  for (const group of groups.values()) {
    const vs = group.vs ? ` vs class ${group.vs}` : "";
    if (group.staticMax !== undefined) {
      lines.push(
        `${group.name} static max ${humanValue(group.staticMax, group.unit)}${vs}`
      );
    }
    const bits: string[] = [];
    if (group.max !== undefined) {
      bits.push(`max ${humanValue(group.max, group.unit)}`);
    }
    if (group.rms !== undefined) {
      bits.push(`rms ${humanValue(group.rms, group.unit)}`);
    }
    if (bits.length > 0) {
      lines.push(`${group.name} free-run ${bits.join(", ")}${vs}`);
    }
    if (group.rise !== undefined) {
      lines.push(`${group.name} step-rise ${sig(group.rise * 1000)} ms${vs}`);
    }
  }
  return lines;
}

const FIELD_UNIT: Record<string, string> = {
  voltage: "V",
  current: "A",
  resistance: "Ω",
  angle: "rad",
  angularVelocity: "rad/s",
  speed: "rad/s",
  torque: "N·m",
  position: "m",
  temperature: "K",
};

function quantityName(quantity: string): { name: string; unit: string } {
  const dot = quantity.lastIndexOf(".");
  const port = dot > 0 ? quantity.slice(0, dot) : quantity;
  const field = dot > 0 ? quantity.slice(dot + 1) : "";
  const name =
    field === "voltage" && !port.startsWith("V") && !port.startsWith("+")
      ? `+${port}`
      : port;
  return { name, unit: FIELD_UNIT[field] ?? "" };
}

/** Three significant figures. Millivolts and milliamps below a tenth of the SI unit. */
function humanValue(value: number, unit: string): string {
  if (!Number.isFinite(value)) return String(value);
  const small = unit === "V" || unit === "A";
  const abs = Math.abs(value);
  if (small && abs !== 0 && abs < 0.1) return `${sig(value * 1000)} m${unit}`;
  return unit ? `${sig(value)} ${unit}` : sig(value);
}

function sig(value: number): string {
  const abs = Math.abs(value);
  if (abs === 0) return "0";
  const digits = Math.min(6, Math.max(0, 2 - Math.floor(Math.log10(abs))));
  const fixed = value.toFixed(digits);
  return digits > 0 ? fixed.replace(/\.?0+$/, "") : fixed;
}

export function axisLine(
  level: number | null,
  variant: string | null,
  axis: AxisName
): string {
  if (level === null) return `${axis} none`;
  return `${axis} ${level} · ${variant ?? "—"}`;
}

/** Shorten a fallback reason. Other reasons are already the words on the card. */
export function reasonWords(
  reason: string,
  source: RunReport["levels"][number]["source"]
): string {
  if (source !== "fallback") return reason;
  const from = /fallback from (\d+)/.exec(reason);
  if (!from) return reason;
  const capture = reason.includes("capture suggested");
  return capture
    ? `fallback from ${from[1]}, capture suggested`
    : `fallback from ${from[1]}`;
}
