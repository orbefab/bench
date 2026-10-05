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

import type { Resolution } from "@sfab-bench/contract";
import {
  contentHash,
  instanceRatings,
  type LiveInstance,
  portResolutions,
  siValue,
  splitPortField,
} from "@sfab-bench/parts";
import {
  type Cadence,
  describe,
  type Observation,
  type ObservationDescriptor,
  splitQuantity,
  type Validity,
} from "./observe";

export type Pair = {
  key: string;
  ms: number;
  a: number;
  b: number;
  gap: number;
  /** Side a's `with` readings at this instant. */
  with?: Record<string, number | null>;
};

export type Paired = {
  /** In side a's order. */
  pairs: Pair[];
  unmatched: { key: string; ms: number; side: "a" | "b" }[];
  /** Matched, but a side's value cannot be compared (`Observation.excluded`). */
  excluded: { key: string; ms: number; reason: string }[];
};

export type MetricDefinition = {
  cadence: Cadence;
  /** `pairs`: every pair of a descriptor. `qualified`: a criterion's qualified pairs. */
  over: "pairs" | "qualified";
  version: number;
  definition: string;
};

export const METRICS = {
  "frame-max": {
    cadence: "frame",
    over: "pairs",
    version: 1,
    definition:
      "the largest |a - b| over paired 10 ms frames, t = 0 and the final frame included",
  },
  "frame-rms": {
    cadence: "frame",
    over: "pairs",
    version: 1,
    definition:
      "sqrt of the mean of (a - b)^2 over paired 10 ms frames, t = 0 and the final frame included; arithmetic, not time-integrated",
  },
  "step-max": {
    cadence: "step",
    over: "pairs",
    version: 1,
    definition:
      "the largest |a - b| over paired master steps, t = 0 included, with its time and both values",
  },
  "step-rms": {
    cadence: "step",
    over: "pairs",
    version: 1,
    definition:
      "sqrt of the mean of (a - b)^2 over paired master steps, t = 0 included; arithmetic, not time-integrated",
  },
  "settled-max": {
    cadence: "step",
    over: "qualified",
    version: 1,
    definition:
      "the largest |a - b| over the master-step pairs a precision's conditions qualify (steady@1, within-ratings), with its time and both values",
  },
  "settled-rms": {
    cadence: "step",
    over: "qualified",
    version: 1,
    definition:
      "sqrt of the mean of (a - b)^2 over the master-step pairs a precision's conditions qualify; arithmetic, with no integration across the gaps between them",
  },
  "event-max": {
    cadence: "events",
    over: "qualified",
    version: 2,
    definition:
      "the largest |a - b| over a reader's conversions present on both sides, comparable on both (reference bound and usable) and qualified by its conditions, with its time and both values",
  },
} as const satisfies Record<string, MetricDefinition>;

export type MetricName = keyof typeof METRICS;

export type Reduced = {
  value: number;
  pairs: number;
  /** The pair that set a `-max` metric. */
  at?: { ms: number; a: number; b: number };
};

