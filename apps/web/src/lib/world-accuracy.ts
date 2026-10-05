/**
 * The document's assembly check, as the cards show it (run 7 unit 3c,
 * `report.accuracy`). A verdict shows only where the check is this run's:
 * on the card of the part whose port it was measured at, naming the
 * snapshots it compares, and never on another run.
 */

import type { AccuracyRow, RunReport } from "@sfab-bench/contract";

export type AccuracyCriterionLine = {
  /** "precision 0.0169 rad from sfab/sg90@1.0.0 shaft, steady@1 W 0.06 s". */
  against: string;
  /** "within", "over by 0.002 rad", or "no verdict: no settled samples". */
  verdict: string;
  tone: "ok" | "warn" | "none";
  /** "settled-max 0.00139 rad on 2010 of 3001 steps (120 start or end, 871 moving)". */
  measured: string;
};

export type AccuracyLine = {
  quantity: string;
  /** "gap max 0.00544 rad, rms 0.00115 rad". */
  gap: string;
  /** Empty: no resolution covers it, so the gap shows with no verdict. */
  criteria: AccuracyCriterionLine[];
};

export type AccuracyView = {
  record: string;
  applies: boolean;
  /** "servo sfab/sg90-servo@1.0.0, uno.power …". */
  snapshots: string;
  /** Why a verdict here is not accepted as is; empty when in domain. */
  domain: string[];
  lines: AccuracyLine[];
};

const UNIT: Record<string, string> = {
  voltage: "V",
  current: "A",
  angle: "rad",
};

function amount(n: number, field: string | null): string {
  if (!Number.isFinite(n)) return "—";
  const digits = String(Number(n.toPrecision(3)));
  const unit = field ? UNIT[field] : undefined;
  return unit ? `${digits} ${unit}` : digits;
}

function criterionLine(
  row: AccuracyRow,
  criterion: AccuracyRow["criteria"][number]
): AccuracyCriterionLine {
  const field = criterion.ratioTo ? null : row.field;
  const of = criterion.ratioTo ? ` of ${criterion.ratioTo}` : "";
  const settle =
    criterion.window !== undefined
      ? `, steady@1 W ${amount(criterion.window, null)} s`
      : "";
  const excluded = Object.entries(criterion.coverage.excluded);
  const total =
    criterion.coverage.qualified +
    excluded.reduce((sum, [, count]) => sum + count, 0);
  const unitWord = criterion.kind === "precision" ? "steps" : "conversions";
  const why = excluded.length
    ? ` (${excluded.map(([reason, count]) => `${count} ${reason}`).join(", ")})`
    : "";
  const value =
    criterion.value === undefined
      ? `${criterion.metric} —`
      : `${criterion.metric} ${amount(criterion.value, field)}${of}`;
  return {
    against: `${criterion.kind} ${amount(criterion.threshold, field)}${of} from ${criterion.from}${settle}`,
    verdict:
      criterion.verdict === "within"
        ? "within"
        : criterion.verdict === "over"
          ? `over by ${amount(criterion.by, field)}${of}`
          : `no verdict: ${criterion.reason}`,
    tone:
      criterion.verdict === "within"
        ? "ok"
        : criterion.verdict === "over"
          ? "warn"
          : "none",
    measured: `${value} on ${criterion.coverage.qualified} of ${total} ${unitWord}${why}`,
  };
}

/** On a part's card its port and field; on the document's, its path too. */
function lineOf(row: AccuracyRow, whole: boolean): AccuracyLine {
  return {
    quantity: `${whole ? `${row.path}.` : ""}${row.port} ${row.field}`,
    gap: `gap max ${amount(row.gap.max, row.field)}, rms ${amount(row.gap.rms, row.field)}`,
    criteria: row.criteria.map((criterion) => criterionLine(row, criterion)),
  };
}

/**
 * The check as `path`'s card shows it: the rows measured at its ports.
 * With no path, the document's: every row. Null when the document has no
 * check, or none of its rows is at `path`.
 */
export function accuracyView(
  report: RunReport | null,
  path?: string
): AccuracyView | null {
  const accuracy = report?.accuracy;
  if (!report || !accuracy) return null;
  const rows =
    path === undefined
      ? accuracy.rows
      : accuracy.rows.filter((row) => row.path === path);
  if (path !== undefined && rows.length === 0) return null;
  const domain = [
    ...(accuracy.inDomain
      ? []
      : ["the check ran outside a snapshot's envelope"]),
    ...report.snapshots
      .filter((row) => row.stale || row.unchecked)
      .map(
        (row) =>
          `${row.path} ${row.ref} is ${row.stale ? "stale" : "unchecked"}`
      ),
    ...report.snapshots
      .filter((row) => (row.envelope ?? []).length > 0)
      .map((row) => `this run took ${row.path} outside its envelope`),
  ];
  return {
    record: accuracy.record,
    applies: accuracy.applies,
    snapshots: accuracy.snapshots.join(", "),
    domain: accuracy.applies ? domain : [],
    lines: rows.map((row) => lineOf(row, path === undefined)),
  };
}

/** The document card's one line: what the check found on this run. */
export function accuracySummary(view: AccuracyView): string {
  if (!view.applies) {
    return "Not this run: the check measured other levels, parts or play settings, so no verdict shows.";
  }
  const counts = new Map<string, number>();
  for (const line of view.lines) {
    const verdicts = line.criteria.length
      ? line.criteria.map((row) => row.tone)
      : ["unjudged" as const];
    for (const verdict of verdicts) {
      counts.set(verdict, (counts.get(verdict) ?? 0) + 1);
    }
  }
  const words: [string, string][] = [
    ["ok", "within"],
    ["warn", "over"],
    ["none", "no verdict"],
    ["unjudged", "no resolution"],
  ];
  return words
    .filter(([key]) => counts.has(key))
    .map(([key, word]) => `${counts.get(key)} ${word}`)
    .join(", ");
}
