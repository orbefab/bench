/**
 * Structured params (run 7 unit 5a-1): an instrument's program, and a
 * physical value a rig swaps between runs. One canonical form, a strict
 * parser, and a pure sampler.
 *
 * Time is seconds. A program variant's segments abut: segment i owns
 * [T_i, T_i + dur), so the sample at a boundary belongs to the segment
 * that starts there. Before t = 0 a variant reads its first segment at its
 * start; from its total duration on, the last segment's left limit holds.
 * The sampler keeps no state: a chirp's phase and a PRBS register are
 * functions of the segment's own time, so a restart, a reload and any
 * call order give the same samples. Times resolve to `TIME_RESOLUTION`.
 */

import type {
  Program,
  Segment,
  SegmentKind,
  StructuredDecl,
  StructuredValue,
  ValueSet,
} from "./layered";

export const SEGMENT_KINDS: readonly SegmentKind[] = [
  "hold",
  "step",
  "ramp",
  "chirp",
  "prbs",
];

/** Each kind's fields after `kind` and `dur`, in canonical order. */
export const SEGMENT_FIELDS: Readonly<Record<SegmentKind, readonly string[]>> =
  {
    hold: ["level"],
    step: ["level"],
    ramp: ["from", "to"],
    chirp: ["amp", "f0", "f1", "phase"],
    prbs: ["seed", "period", "low", "high"],
  };

/** The register a PRBS segment runs: x^7 + x^6 + 1, 127 bits long. */
export const PRBS_BITS = 7;

/**
 * Seconds. A sample within this of a boundary belongs to the segment, or
 * the PRBS bit, that starts there, so a running sum of durations
 * (0.1 + 0.2 is 0.30000000000000004) cannot keep a millisecond grid point
 * in the segment before. A `dur` or a `period` is at least this.
 */
export const TIME_RESOLUTION = 1e-9;

