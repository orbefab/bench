import type { AxisName, RunReport, SnapshotFile } from "@sfab-bench/contract";

const AXES: readonly AxisName[] = ["behaviour", "body", "visual"];

export type LevelAxisLine = {
  axis: AxisName;
  /** `behaviour 1 · avr8js` */
  line: string;
  /** `path rule nano`, `type rule arduino-nano`, `default`, or `fallback from 2`. */
  reason: string;
};

export type LevelSnapshot = {
  ref: string;
  quality: string;
  /** `+5V free-run max 1.65 mV, rms 1.24 mV vs class 2` */
  errors: string[];
  /** `captured, from sfab/nano-ch340@1.0.0 class 2, fixture …, tool …` */
  provenance: string | null;
  warnings: string[];
};

/** What one inspector card shows for an instance. Null when the report has no row. */
export type LevelCard = {
  axes: LevelAxisLine[];
  /** Set when a snapshot ran on this instance. */
  snapshot: LevelSnapshot | null;
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
  return { axes, snapshot: snaps.length ? snapshotOf(snaps) : null, omits };
}

function snapshotOf(rows: RunReport["snapshots"]): LevelSnapshot {
  const first = rows[0];
  if (!first)
    return { ref: "", quality: "", errors: [], provenance: null, warnings: [] };
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const row of rows) {
    if (row.error !== undefined) errors.push(...errorLines(row.error));
    for (const warning of row.envelope ?? []) warnings.push(warning);
  }
  return {
    ref: rows.map((row) => row.ref).join(", "),
    quality: rows.map((row) => row.quality).join(", "),
    errors,
    provenance: provenanceLine(first.provenance),
    warnings,
  };
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
  }
  return lines;
}

const FIELD_UNIT: Record<string, string> = {
  voltage: "V",
  current: "A",
  resistance: "Ω",
  angle: "rad",
  angularVelocity: "rad/s",
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
  const digits = Math.max(0, 2 - Math.floor(Math.log10(abs)));
  return value.toFixed(Math.min(6, digits)).replace(/\.?0+$/, "");
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
