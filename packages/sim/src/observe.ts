/**
 * What one run is observed at, and what it reports about its own validity
 * (run 7 unit 3a). A comparison runs two sides and pairs their
 * observations (`compare.ts`); this file only describes and takes them.
 *
 * A descriptor names a quantity (`path.port.field`), a cadence, a phase and
 * a reference:
 *
 * - `frame`: t = 0 and the end of every 10 ms frame, today's readings.
 * - `step`: t = 0 and the end of every master step.
 * - `events`: a reader's conversions. The quantity is the reader's own
 *   port (`board.port.voltage`); the value is the held sample at the
 *   instant the conversion started, with the reference latched for it.
 *
 * The phase says which solve a value comes from. On `frame` and `step` a
 * voltage or a current is the master step's rail solve and an angle is its
 * body step; both are read at the end of that step. An event is read at
 * the conversion start. The phase follows from field and cadence, and a
 * descriptor that states another one is refused, so a stored descriptor
 * cannot claim a phase the run does not deliver.
 *
 * The reference says what a value is measured against:
 *
 * - `absolute`: the quantity's own SI unit.
 * - `ratio-to`: the quantity divided by another field of the same
 *   instance, in the same quantity, read at the same instant. At a
 *   conversion that is the reference the conversion latched, and only when
 *   it was read on that port: a conversion against another reference (an
 *   internal one) is excluded with the reason, as is a reference that is
 *   not finite and non-zero. On `frame` and `step` it is the other port's
 *   reading at the end of the same step.
 *
 * `with` names more quantities read at the same instant as each value, for
 * a condition that reads them (`within-ratings`). One with no reading is
 * kept as null; the condition says why it cannot judge.
 *
 * Observation keys pair two sides. A frame or step key is the master step
 * count, so both sides must run the same timestep. A conversion key is the
 * master step in which that board's CPU ran its first cycle and the CPU
 * cycle the conversion started on: two conversions match only at the same
 * instant, never by their order and never rounded to a step.
 */

import { RECORD_FRAME_MS, type RunReport } from "@sfab-bench/contract";
import { MAX_STEP_N, type Sim } from "./sim";

export type ObservedField = "voltage" | "current" | "angle";
export type Cadence = "frame" | "step" | "events";
/** The rail solve, the body step, or a reader's conversion start. */
export type Phase = "rail" | "body" | "conversion";
export type Reference =
  | { kind: "absolute" }
  /** `quantity` is `path.port.field` on the same instance path. */
  | { kind: "ratio-to"; quantity: string };

export type ObservationDescriptor = {
  /** `path.port.field`. A port name has no dot; an instance path may. */
  quantity: string;
  cadence: Cadence;
  phase: Phase;
  reference: Reference;
  /** Quantities read at the same instant, sorted. */
  with?: string[];
};

export type Observation = {
  /** Equal keys on two sides are the same instant of the same reading. */
  key: string;
  /** Simulated milliseconds. */
  ms: number;
  value: number;
  /** A conversion's latched reference: its mode, volts and port. */
  reference?: { mode: string; volts: number; port: string | null };
  /** The descriptor's `with` quantities at the same instant. */
  with?: Record<string, number | null>;
  /** Why the value cannot be compared. Such a value is never paired. */
  excluded?: string;
};

/** What a run says about itself: the items a comparison carries through. */
export type Validity = {
  envelope: {
    path: string;
    ref: string;
    port: string;
    quantity: string;
    range: string;
  }[];
  stale: { path: string; ref: string }[];
  unchecked: { path: string; ref: string; reason: string }[];
  degraded: { path: string; code: string; port: string }[];
};

export type ObservedRun = {
  /** By `descriptorId`, in time order. */
  series: Map<string, Observation[]>;
  validity: Validity;
};

/**
 * The code that takes and reduces an observation, by file relative to this
 * one, and by function where only part of a file does it. A host with file
 * access hashes it into the comparison identity, so a change to how a
 * value is read, stamped or reduced is never the same comparison:
 *
 * - this file, the pairing and metrics, and `portReading`;
 * - `advanceOne`, whose order of rail solve, body step and listener call
 *   is what a phase means;
 * - the conversion's stamp: the session's `noteConversion`, `stepBoard`
 *   (the CPU's first step) and `attachAnalog`, and the ADC hook that
 *   chooses the held sample, the latched reference and the cycle.
 *
 * The engines that compute a value are not listed: a change there moves
 * the numbers, and the remeasure catches that.
 */
