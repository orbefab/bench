/**
 * An assembly check's stored rows (`sfab.assembly-check@2`) and the two
 * row-level gates of run 7 § 7 over them: reproduction (every metric of
 * the row and of each criterion) and applicability and verdict (each
 * criterion's threshold, coverage and verdict). `assembly.selfcheck`
 * applies them to each remeasured row; `budget.selfcheck` bites them.
 */

import type {
  Criterion,
  Judged,
  MetricName,
  Reduced,
  Verdict,
} from "@sfab-bench/sim/compare";

/** How far a recomputed gap may sit from its row, relative (unit 4's). */
export const DRIFT = 1e-4;

/** A named metric as stored: `pairs` are the pairs it reduced. */
export type MetricRow = {
  metric: MetricName;
  value: number;
  pairs: number;
  /** The pair that set a `-max` metric. */
  at?: { ms: number; detailed: number; snapshot: number };
};

export type CriterionRow = {
  kind: Judged["kind"];
  from: string;
  threshold: number;
  reference: Criterion["resolution"]["reference"];
  conditions: NonNullable<Criterion["resolution"]["conditions"]>;
  source: Criterion["resolution"]["source"];
  metrics: MetricRow[];
  coverage: Judged["coverage"];
} & Verdict;

export type QuantityRow = {
  quantity: string;
  metrics: (MetricRow & { unmatched: number })[];
  criteria: CriterionRow[];
  /** Present when no criterion covers the quantity. */
  verdict?: "none";
  reason?: string;
  inDomain: boolean;
};

/** How far `got` is from `stored`, relative (unit 4's rule). */
function driftOf(got: number, stored: number): number {
  return (got - stored) / Math.max(Math.abs(stored), 1e-12);
}

export function metricRow(metric: MetricName, got: Reduced): MetricRow {
  return {
    metric,
    value: Number(got.value.toPrecision(10)),
    pairs: got.pairs,
    ...(got.at
      ? {
          at: {
            ms: got.at.ms,
            detailed: Number(got.at.a.toPrecision(10)),
            snapshot: Number(got.at.b.toPrecision(10)),
          },
        }
      : {}),
  };
}

export function criterionRow(
  criterion: Criterion,
  judged: Judged
): CriterionRow {
  const verdict: Verdict =
    judged.verdict === "over"
      ? { verdict: "over", by: Number(judged.by.toPrecision(10)) }
      : judged.verdict === "none"
        ? { verdict: "none", reason: judged.reason }
        : { verdict: "within" };
  return {
    kind: judged.kind,
    from: judged.from,
    threshold: judged.threshold,
    reference: criterion.resolution.reference,
    conditions: criterion.resolution.conditions ?? [],
    source: criterion.resolution.source,
    metrics: judged.metrics.map(({ metric, ...got }) => metricRow(metric, got)),
    coverage: judged.coverage,
    ...verdict,
  };
}

/** Why `now` does not reproduce `was`, or null. */
function moved(was: MetricRow | undefined, now: MetricRow): string | null {
  if (!was) return "no stored row";
  const drift = driftOf(now.value, was.value);
  if (Math.abs(drift) > DRIFT) {
    return `${now.value} vs the stated ${was.value} (${drift.toExponential(2)})`;
  }
  if (now.pairs !== was.pairs) {
    return `${now.pairs} pairs vs the stated ${was.pairs}`;
  }
  // The pair that set a max is part of the number: the same gap at
  // another time, or between other values, is not the same row.
  const same =
    was.at === undefined
      ? now.at === undefined
      : now.at !== undefined &&
        was.at.ms === now.at.ms &&
        Math.abs(driftOf(now.at.detailed, was.at.detailed)) <= DRIFT &&
        Math.abs(driftOf(now.at.snapshot, was.at.snapshot)) <= DRIFT;
  return same
    ? null
    : `set at ${JSON.stringify(now.at)}, the record says ${JSON.stringify(was.at)}`;
}

/** Why a criterion's applicability or verdict moved, or null. */
function verdictMoved(was: CriterionRow, now: CriterionRow): string | null {
  if (was.threshold !== now.threshold) {
    return `threshold ${now.threshold} vs the stated ${was.threshold}`;
  }
  if (JSON.stringify(was.coverage) !== JSON.stringify(now.coverage)) {
    return `coverage ${JSON.stringify(now.coverage)} vs the stated ${JSON.stringify(was.coverage)}`;
  }
  const said = (row: CriterionRow) =>
    row.verdict === "none" ? `none (${row.reason})` : row.verdict;
  if (said(was) !== said(now)) {
    return `verdict ${said(now)} vs the stated ${said(was)}`;
  }
  if (
    was.verdict === "over" &&
    now.verdict === "over" &&
    Math.abs(driftOf(now.by, was.by)) > DRIFT
  ) {
    return `over by ${now.by} vs the stated ${was.by}`;
  }
  return null;
}

const names = (rows: { metric: MetricName }[]) =>
  JSON.stringify(rows.map((row) => row.metric));

/**
 * Why the remeasured `now` does not match the stored `was`: reproduction
 * of every metric (criterion metrics and `none` rows too), then each
 * criterion's applicability and verdict. Empty when it matches.
 */
export function rowProblems(was: QuantityRow, now: QuantityRow): string[] {
  const problems: string[] = [];
  if (names(was.metrics) !== names(now.metrics)) {
    problems.push(
      `metrics ${names(now.metrics)} vs the stated ${names(was.metrics)}`
    );
  }
  for (const metric of now.metrics) {
    const prior = was.metrics.find((row) => row.metric === metric.metric);
    const why =
      moved(prior, metric) ??
      (prior?.unmatched === metric.unmatched
        ? null
        : `${metric.unmatched} unmatched vs the stated ${prior?.unmatched}`);
    if (why !== null) problems.push(`${metric.metric}: ${why}`);
  }
  if (
    was.criteria.length !== now.criteria.length ||
    was.verdict !== now.verdict ||
    was.reason !== now.reason ||
    was.inDomain !== now.inDomain
  ) {
    problems.push(
      `${now.criteria.length} criteria (${now.verdict ?? "judged"}, in domain ${now.inDomain}), the record ${was.criteria.length} (${was.verdict ?? "judged"}, in domain ${was.inDomain})`
    );
  }
  now.criteria.forEach((row, i) => {
    const prior = was.criteria[i];
    if (!prior) return;
    const label = `${row.kind} from ${row.from}`;
    if (prior.kind !== row.kind || prior.from !== row.from) {
      problems.push(
        `${label}: the record's criterion ${i} is ${prior.kind} from ${prior.from}`
      );
    }
    // The resolution as cited: the policy pins the catalog's, this the row's.
    for (const key of ["reference", "conditions", "source"] as const) {
      if (JSON.stringify(prior[key]) !== JSON.stringify(row[key])) {
        problems.push(
          `${label}: ${key} ${JSON.stringify(row[key])} vs the stated ${JSON.stringify(prior[key])}`
        );
      }
    }
    if (names(prior.metrics) !== names(row.metrics)) {
      problems.push(
        `${label}: metrics ${names(row.metrics)} vs the stated ${names(prior.metrics)}`
      );
    }
    for (const metric of row.metrics) {
      const why = moved(
        prior.metrics.find((m) => m.metric === metric.metric),
        metric
      );
      if (why !== null) problems.push(`${label} ${metric.metric}: ${why}`);
    }
    // Applicability and verdict: every transition is red.
    const why = verdictMoved(prior, row);
    if (why !== null) problems.push(`${label}: ${why}`);
  });
  return problems;
}