export type StructuredParse<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(row: Row, keys: readonly string[], what: string) {
  for (const key of Object.keys(row)) {
    if (!keys.includes(key)) return `${what}: unknown key ${key}`;
  }
  for (const key of keys) {
    if (!Object.hasOwn(row, key)) return `${what}: missing ${key}`;
  }
  return null;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseSegment(raw: unknown, what: string): StructuredParse<Segment> {
  if (!isRow(raw)) return { ok: false, error: `${what} is not an object` };
  const kind = raw.kind;
  if (typeof kind !== "string" || !SEGMENT_KINDS.includes(kind as SegmentKind))
    return { ok: false, error: `${what}: unknown kind ${String(kind)}` };
  const fields = SEGMENT_FIELDS[kind as SegmentKind];
  const bad = exactKeys(raw, ["kind", "dur", ...fields], `${what} (${kind})`);
  if (bad) return { ok: false, error: bad };
  for (const key of ["dur", ...fields]) {
    if (!finite(raw[key]))
      return { ok: false, error: `${what}: ${key} is not a finite number` };
  }
  const dur = raw.dur as number;
  if (dur < TIME_RESOLUTION)
    return { ok: false, error: `${what}: dur must be at least 1 ns` };
  if (kind === "prbs") {
    const seed = raw.seed as number;
    if (!Number.isInteger(seed) || seed < 1 || seed >= 2 ** PRBS_BITS)
      return { ok: false, error: `${what}: seed must be an integer 1..127` };
    if ((raw.period as number) < TIME_RESOLUTION)
      return { ok: false, error: `${what}: period must be at least 1 ns` };
  }
  // Rebuilt in canonical key order: kind, dur, then the kind's fields.
  const segment: Row = { kind, dur };
  for (const key of fields) segment[key] = raw[key];
  return { ok: true, value: segment as Segment };
}

export function parseProgram(raw: unknown): StructuredParse<Program> {
  if (!isRow(raw) || raw.kind !== "program")
    return { ok: false, error: 'a program is { "kind": "program", … }' };
  const bad = exactKeys(raw, ["kind", "use", "variants"], "program");
  if (bad) return { ok: false, error: bad };
  if (!Array.isArray(raw.variants) || raw.variants.length === 0)
    return { ok: false, error: "program: variants must be a non-empty list" };
  const variants: Program["variants"] = [];
  const ids = new Set<string>();
  for (const [index, row] of raw.variants.entries()) {
    const what = `program variant ${index}`;
    if (!isRow(row)) return { ok: false, error: `${what} is not an object` };
    const keys = exactKeys(row, ["id", "segments"], what);
    if (keys) return { ok: false, error: keys };
    if (typeof row.id !== "string" || row.id.length === 0)
      return { ok: false, error: `${what}: id must be a non-empty string` };
    if (ids.has(row.id))
      return { ok: false, error: `program: duplicate variant ${row.id}` };
    ids.add(row.id);
    if (!Array.isArray(row.segments) || row.segments.length === 0)
      return {
        ok: false,
        error: `${row.id}: segments must be a non-empty list`,
      };
    const segments: Segment[] = [];
    for (const [at, segment] of row.segments.entries()) {
      const parsed = parseSegment(segment, `${row.id} segment ${at}`);
      if (!parsed.ok) return parsed;
      segments.push(parsed.value);
    }
    variants.push({ id: row.id, segments });
  }
  if (typeof raw.use !== "string" || !ids.has(raw.use))
    return {
      ok: false,
      error: `program: use ${String(raw.use)} is no variant`,
    };
  return { ok: true, value: { kind: "program", use: raw.use, variants } };
}

export function parseValueSet(raw: unknown): StructuredParse<ValueSet> {
  if (!isRow(raw) || raw.kind !== "values")
    return { ok: false, error: 'a value set is { "kind": "values", … }' };
  const bad = exactKeys(raw, ["kind", "use", "values"], "values");
  if (bad) return { ok: false, error: bad };
  if (!Array.isArray(raw.values) || raw.values.length === 0)
    return { ok: false, error: "values: values must be a non-empty list" };
  if (!raw.values.every(finite))
    return { ok: false, error: "values: every value must be a finite number" };
  const use = raw.use;
  if (!Number.isInteger(use) || (use as number) < 0)
    return { ok: false, error: "values: use must be an index" };
  if ((use as number) >= raw.values.length)
    return { ok: false, error: `values: use ${use} is past the list` };
  return {
    ok: true,
    value: { kind: "values", use: use as number, values: [...raw.values] },
  };
}

/** A structured value of either kind, by its `kind`. */
export function parseStructured(
  raw: unknown
): StructuredParse<StructuredValue> {
  if (isRow(raw) && raw.kind === "values") return parseValueSet(raw);
  return parseProgram(raw);
}

/** `raw` parsed as the kind `decl` declares. */
export function parseDeclared(
  decl: StructuredDecl,
  raw: unknown
): StructuredParse<StructuredValue> {
  return decl.kind === "values" ? parseValueSet(raw) : parseProgram(raw);
}

/** Whether `value` is a program or a value set (not a `$param`). */
export function isStructured(value: unknown): value is StructuredValue {
  return isRow(value) && (value.kind === "program" || value.kind === "values");
}

function variantOf(program: Program, id: string): Segment[] {
  const found = program.variants.find((row) => row.id === id);
  if (!found) throw new Error(`program has no variant ${id}`);
  return found.segments;
}

/** The sum of a variant's durations, in seconds. */
export function programDuration(program: Program, id = program.use): number {
  return variantOf(program, id).reduce((sum, row) => sum + row.dur, 0);
}

/**
 * The PRBS bit `n` from `seed`: x^7 + x^6 + 1, Fibonacci, bit 0 first.
 * The sequence repeats every 127 bits.
 */
function prbsBit(seed: number, n: number): number {
  let state = seed;
  let bit = 0;
  for (let k = 0; k <= n % (2 ** PRBS_BITS - 1); k++) {
    bit = ((state >> 6) ^ (state >> 5)) & 1;
    state = ((state << 1) | bit) & 0x7f;
  }
  return bit;
}

/** A segment's value at its own time `tau`, clamped to [0, dur]. */
function segmentAt(segment: Segment, at: number): number {
  const tau = Math.min(Math.max(at, 0), segment.dur);
  switch (segment.kind) {
    case "hold":
    case "step":
      return segment.level;
    case "ramp":
      return segment.from + (segment.to - segment.from) * (tau / segment.dur);
    case "chirp": {
      const sweep = (segment.f1 - segment.f0) / (2 * segment.dur);
      const phase =
        segment.phase + 2 * Math.PI * (segment.f0 * tau + sweep * tau * tau);
      return segment.amp * Math.sin(phase);
    }
    case "prbs": {
      // The bit that holds over [n period, (n + 1) period); at the end,
      // the last bit of the segment (its left limit).
      const last = Math.max(
        0,
        Math.ceil((segment.dur - TIME_RESOLUTION) / segment.period) - 1
      );
      const n = Math.min(
        Math.floor((tau + TIME_RESOLUTION) / segment.period),
        last
      );
      return prbsBit(segment.seed, n) ? segment.high : segment.low;
    }
  }
}

/** Variant `id` of `program` at `t` seconds from the run's start. */
export function sampleProgram(
  program: Program,
  t: number,
  id = program.use
): number {
  const segments = variantOf(program, id);
  const first = segments[0];
  if (!first) throw new Error(`variant ${id} has no segments`);
  if (t < 0) return segmentAt(first, 0);
  let start = 0;
  for (const segment of segments) {
    const end = start + segment.dur;
    if (t < end - TIME_RESOLUTION) return segmentAt(segment, t - start);
    start = end;
  }
  const last = segments[segments.length - 1] ?? first;
  return segmentAt(last, last.dur);
}

/**
 * The runs a capture makes of a bench: every value, and for each every
 * program variant, in list order (value-major). Each pair is its own run
 * from t = 0, never a change mid-run.
 */
export function crossRuns(
  values: ValueSet,
  program: Program
): { value: number; variant: string }[] {
  return values.values.flatMap((value) =>
    program.variants.map((row) => ({ value, variant: row.id }))
  );
}
