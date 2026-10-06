/**
 * Numeric traces (`sfab.trace@1`): named channels on one time base, each
 * compared with a tolerance, so a check that fails says which quantity
 * moved, when, and by how much.
 *
 * A numeric channel passes when every sample has
 * `|actual − ref| ≤ abs + rel·|ref| + span·(max(ref) − min(ref))`. A
 * discrete channel (a motion state, a flag, null), a NaN or an infinity, and
 * the text, events and notes compare exactly. A trace on another time base is
 * resampled onto the reference's: linear for numbers, the last sample for a
 * column that holds a null or a non-finite number, the last change for
 * discrete values.
 *
 * Channel names are the field paths of the frames they came from. A field
 * that is added is a new channel and does not fail a comparison. A field
 * that is renamed is a missing channel plus a new one with the same data,
 * and the report names it as a rename.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const TRACE_FORMAT = "sfab.trace@1";

export type Tolerance = { abs?: number; rel?: number; span?: number };

/**
 * Regression traces: a nanounit near zero, a part per billion of larger
 * values. The relative term covers the ten digits a trace is stored at. A
 * reordered float sum passes; at 5 V a 7 nV move fails.
 */
export const REGRESSION_TOL: Tolerance = { abs: 1e-9, rel: 1e-9 };

export type Discrete = string | boolean | number | null;

export type NumericChannel = {
  unit?: string;
  /** Overrides the trace's tolerance for this channel. */
  tol?: Tolerance;
  /** One value per time, or a single value held for the whole trace. */
  v: number | null | (number | null)[];
};

export type DiscreteChannel = {
  /** Change points: `[t, value]`, the first at the first time. */
  at: [number, Discrete][];
};

export type Channel = NumericChannel | DiscreteChannel;

export type Trace = {
  format: typeof TRACE_FORMAT;
  source?: string;
  tol: Tolerance;
  t: number[];
  channels: Record<string, Channel>;
  /** Compared exactly, in order. */
  events?: unknown[];
  /** Compared exactly, by key: serial text per board. */
  text?: Record<string, string>;
  /** Compared exactly: diagnostics and warnings, one line each. */
  notes?: string[];
  /**
   * Named one-off samples, such as the state at a checkpoint or at the end,
   * by leaf path. Each value compares like a channel's, at the last time.
   */
  samples?: Record<string, Record<string, Discrete>>;
};

const isDiscrete = (channel: Channel): channel is DiscreteChannel =>
  "at" in channel;

// ---------------------------------------------------------------- series

/** Linear interpolation of `(time, values)` at `t`, held at both ends. */
export function interp(
  time: readonly number[],
  values: readonly number[],
  t: number
): number {
  const n = time.length;
  const t0 = time[0]!;
  const tN = time[n - 1]!;
  if (t <= t0) return values[0]!;
  if (t >= tN) return values[n - 1]!;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (time[mid]! <= t) lo = mid;
    else hi = mid;
  }
  const a = time[lo]!;
  const b = time[hi]!;
  const u = b === a ? 0 : (t - a) / (b - a);
  return values[lo]! * (1 - u) + values[hi]! * u;
}

/** `(time, values)` resampled at each of `at`. */
export function resample(
  time: readonly number[],
  values: readonly number[],
  at: readonly number[]
): number[] {
  return at.map((t) => interp(time, values, t));
}

/** Max |ours − ref| over the span of `ref`, for samples on one time base. */
export function spanError(
  ours: readonly number[],
  ref: readonly number[]
): number {
  let lo = Infinity;
  let hi = -Infinity;
  let worst = 0;
  for (let i = 0; i < ref.length; i++) {
    const y = ref[i]!;
    if (y < lo) lo = y;
    if (y > hi) hi = y;
    worst = Math.max(worst, Math.abs(ours[i]! - y));
  }
  return worst / Math.max(hi - lo, 1e-12);
}

// ---------------------------------------------------------------- build

const UNITS: Record<string, string> = {
  voltage: "V",
  minVoltage: "V",
  current: "A",
  maxCurrent: "A",
  pulseUs: "µs",
  commandDeg: "deg",
  torqueNm: "N·m",
  distanceM: "m",
  echoS: "s",
};

function unitOf(path: string): string | undefined {
  const parts = path.split(".");
  if (parts[0] === "limitDeg") return "deg";
  if (parts[0] === "poses") {
    return parts[parts.length - 2] === "p" ? "m" : undefined;
  }
  return UNITS[parts[parts.length - 1]!];
}

