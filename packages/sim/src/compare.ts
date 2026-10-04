/**
 * Two sides of one comparison, paired and reduced (run 7 unit 3a).
 *
 * Observations pair by key: the same instant of the same reading on both
 * sides (`observe.ts`). A pair's gap is `|a − b|`. Two independent bands
 * (each side's min and max) are never subtracted: a series and its reverse
 * have the same band and a paired gap of the whole range.
 *
 * An observation on one side with no counterpart on the other is not
 * paired and not dropped: it is listed as unmatched, so a reader that
 * converts at different instants on the two sides says so.
 *
 * Every metric has a name, a cadence it reduces, a version and its
 * definition in words. A stored number carries the name, and the
 * comparison identity carries the definitions, so a number cannot move
 * because a formula changed under the same name.
 */

import { contentHash } from "@sfab-bench/parts";
import type {
  Cadence,
  Observation,
  ObservationDescriptor,
  Validity,
} from "./observe";

export type Pair = {
  key: string;
  ms: number;
  a: number;
  b: number;
  gap: number;
};

export type Paired = {
  /** In side a's order. */
  pairs: Pair[];
  unmatched: { key: string; ms: number; side: "a" | "b" }[];
};

export type MetricDefinition = {
  cadence: Cadence;
  version: number;
  definition: string;
};

export const METRICS = {
  "frame-max": {
    cadence: "frame",
    version: 1,
    definition:
      "the largest |a - b| over paired 10 ms frames, t = 0 and the final frame included",
  },
  "frame-rms": {
    cadence: "frame",
    version: 1,
    definition:
      "sqrt of the mean of (a - b)^2 over paired 10 ms frames, t = 0 and the final frame included; arithmetic, not time-integrated",
  },
  "step-max": {
    cadence: "step",
    version: 1,
    definition:
      "the largest |a - b| over paired master steps, t = 0 included, with its time and both values",
  },
  "step-rms": {
    cadence: "step",
    version: 1,
    definition:
      "sqrt of the mean of (a - b)^2 over paired master steps, t = 0 included; arithmetic, not time-integrated",
  },
  "event-max": {
    cadence: "events",
    version: 1,
    definition:
      "the largest |a - b| over a reader's conversions present on both sides, with its time and both values",
  },
} as const satisfies Record<string, MetricDefinition>;

export type MetricName = keyof typeof METRICS;

export type Reduced = {
  value: number;
  pairs: number;
  /** The pair that set a `-max` metric. */
  at?: { ms: number; a: number; b: number };
};

/** The metrics that reduce a cadence, in a fixed order. */
export function metricsFor(cadence: Cadence): MetricName[] {
  return (Object.keys(METRICS) as MetricName[]).filter(
    (name) => METRICS[name].cadence === cadence
  );
}

/** Pair two series by key. A key twice on one side is an error. */
export function pairByKey(a: Observation[], b: Observation[]): Paired {
  const other = new Map<string, Observation>();
  for (const row of b) {
    if (other.has(row.key)) throw new Error(`${row.key} twice on side b`);
    other.set(row.key, row);
  }
  const seen = new Set<string>();
  const pairs: Pair[] = [];
  const unmatched: Paired["unmatched"] = [];
  for (const row of a) {
    if (seen.has(row.key)) throw new Error(`${row.key} twice on side a`);
    seen.add(row.key);
    const match = other.get(row.key);
    if (!match) {
      unmatched.push({ key: row.key, ms: row.ms, side: "a" });
      continue;
    }
    pairs.push({
      key: row.key,
      ms: row.ms,
      a: row.value,
      b: match.value,
      gap: Math.abs(row.value - match.value),
    });
  }
  for (const row of b) {
    if (!seen.has(row.key)) {
      unmatched.push({ key: row.key, ms: row.ms, side: "b" });
    }
  }
  return { pairs, unmatched };
}

/** `metric` over `pairs`. Null when there is no pair to reduce. */
export function reduce(metric: MetricName, pairs: Pair[]): Reduced | null {
  if (pairs.length === 0) return null;
  if (metric.endsWith("-rms")) {
    let sum = 0;
    for (const pair of pairs) sum += pair.gap * pair.gap;
    return { value: Math.sqrt(sum / pairs.length), pairs: pairs.length };
  }
  let worst: Pair | null = null;
  for (const pair of pairs) if (!worst || pair.gap > worst.gap) worst = pair;
  if (!worst) return null;
  return {
    value: worst.gap,
    pairs: pairs.length,
    at: { ms: worst.ms, a: worst.a, b: worst.b },
  };
}

/**
 * What the comparison is, as a hash: its descriptors, the definitions of
 * the metrics they reduce to, and `observer`, a fingerprint of the code
 * that takes and reduces them (`OBSERVER_SOURCES`).
 */
export function comparisonIdentity(
  observations: readonly ObservationDescriptor[],
  observer: string
): string {
  const cadences = new Set(observations.map((row) => row.cadence));
  const metrics = Object.fromEntries(
    (Object.keys(METRICS) as MetricName[])
      .filter((name) => cadences.has(METRICS[name].cadence))
      .map((name) => [name, METRICS[name]])
  );
  return contentHash({ observations, metrics, observer });
}

/** Validity items in one and not the other, one line each. */
export function validityDiff(stored: Validity, measured: Validity): string[] {
  const out: string[] = [];
  for (const kind of ["envelope", "stale", "unchecked", "degraded"] as const) {
    const was = new Set(stored[kind].map((row) => JSON.stringify(row)));
    const now = new Set(measured[kind].map((row) => JSON.stringify(row)));
    for (const row of now) if (!was.has(row)) out.push(`new ${kind} ${row}`);
    for (const row of was) if (!now.has(row)) out.push(`gone ${kind} ${row}`);
  }
  return out;
}