export const OBSERVER_SOURCES: readonly {
  file: string;
  functions?: readonly string[];
}[] = [
  { file: "observe.ts" },
  { file: "compare.ts" },
  { file: "session/ports.ts" },
  { file: "sim.ts", functions: ["advanceOne"] },
  {
    file: "session/boards.ts",
    functions: ["noteConversion", "stepBoard", "attachAnalog"],
  },
  {
    file: "../../engine-mcu/src/board-adc.ts",
    functions: ["attachBoardAdc", "sourceOf", "referenceOf"],
  },
];

export function splitQuantity(quantity: string): {
  path: string;
  port: string;
  field: ObservedField;
} {
  const parts = quantity.split(".");
  const field = parts.pop();
  const port = parts.pop();
  if (
    !port ||
    parts.length === 0 ||
    (field !== "voltage" && field !== "current" && field !== "angle")
  ) {
    throw new Error(`${quantity}: not instance.port.field`);
  }
  return { path: parts.join("."), port, field };
}

/** The descriptor for `quantity` at `cadence`, with the phase it reads at. */
export function describe(
  quantity: string,
  cadence: Cadence,
  reference: Reference = { kind: "absolute" },
  read: readonly string[] = []
): ObservationDescriptor {
  const { field } = splitQuantity(quantity);
  if (cadence === "events" && field !== "voltage") {
    throw new Error(`${quantity}: a conversion observes a voltage`);
  }
  const phase: Phase =
    cadence === "events" ? "conversion" : field === "angle" ? "body" : "rail";
  return {
    quantity,
    cadence,
    phase,
    reference,
    ...(read.length ? { with: [...new Set(read)].sort() } : {}),
  };
}

/** Refuse a stored descriptor this code would not take the same way. */
export function checkDescriptor(row: ObservationDescriptor): void {
  const want = describe(row.quantity, row.cadence);
  if (row.phase !== want.phase) {
    throw new Error(
      `${row.quantity} ${row.cadence}: phase ${row.phase}, the run reads it at ${want.phase}`
    );
  }
  const reference = row.reference as { kind?: unknown; quantity?: unknown };
  if (reference?.kind === "ratio-to") {
    const own = splitQuantity(row.quantity);
    const other =
      typeof reference.quantity === "string"
        ? splitQuantity(reference.quantity)
        : null;
    if (
      !other ||
      other.path !== own.path ||
      other.field !== own.field ||
      other.port === own.port
    ) {
      throw new Error(
        `${row.quantity} ${row.cadence}: ratio-to ${String(reference.quantity)} is not another port's ${own.field} on ${own.path}`
      );
    }
  } else if (reference?.kind !== "absolute") {
    throw new Error(
      `${row.quantity} ${row.cadence}: reference ${JSON.stringify(row.reference)} is not supported`
    );
  }
  for (const quantity of row.with ?? []) splitQuantity(quantity);
}

export function descriptorId(row: ObservationDescriptor): string {
  const base = `${row.quantity} ${row.cadence}`;
  return row.reference.kind === "ratio-to"
    ? `${base} / ${row.reference.quantity}`
    : base;
}

/**
 * Advance a loaded `sim` by `ms` and take every descriptor's observations,
 * then its validity from the run report. A `frame` or `step` quantity with
 * no finite reading at a sample is an error: the descriptor names something
 * this run does not read.
 */