function flatten(
  value: unknown,
  path: string,
  out: Map<string, Discrete>
): void {
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      flatten(item, `${path}.${i}`, out);
    }
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      flatten(item, path ? `${path}.${key}` : key, out);
    }
  } else if (value !== undefined) {
    out.set(path, value as Discrete);
  }
}

/** Every leaf of `value` by its dotted path. `undefined` is left out. */
export function leaves(value: unknown): Map<string, Discrete> {
  const out = new Map<string, Discrete>();
  flatten(value, "", out);
  return out;
}

/**
 * Channels from frames that each carry `t`. A leaf that is a number or null
 * in every frame is numeric; anything else is discrete. A leaf missing from
 * a frame reads null there.
 */
export function channelsOf(frames: readonly ({ t: number } & object)[]): {
  t: number[];
  channels: Record<string, Channel>;
} {
  const t = frames.map((frame) => frame.t);
  const columns = new Map<string, (Discrete | undefined)[]>();
  frames.forEach((frame, i) => {
    const { t: _, ...rest } = frame as { t: number } & Record<string, unknown>;
    for (const [path, value] of leaves(rest)) {
      let column = columns.get(path);
      if (!column) {
        column = new Array(frames.length).fill(undefined);
        columns.set(path, column);
      }
      column[i] = value;
    }
  });
  const channels: Record<string, Channel> = {};
  for (const path of [...columns.keys()].sort()) {
    const column = columns.get(path)!.map((value) => value ?? null);
    const numeric = column.every(
      (value) => typeof value === "number" || value === null
    );
    if (numeric) {
      const first = column[0] ?? null;
      const held = column.every((value) => value === first);
      const unit = unitOf(path);
      channels[path] = {
        ...(unit ? { unit } : {}),
        v: held ? (first as number | null) : (column as (number | null)[]),
      };
    } else {
      const at: [number, Discrete][] = [];
      column.forEach((value, i) => {
        if (i === 0 || value !== column[i - 1]) at.push([t[i]!, value]);
      });
      channels[path] = { at };
    }
  }
  return { t, channels };
}

// ---------------------------------------------------------------- compare

export type ChannelMiss = {
  channel: string;
  unit?: string;
  t: number;
  ref: Discrete;
  actual: Discrete;
  /** Allowed |Δ| at the worst sample; absent for exact values. */
  allowed?: number;
  /** Samples outside the tolerance. */
  count: number;
};

export type TraceReport = {
  ok: boolean;
  misses: ChannelMiss[];
  missing: string[];
  added: string[];
  renamed: [from: string, to: string][];
  /** Text, events and notes that differ: one line each. */
  exact: string[];
};

function numericColumn(channel: NumericChannel, n: number): (number | null)[] {
  return Array.isArray(channel.v)
    ? channel.v
    : new Array<number | null>(n).fill(channel.v);
}

function discreteAt(channel: DiscreteChannel, t: number): Discrete {
  let value: Discrete = channel.at[0]?.[1] ?? null;
  for (const [at, next] of channel.at) {
    if (at > t + 1e-12) break;
    value = next;
  }
  return value;
}

/** `channel` sampled on `at`, from a trace on `time`. */
function columnOn(
  channel: Channel,
  time: readonly number[],
  at: readonly number[]
): Discrete[] {
  if (isDiscrete(channel)) return at.map((t) => discreteAt(channel, t));
  const column = numericColumn(channel, time.length);
  const same =
    time.length === at.length && time.every((value, i) => value === at[i]);
  if (same) return column;
  if (column.some((value) => value === null || !Number.isFinite(value))) {
    // Nulls, NaN and infinities do not interpolate: take the nearest earlier
    // sample.
    return at.map((t) => {
      let index = 0;
      while (index + 1 < time.length && time[index + 1]! <= t + 1e-12) index++;
      return column[index] ?? null;
    });
  }
  return resample(time, column as number[], at);
}

/** Null and non-finite numbers match only themselves. */
function sameExact(a: Discrete, b: Discrete): boolean {
  return a === b || (Number.isNaN(a) && Number.isNaN(b));
}

function allowedAt(tol: Tolerance, ref: number, span: number): number {
  return (
    (tol.abs ?? 0) + (tol.rel ?? 0) * Math.abs(ref) + (tol.span ?? 0) * span
  );
}

