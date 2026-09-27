import type { AxisName, RunReport } from "@sfab-bench/contract";

const AXES: readonly AxisName[] = ["behaviour", "body", "visual"];

export type LevelAxisLine = {
  axis: AxisName;
  /** `behaviour 1 · avr8js` */
  line: string;
  /** `path rule nano`, `type rule arduino-nano`, `default`, or `fallback from 2`. */
  reason: string;
};

/** What one inspector card shows for an instance. Null when the report has no row. */
export type LevelCard = {
  axes: LevelAxisLine[];
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
  return { axes, omits };
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