/** The metrics that reduce every pair at a cadence, in a fixed order. */
export function metricsFor(cadence: Cadence): MetricName[] {
  return (Object.keys(METRICS) as MetricName[]).filter(
    (name) =>
      METRICS[name].cadence === cadence && METRICS[name].over === "pairs"
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
  const excluded: Paired["excluded"] = [];
  for (const row of a) {
    if (seen.has(row.key)) throw new Error(`${row.key} twice on side a`);
    seen.add(row.key);
    const match = other.get(row.key);
    if (!match) {
      unmatched.push({ key: row.key, ms: row.ms, side: "a" });
      continue;
    }
    const reason = row.excluded ?? match.excluded;
    if (reason !== undefined) {
      const side = row.excluded !== undefined ? "a" : "b";
      excluded.push({ key: row.key, ms: row.ms, reason: `${side}: ${reason}` });
      continue;
    }
    pairs.push({
      key: row.key,
      ms: row.ms,
      a: row.value,
      b: match.value,
      gap: Math.abs(row.value - match.value),
      ...(row.with ? { with: row.with } : {}),
    });
  }
  for (const row of b) {
    if (!seen.has(row.key)) {
      unmatched.push({ key: row.key, ms: row.ms, side: "b" });
    }
  }
  return { pairs, unmatched, excluded };
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

/**
 * The settle predicate, pinned by the policy identity. Changing it is a
 * policy change: every record judged by it goes red.
 */
export const STEADY = {
  name: "steady@1",
  definition:
    "a pair at t qualifies when [t - W, t + W] lies inside the run and the source side's max - min over the master steps in it is at most the resolution's value",
} as const;

/** One resolution applied to one observed quantity. */
export type Criterion = {
  /** `path.port.field`. */
  quantity: string;
  /** Where the threshold came from: the part or type id, and the port. */
  from: string;
  resolution: Resolution;
  threshold: number;
  /** `steady@1`'s W in milliseconds. */
  windowMs?: number;
  /** `within-ratings`: each rated quantity it reads, with its range. */
  ratings?: { quantity: string; rating: string; range: [number, number] }[];
  /** `within-ratings`: ratings on the read ports no observation reads. */
  unobserved?: string[];
};

type Instance = Pick<LiveInstance, "path" | "type" | "part">;

/**
 * Every criterion on `quantity`: the resolutions its instance states for
 * that field at that port (type and part, `portResolutions`). Read only
 * from those fields: no part, type or form name decides anything here.
 */
export function criteriaFor(
  instances: readonly Instance[],
  quantity: string
): Criterion[] {
  const at = splitQuantity(quantity);
  const inst = instances.find((row) => row.path === at.path);
  if (!inst) return [];
  const own = new Set(
    (inst.part.resolution?.[at.port] ?? []).map((row) => row.kind + row.field)
  );
  const typeId =
    typeof inst.part.type === "string" ? inst.part.type : inst.type.id;
  return portResolutions(inst.type, inst.part, at.port)
    .filter((row) => row.field === at.field)
    .map((resolution) => {
      const steady = resolution.conditions?.find(
        (row) => row.kind === "steady@1"
      );
      const rated = resolution.conditions?.some(
        (row) => row.kind === "within-ratings"
      );
      const ports = [at.port];
      if (resolution.reference.kind === "ratio-to") {
        const target = splitPortField(resolution.reference.quantity);
        if (target) ports.push(target.port);
      }
      return {
        quantity,
        from: `${own.has(resolution.kind + resolution.field) ? inst.part.id : typeId} ${at.port}`,
        resolution,
        threshold: siValue(resolution.value),
        ...(steady?.kind === "steady@1"
          ? { windowMs: siValue(steady.window) * 1000 }
          : {}),
        ...(rated ? ratingsOf(inst, at.path, ports) : {}),
      };
    });
}

/** The operating ratings `within-ratings` reads on `ports`. */
function ratingsOf(
  inst: Instance,
  path: string,
  ports: string[]
): Pick<Criterion, "ratings" | "unobserved"> {
  const ratings: NonNullable<Criterion["ratings"]> = [];
  const unobserved: string[] = [];
  for (const port of ports) {
    const declared = instanceRatings(inst, port);
    for (const [rating, value] of Object.entries(declared)) {
      if (!Array.isArray(value) || rating.startsWith("absMax")) continue;
      const field =
        rating === "voltage" || rating === "current" ? rating : null;
      if (field === null) {
        unobserved.push(`${port}.${rating}`);
        continue;
      }
      ratings.push({
        quantity: `${path}.${port}.${field}`,
        rating: `${port}.${rating}`,
        range: [siValue(value[0]), siValue(value[1])],
      });
    }
  }
  return { ratings, unobserved };
}

/** The observation a criterion is judged on. */
export function descriptorFor(criterion: Criterion): ObservationDescriptor {
  const { path } = splitQuantity(criterion.quantity);
  const reference = criterion.resolution.reference;
  return describe(
    criterion.quantity,
    criterion.resolution.kind === "reader" ? "events" : "step",
    reference.kind === "ratio-to"
      ? { kind: "ratio-to", quantity: `${path}.${reference.quantity}` }
      : { kind: "absolute" },
    (criterion.ratings ?? []).map((row) => row.quantity)
  );
}

export type Verdict =
  | { verdict: "within" }
  | { verdict: "over"; by: number }
  | { verdict: "none"; reason: string };

export type Judged = {
  quantity: string;
  kind: Resolution["kind"];
  from: string;
  threshold: number;
  /** The reduction judged, and its companion RMS for a precision. */
  metrics: ({ metric: MetricName } & Reduced)[];
  coverage: {
    qualified: number;
    /** Qualified master steps as simulated milliseconds. */
    ms?: number;
    /** Pairs and observations not judged, by reason. */
    excluded: Record<string, number>;
  };
} & Verdict;

/**
 * Judge `paired` (side a is the source: the realization the resolution
 * describes) against `criterion`. A pair is excluded for the first reason
 * that applies: the start or end of the run, then moving (`steady@1`),
 * then a rated quantity with no reading, then outside a rating
 * (`within-ratings`). Every unmatched observation and every excluded pair
 * is counted under its reason. On the boundary, a gap equal to the
 * threshold is within.
 */
export function judge(
  criterion: Criterion,
  paired: Paired,
  source: readonly Observation[],
  horizonMs: number,
  stepMs: number
): Judged {
  const excluded: Record<string, number> = {};
  const note = (reason: string) => {
    excluded[reason] = (excluded[reason] ?? 0) + 1;
  };
  for (const _ of paired.unmatched) note("no counterpart");
  for (const row of paired.excluded) note(row.reason);
  const window = criterion.windowMs;
  const steady = window === undefined ? null : steadyOn(source, window);
  const qualified: Pair[] = [];
  for (const pair of paired.pairs) {
    const reason = steady
      ? steady(pair.ms, horizonMs, criterion.threshold)
      : null;
    const why = reason ?? ratingsReason(criterion, pair);
    if (why === null) qualified.push(pair);
    else note(why);
  }
  const precision = criterion.resolution.kind === "precision";
  const names: MetricName[] = precision
    ? ["settled-max", "settled-rms"]
    : ["event-max"];
  const metrics = names.flatMap((metric) => {
    const got = reduce(metric, qualified);
    return got ? [{ metric, ...got }] : [];
  });
  const head = {
    quantity: criterion.quantity,
    kind: criterion.resolution.kind,
    from: criterion.from,
    threshold: criterion.threshold,
    metrics,
    coverage: {
      qualified: qualified.length,
      ...(precision ? { ms: qualified.length * stepMs } : {}),
      excluded,
    },
  };
  const judged = metrics[0];
  if (!judged) {
    const seen =
      paired.pairs.length + paired.excluded.length + paired.unmatched.length;
    const reason = precision
      ? "no settled samples"
      : seen === 0
        ? "not read"
        : "no qualified conversions";
    return { ...head, verdict: "none", reason };
  }
  return judged.value <= criterion.threshold
    ? { ...head, verdict: "within" }
    : { ...head, verdict: "over", by: judged.value - criterion.threshold };
}

/** Times are compared with this slack: step times are `n / perMs`. */
const EPS_MS = 1e-9;

/** `steady@1` on the source side's own series, sorted by time. */
function steadyOn(
  source: readonly Observation[],
  windowMs: number
): (t: number, horizonMs: number, limit: number) => string | null {
  const rows = source
    .filter((row) => row.excluded === undefined)
    .slice()
    .sort((x, y) => x.ms - y.ms);
  return (t, horizonMs, limit) => {
    if (t - windowMs < -EPS_MS || t + windowMs > horizonMs + EPS_MS) {
      return "start or end of run";
    }
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const row of rows) {
      if (row.ms < t - windowMs - EPS_MS) continue;
      if (row.ms > t + windowMs + EPS_MS) break;
      if (row.value < lo) lo = row.value;
      if (row.value > hi) hi = row.value;
    }
    return hi - lo <= limit ? null : "moving";
  };
}

function ratingsReason(criterion: Criterion, pair: Pair): string | null {
  const unobserved = criterion.unobserved ?? [];
  if (unobserved.length)
    return `ratings not observed: ${unobserved.join(", ")}`;
  for (const rating of criterion.ratings ?? []) {
    const value = pair.with?.[rating.quantity];
    if (typeof value !== "number") {
      return `ratings not observed: ${rating.quantity}`;
    }
    if (value < rating.range[0] || value > rating.range[1]) {
      return `out of ratings: ${rating.rating}`;
    }
  }
  return null;
}

/**
 * What the record judges by, as a hash: each criterion's quantity, where
 * its threshold came from and the resolution as cited, and the settle
 * predicate. A change to any of them is a policy change, never a stale
 * model.
 */
export function policyIdentity(criteria: readonly Criterion[]): string {
  return contentHash({
    criteria: criteria.map(({ quantity, from, resolution }) => ({
      quantity,
      from,
      resolution,
    })),
    steady: STEADY,
  });
}