function compareColumn(
  name: string,
  ref: Channel,
  ours: Discrete[],
  refValues: Discrete[],
  t: readonly number[],
  tol: Tolerance
): ChannelMiss | null {
  if (isDiscrete(ref)) {
    let first = -1;
    let count = 0;
    for (let i = 0; i < t.length; i++) {
      if (!sameExact(ours[i] ?? null, refValues[i] ?? null)) {
        count++;
        if (first < 0) first = i;
      }
    }
    if (first < 0) return null;
    return {
      channel: name,
      t: t[first]!,
      ref: refValues[first] ?? null,
      actual: ours[first] ?? null,
      count,
    };
  }
  const numbers = refValues.filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value)
  );
  const span =
    numbers.length > 0 ? Math.max(...numbers) - Math.min(...numbers) : 0;
  let worst: ChannelMiss | null = null;
  let worstOver = 0;
  let count = 0;
  for (let i = 0; i < t.length; i++) {
    const want = refValues[i] ?? null;
    const got = ours[i] ?? null;
    if (
      typeof want !== "number" ||
      typeof got !== "number" ||
      !Number.isFinite(want) ||
      !Number.isFinite(got)
    ) {
      if (sameExact(want, got)) continue;
      count++;
      // A value that appears, disappears or stops being finite outranks any
      // numeric miss.
      if (worstOver !== Infinity) {
        worst = {
          channel: name,
          unit: (ref as NumericChannel).unit,
          t: t[i]!,
          ref: want,
          actual: got,
          count: 0,
        };
        worstOver = Infinity;
      }
      continue;
    }
    const allowed = allowedAt(tol, want, span);
    const delta = Math.abs(got - want);
    if (delta <= allowed) continue;
    count++;
    const over = delta - allowed;
    if (over > worstOver) {
      worstOver = over;
      worst = {
        channel: name,
        unit: (ref as NumericChannel).unit,
        t: t[i]!,
        ref: want,
        actual: got,
        allowed,
        count: 0,
      };
    }
  }
  if (!worst) return null;
  return { ...worst, count };
}

/** JSON that keeps NaN and the infinities apart from null and each other. */
function exactJson(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "number" && !Number.isFinite(item)
      ? { nonFinite: String(item) }
      : item
  );
}

function sameData(a: Channel, b: Channel, n: number): boolean {
  if (isDiscrete(a) || isDiscrete(b)) {
    return (
      isDiscrete(a) && isDiscrete(b) && exactJson(a.at) === exactJson(b.at)
    );
  }
  return exactJson(numericColumn(a, n)) === exactJson(numericColumn(b, n));
}

function firstDiff(label: string, ref: unknown[], ours: unknown[]): string[] {
  const n = Math.max(ref.length, ours.length);
  for (let i = 0; i < n; i++) {
    const a = exactJson(ref[i]);
    const b = exactJson(ours[i]);
    if (a !== b) {
      return [
        `${label} ${i}: ${b ?? "(none)"}, want ${a ?? "(none)"} (${ours.length} vs ${ref.length})`,
      ];
    }
  }
  return [];
}

function textDiff(key: string, ref: string, ours: string): string[] {
  if (ref === ours) return [];
  let i = 0;
  while (i < ref.length && i < ours.length && ref[i] === ours[i]) i++;
  const show = (text: string) => JSON.stringify(text.slice(i, i + 24));
  return [
    `text ${key} at char ${i}: ${show(ours)}, want ${show(ref)} (${ours.length} vs ${ref.length} chars)`,
  ];
}

