/**
 * The card's program and value-set gestures (run 7 unit 5a-1). Pure: each
 * returns the whole next value in its canonical form, or null when the
 * gesture changes nothing or would leave an invalid value. One gesture is
 * one `set-param`, so one undo step.
 */

import {
  type Program,
  parseProgram,
  parseValueSet,
  programDuration,
  type Segment,
  type SegmentKind,
  sampleProgram,
  type ValueSet,
} from "@sfab-bench/contract";

/** A new segment of `kind`, `dur` seconds long. */
export function defaultSegment(kind: SegmentKind, dur = 1): Segment {
  switch (kind) {
    case "hold":
    case "step":
      return { kind, dur, level: 0 };
    case "ramp":
      return { kind, dur, from: 0, to: 1 };
    case "chirp":
      return { kind, dur, amp: 1, f0: 1, f1: 10, phase: 0 };
    case "prbs":
      return { kind, dur, seed: 1, period: 0.01, low: 0, high: 1 };
  }
}

/** A program with one variant `a`: hold 0 for one second. */
export function newProgram(): Program {
  return {
    kind: "program",
    use: "a",
    variants: [{ id: "a", segments: [defaultSegment("hold")] }],
  };
}

/** A value set of one value, 0. */
export function newValueSet(): ValueSet {
  return { kind: "values", use: 0, values: [0] };
}

function settle(next: Program, previous: Program): Program | null {
  const parsed = parseProgram(next);
  if (!parsed.ok) return null;
  return JSON.stringify(parsed.value) === JSON.stringify(previous)
    ? null
    : parsed.value;
}

function settleValues(next: ValueSet, previous: ValueSet): ValueSet | null {
  const parsed = parseValueSet(next);
  if (!parsed.ok) return null;
  return JSON.stringify(parsed.value) === JSON.stringify(previous)
    ? null
    : parsed.value;
}

/** `program` with variant `id`'s segments replaced by `edit`'s result. */
function withSegments(
  program: Program,
  id: string,
  edit: (segments: Segment[]) => Segment[]
): Program | null {
  if (!program.variants.some((row) => row.id === id)) return null;
  return settle(
    {
      ...program,
      variants: program.variants.map((row) =>
        row.id === id ? { ...row, segments: edit([...row.segments]) } : row
      ),
    },
    program
  );
}

/** A hold after segment `at` (at the end when `at` is past it). */
export function addSegment(
  program: Program,
  id: string,
  at: number
): Program | null {
  return withSegments(program, id, (segments) => {
    segments.splice(at + 1, 0, defaultSegment("hold"));
    return segments;
  });
}

export function removeSegment(
  program: Program,
  id: string,
  at: number
): Program | null {
  return withSegments(program, id, (segments) =>
    segments.filter((_, index) => index !== at)
  );
}

/** Segment `at` one place earlier (`-1`) or later (`1`). */
export function moveSegment(
  program: Program,
  id: string,
  at: number,
  by: -1 | 1
): Program | null {
  return withSegments(program, id, (segments) => {
    const to = at + by;
    const moving = segments[at];
    const other = segments[to];
    if (!moving || !other) return segments;
    segments[at] = other;
    segments[to] = moving;
    return segments;
  });
}

/** Segment `at` as a new `kind`, keeping its duration. */
export function setSegmentKind(
  program: Program,
  id: string,
  at: number,
  kind: SegmentKind
): Program | null {
  return withSegments(program, id, (segments) =>
    segments.map((row, index) =>
      index === at && row.kind !== kind ? defaultSegment(kind, row.dur) : row
    )
  );
}

/** One field of segment `at`; null when the result is not a program. */
export function setSegmentField(
  program: Program,
  id: string,
  at: number,
  field: string,
  value: number
): Program | null {
  return withSegments(program, id, (segments) =>
    segments.map((row, index) =>
      index === at && Object.hasOwn(row, field) && field !== "kind"
        ? ({ ...row, [field]: value } as Segment)
        : row
    )
  );
}

/** Play runs variant `id`. */
export function selectVariant(program: Program, id: string): Program | null {
  return settle({ ...program, use: id }, program);
}

function freshId(program: Program): string {
  const taken = new Set(program.variants.map((row) => row.id));
  for (let n = 0; ; n++) {
    let id = "";
    let k = n;
    do {
      id = String.fromCharCode(97 + (k % 26)) + id;
      k = Math.floor(k / 26) - 1;
    } while (k >= 0);
    if (!taken.has(id)) return id;
  }
}

/** A copy of the variant Play runs, under a new id, now the one Play runs. */
export function addVariant(program: Program): Program | null {
  const used = program.variants.find((row) => row.id === program.use);
  if (!used) return null;
  const id = freshId(program);
  return settle(
    {
      ...program,
      use: id,
      variants: [
        ...program.variants,
        { id, segments: structuredClone(used.segments) },
      ],
    },
    program
  );
}

/** Variant `id` gone; Play runs the first left when it ran that one. */
export function removeVariant(program: Program, id: string): Program | null {
  const variants = program.variants.filter((row) => row.id !== id);
  const first = variants[0];
  if (!first) return null;
  return settle(
    {
      ...program,
      use: program.use === id ? first.id : program.use,
      variants,
    },
    program
  );
}

export function renameVariant(
  program: Program,
  id: string,
  to: string
): Program | null {
  const name = to.trim();
  if (!name || program.variants.some((row) => row.id === name)) return null;
  return settle(
    {
      ...program,
      use: program.use === id ? name : program.use,
      variants: program.variants.map((row) =>
        row.id === id ? { ...row, id: name } : row
      ),
    },
    program
  );
}

export function setValue(
  set: ValueSet,
  at: number,
  value: number
): ValueSet | null {
  return settleValues(
    { ...set, values: set.values.map((row, i) => (i === at ? value : row)) },
    set
  );
}

/** A copy of the last value at the end. */
export function addValue(set: ValueSet): ValueSet | null {
  const last = set.values[set.values.length - 1] ?? 0;
  return settleValues({ ...set, values: [...set.values, last] }, set);
}

/** Value `at` gone; Play keeps the value it ran when that one stays. */
export function removeValue(set: ValueSet, at: number): ValueSet | null {
  const values = set.values.filter((_, i) => i !== at);
  const use = set.use === at ? 0 : set.use > at ? set.use - 1 : set.use;
  return settleValues({ ...set, use, values }, set);
}

/** Play runs `values[at]`. */
export function selectValue(set: ValueSet, at: number): ValueSet | null {
  return settleValues({ ...set, use: at }, set);
}

/**
 * The preview of variant `id`: `points` samples across [0, total), and
 * the end, with the range they span.
 */
export function previewOf(
  program: Program,
  id = program.use,
  points = 240
): {
  total: number;
  samples: { t: number; v: number }[];
  min: number;
  max: number;
} {
  const total = programDuration(program, id);
  const samples: { t: number; v: number }[] = [];
  for (let k = 0; k <= points; k++) {
    const t = (total * k) / points;
    samples.push({ t, v: sampleProgram(program, t, id) });
  }
  const values = samples.map((row) => row.v);
  return {
    total,
    samples,
    min: Math.min(...values),
    max: Math.max(...values),
  };
}