export async function observeRun(
  sim: Sim,
  descriptors: readonly ObservationDescriptor[],
  ms: number
): Promise<ObservedRun> {
  for (const row of descriptors) checkDescriptor(row);
  const series = new Map<string, Observation[]>();
  type Taken = {
    row: ObservationDescriptor;
    at: ReturnType<typeof splitQuantity>;
    ratio: { quantity: string; at: ReturnType<typeof splitQuantity> } | null;
    read: { quantity: string; at: ReturnType<typeof splitQuantity> }[];
    out: Observation[];
  };
  const timed: Taken[] = [];
  const events: Taken[] = [];
  for (const row of descriptors) {
    const id = descriptorId(row);
    if (series.has(id)) throw new Error(`${id}: observed twice`);
    const out: Observation[] = [];
    series.set(id, out);
    const taken: Taken = {
      row,
      at: splitQuantity(row.quantity),
      ratio:
        row.reference.kind === "ratio-to"
          ? {
              quantity: row.reference.quantity,
              at: splitQuantity(row.reference.quantity),
            }
          : null,
      read: (row.with ?? []).map((quantity) => ({
        quantity,
        at: splitQuantity(quantity),
      })),
      out,
    };
    if (row.cadence === "events") events.push(taken);
    else timed.push(taken);
  }
  const reading = (at: ReturnType<typeof splitQuantity>): number | null => {
    const value = sim.portReading(at.path, at.port)?.[at.field];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  const withOf = (taken: Taken) =>
    taken.read.length
      ? {
          with: Object.fromEntries(
            taken.read.map(({ quantity, at }) => [quantity, reading(at)])
          ),
        }
      : {};
  let missing: string | null = null;
  const read = (n: number, perMs: number) => {
    for (const taken of timed) {
      const { row, at, ratio, out } = taken;
      if (row.cadence === "frame" && n % (perMs * RECORD_FRAME_MS) !== 0) {
        continue;
      }
      const value = reading(at);
      if (value === null) {
        missing ??= `${row.quantity} has no reading at step ${n}`;
        continue;
      }
      const key = `step ${n}`;
      const time = n / perMs;
      if (!ratio) {
        out.push({ key, ms: time, value, ...withOf(taken) });
        continue;
      }
      const volts = reading(ratio.at);
      out.push({
        key,
        ms: time,
        ...(volts === null || volts === 0
          ? {
              value,
              excluded: `reference ${ratio.quantity} is not finite and non-zero`,
            }
          : { value: value / volts }),
        ...withOf(taken),
      });
    }
  };
  // t = 0 is step 0 at any timestep, and a frame boundary.
  read(0, 1);
  const stop = sim.observe({
    step: read,
    conversion(event) {
      for (const taken of events) {
        const { at, ratio, out } = taken;
        if (event.board !== at.path || event.mux !== at.port) continue;
        const reference = {
          mode: event.ref,
          volts: event.vRef,
          port: event.referencePort,
        };
        const base = {
          key: `conversion ${event.startStep}:${event.cycle}`,
          ms: event.ms,
          reference,
          ...withOf(taken),
        };
        if (!ratio) {
          out.push({ ...base, value: event.voltage });
          continue;
        }
        const excluded =
          event.referencePort !== ratio.at.port
            ? `reference ${event.ref} is not ${ratio.at.port}`
            : !Number.isFinite(event.vRef) || event.vRef === 0
              ? `reference ${event.ref} is not finite and non-zero`
              : null;
        out.push(
          excluded === null
            ? { ...base, value: event.voltage / event.vRef }
            : { ...base, value: event.voltage, excluded }
        );
      }
    },
  });
  try {
    for (let done = 0; done < ms && missing === null; ) {
      const n = Math.min(MAX_STEP_N, ms - done);
      await sim.step(n);
      done += n;
    }
  } finally {
    stop();
  }
  if (missing !== null) throw new Error(missing);
  return { series, validity: validityOf(sim.report()) };
}

/** The report's validity items, sorted, with no observed numbers in them. */
export function validityOf(report: RunReport | null): Validity {
  const rows = report?.snapshots ?? [];
  const envelope = (report?.warnings ?? [])
    .filter((row) => row.code === "envelope")
    .map((row) => ({
      path: row.path,
      ref:
        rows.find(
          (snap) =>
            snap.path === row.path && snap.envelope?.includes(row.message)
        )?.ref ?? "",
      port: row.port,
      quantity: row.quantity,
      range: row.right,
    }));
  return {
    envelope: sorted(envelope),
    stale: sorted(
      rows
        .filter((row) => row.stale)
        .map((row) => ({ path: row.path, ref: row.ref }))
    ),
    unchecked: sorted(
      rows.flatMap((row) =>
        row.unchecked === undefined
          ? []
          : [{ path: row.path, ref: row.ref, reason: row.unchecked }]
      )
    ),
    degraded: sorted(
      (report?.degraded ?? []).map((row) => ({
        path: row.path,
        code: row.code,
        port: row.port,
      }))
    ),
  };
}

function sorted<T>(rows: T[]): T[] {
  return rows
    .map((row) => [JSON.stringify(row), row] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, row]) => row);
}