/** Compare `actual` with `ref`, on `ref`'s time base and tolerances. */
export function compareTraces(actual: Trace, ref: Trace): TraceReport {
  const misses: ChannelMiss[] = [];
  const missing: string[] = [];
  for (const [name, channel] of Object.entries(ref.channels)) {
    const ours = actual.channels[name];
    if (!ours) {
      missing.push(name);
      continue;
    }
    const tol = isDiscrete(channel) ? {} : (channel.tol ?? ref.tol);
    const miss = compareColumn(
      name,
      channel,
      columnOn(ours, actual.t, ref.t),
      columnOn(channel, ref.t, ref.t),
      ref.t,
      tol
    );
    if (miss) misses.push(miss);
  }
  const added = Object.keys(actual.channels).filter(
    (name) => !(name in ref.channels)
  );
  const renamed: [string, string][] = [];
  const sameBase =
    actual.t.length === ref.t.length &&
    actual.t.every((value, i) => value === ref.t[i]);
  if (sameBase) {
    const unclaimed = [...added];
    for (const from of missing) {
      const index = unclaimed.findIndex((name) =>
        sameData(ref.channels[from]!, actual.channels[name]!, ref.t.length)
      );
      if (index >= 0) renamed.push([from, unclaimed.splice(index, 1)[0]!]);
    }
  }
  for (const [label, sample] of Object.entries(ref.samples ?? {})) {
    const ours = actual.samples?.[label];
    if (!ours) {
      missing.push(`sample ${label}`);
      continue;
    }
    for (const [name, want] of Object.entries(sample)) {
      if (!(name in ours)) {
        missing.push(`${label} ${name}`);
        continue;
      }
      const shape: Channel =
        typeof want === "number" || want === null
          ? { v: want }
          : { at: [[0, want]] };
      const miss = compareColumn(
        `${label} ${name}`,
        shape,
        [ours[name]!],
        [want],
        [ref.t[ref.t.length - 1] ?? 0],
        ref.tol
      );
      if (miss) misses.push(miss);
    }
    for (const name of Object.keys(ours)) {
      if (!(name in sample)) added.push(`${label} ${name}`);
    }
  }
  for (const label of Object.keys(actual.samples ?? {})) {
    if (!(label in (ref.samples ?? {}))) added.push(`sample ${label}`);
  }
  const exact: string[] = [];
  for (const [key, want] of Object.entries(ref.text ?? {})) {
    exact.push(...textDiff(key, want, actual.text?.[key] ?? ""));
  }
  for (const key of Object.keys(actual.text ?? {})) {
    if (!(key in (ref.text ?? {})))
      exact.push(`text ${key}: not in the reference`);
  }
  exact.push(...firstDiff("event", ref.events ?? [], actual.events ?? []));
  exact.push(...firstDiff("note", ref.notes ?? [], actual.notes ?? []));
  return {
    ok: misses.length === 0 && missing.length === 0 && exact.length === 0,
    misses,
    missing,
    added,
    renamed,
    exact,
  };
}

const show = (value: Discrete, unit?: string) =>
  typeof value === "number"
    ? `${Number(value.toPrecision(10))}${unit ? ` ${unit}` : ""}`
    : JSON.stringify(value);

/** The report as lines a person reads: one per channel that moved. */
export function formatReport(report: TraceReport): string[] {
  const lines: string[] = [];
  const renamedFrom = new Set(report.renamed.map(([from]) => from));
  const renamedTo = new Set(report.renamed.map(([, to]) => to));
  for (const [from, to] of report.renamed) {
    lines.push(`renamed? ${from} -> ${to} (same data)`);
  }
  for (const name of report.missing) {
    if (!renamedFrom.has(name)) lines.push(`missing channel ${name}`);
  }
  for (const miss of report.misses) {
    const delta =
      Number.isFinite(miss.actual) && Number.isFinite(miss.ref)
        ? `, Δ ${Math.abs((miss.actual as number) - (miss.ref as number)).toExponential(2)}${
            miss.allowed !== undefined
              ? ` > ${miss.allowed.toExponential(2)}`
              : ""
          }`
        : "";
    lines.push(
      `${miss.channel} at ${Number(miss.t.toPrecision(6))} s: ${show(miss.actual, miss.unit)}, want ${show(miss.ref, miss.unit)}${delta} (${miss.count} samples)`
    );
  }
  lines.push(...report.exact);
  const fresh = report.added.filter((name) => !renamedTo.has(name));
  if (fresh.length > 0) {
    lines.push(
      `new channels, not compared: ${fresh.slice(0, 6).join(", ")}${fresh.length > 6 ? `, +${fresh.length - 6}` : ""}`
    );
  }
  return lines;
}

// ---------------------------------------------------------------- files

/** Ten significant digits: well inside the regression tolerance. */
function round10(value: number): number {
  return Number(value.toPrecision(10));
}

/** JSON has no NaN or infinity, so a stored trace cannot hold one. */
function assertFinite(value: unknown, path: string): void {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error(`${path} is ${value}: a stored trace holds finite numbers`);
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assertFinite(item, path ? `${path}.${key}` : key);
    }
  }
}

/**
 * The trace as stored: the numbers compared with a tolerance (numeric
 * channels and numeric checkpoint leaves) at ten digits, and everything
 * compared exactly as it is.
 */
function stored(trace: Trace): Trace {
  assertFinite(trace, "");
  const channels: Record<string, Channel> = {};
  for (const [name, channel] of Object.entries(trace.channels)) {
    channels[name] = isDiscrete(channel)
      ? channel
      : {
          ...channel,
          v: Array.isArray(channel.v)
            ? channel.v.map((value) => (value === null ? null : round10(value)))
            : channel.v === null
              ? null
              : round10(channel.v),
        };
  }
  const samples = trace.samples
    ? Object.fromEntries(
        Object.entries(trace.samples).map(([label, sample]) => [
          label,
          Object.fromEntries(
            Object.entries(sample).map(([key, value]) => [
              key,
              typeof value === "number" ? round10(value) : value,
            ])
          ),
        ])
      )
    : undefined;
  return { ...trace, channels, samples };
}

/**
 * The trace as JSON with one channel, event or note per line, so a diff of
 * a re-recorded trace shows which channels moved.
 */
export function traceText(trace: Trace): string {
  const kept = stored(trace);
  const line = (value: unknown) => JSON.stringify(value);
  const block = (entries: [string, unknown][]) =>
    entries.length === 0
      ? "{}"
      : `{\n${entries.map(([key, value]) => `    ${line(key)}: ${line(value)}`).join(",\n")}\n  }`;
  const list = (items: unknown[]) =>
    items.length === 0
      ? "[]"
      : `[\n${items.map((item) => `    ${line(item)}`).join(",\n")}\n  ]`;
  const parts: string[] = [
    `  "format": ${line(kept.format)}`,
    ...(kept.source !== undefined ? [`  "source": ${line(kept.source)}`] : []),
    `  "tol": ${line(kept.tol)}`,
    `  "t": ${line(kept.t)}`,
    `  "channels": ${block(Object.entries(kept.channels))}`,
  ];
  if (kept.events) parts.push(`  "events": ${list(kept.events)}`);
  if (kept.text) parts.push(`  "text": ${block(Object.entries(kept.text))}`);
  if (kept.notes) parts.push(`  "notes": ${list(kept.notes)}`);
  if (kept.samples) {
    const labels = Object.entries(kept.samples).map(
      ([label, sample]) =>
        `    ${line(label)}: {\n${Object.entries(sample)
          .map(([key, value]) => `      ${line(key)}: ${line(value)}`)
          .join(",\n")}\n    }`
    );
    parts.push(
      labels.length === 0
        ? `  "samples": {}`
        : `  "samples": {\n${labels.join(",\n")}\n  }`
    );
  }
  return `{\n${parts.join(",\n")}\n}\n`;
}

/** The trace as it reads back from its file: stored precision applied. */
export function storedTrace(trace: Trace): Trace {
  return JSON.parse(traceText(trace)) as Trace;
}

export function writeTrace(path: string, trace: Trace): void {
  writeFileSync(path, traceText(trace));
}

export function readTrace(path: string): Trace {
  const trace = JSON.parse(readFileSync(path, "utf8")) as Trace;
  if (trace.format !== TRACE_FORMAT) {
    throw new Error(
      `${path}: format ${String(trace.format)}, want ${TRACE_FORMAT}`
    );
  }
  return trace;
}

/**
 * Compare traces with the files in `dir`, one `<name>.trace.json` each, or
 * rewrite the directory with `write`. Returns one line per problem.
 */
export function checkTraceDir(
  dir: string,
  traces: ReadonlyMap<string, Trace>,
  write: boolean
): string[] {
  const fileOf = (name: string) => join(dir, `${name}.trace.json`);
  const onDisk = new Set(
    existsSync(dir)
      ? readdirSync(dir, { recursive: true })
          .map(String)
          .filter((file) => file.endsWith(".trace.json"))
          .map((file) => file.slice(0, -".trace.json".length))
      : []
  );
  if (write) {
    for (const name of onDisk) {
      if (!traces.has(name)) rmSync(fileOf(name));
    }
    for (const [name, trace] of traces) {
      mkdirSync(dirname(fileOf(name)), { recursive: true });
      writeTrace(fileOf(name), trace);
    }
    return [];
  }
  const problems: string[] = [];
  for (const [name, trace] of traces) {
    if (!onDisk.has(name)) {
      problems.push(`${name}: no reference trace (run with --write)`);
      continue;
    }
    const report = compareTraces(trace, readTrace(fileOf(name)));
    const lines = formatReport(report);
    if (!report.ok) {
      problems.push(`${name}:`, ...lines.map((line) => `  ${line}`));
    }
  }
  for (const name of onDisk) {
    if (!traces.has(name)) problems.push(`${name}: reference trace not run`);
  }
  return problems;
}
