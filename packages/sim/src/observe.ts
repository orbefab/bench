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
 * Only `absolute` references are taken in this unit: the value in the
 * quantity's own SI unit. A ratio needs a resolution to say what it is a
 * ratio to (unit 3b).
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
export type Reference = { kind: "absolute" };

export type ObservationDescriptor = {
  /** `path.port.field`. A port name has no dot; an instance path may. */
  quantity: string;
  cadence: Cadence;
  phase: Phase;
  reference: Reference;
};

export type Observation = {
  /** Equal keys on two sides are the same instant of the same reading. */
  key: string;
  /** Simulated milliseconds. */
  ms: number;
  value: number;
  /** A conversion's latched reference: its mode and volts. */
  reference?: { mode: string; volts: number };
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
  cadence: Cadence
): ObservationDescriptor {
  const { field } = splitQuantity(quantity);
  if (cadence === "events" && field !== "voltage") {
    throw new Error(`${quantity}: a conversion observes a voltage`);
  }
  const phase: Phase =
    cadence === "events" ? "conversion" : field === "angle" ? "body" : "rail";
  return { quantity, cadence, phase, reference: { kind: "absolute" } };
}

/** Refuse a stored descriptor this code would not take the same way. */
export function checkDescriptor(row: ObservationDescriptor): void {
  const want = describe(row.quantity, row.cadence);
  if (row.phase !== want.phase) {
    throw new Error(
      `${row.quantity} ${row.cadence}: phase ${row.phase}, the run reads it at ${want.phase}`
    );
  }
  if (row.reference?.kind !== "absolute") {
    throw new Error(
      `${row.quantity} ${row.cadence}: reference ${JSON.stringify(row.reference)} is not supported`
    );
  }
}

export function descriptorId(row: ObservationDescriptor): string {
  return `${row.quantity} ${row.cadence}`;
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
  const timed: {
    row: ObservationDescriptor;
    at: ReturnType<typeof splitQuantity>;
    out: Observation[];
  }[] = [];
  const events: { path: string; port: string; out: Observation[] }[] = [];
  for (const row of descriptors) {
    const id = descriptorId(row);
    if (series.has(id)) throw new Error(`${id}: observed twice`);
    const out: Observation[] = [];
    series.set(id, out);
    const at = splitQuantity(row.quantity);
    if (row.cadence === "events") {
      events.push({ path: at.path, port: at.port, out });
    } else timed.push({ row, at, out });
  }
  let missing: string | null = null;
  const read = (n: number, perMs: number) => {
    for (const { row, at, out } of timed) {
      if (row.cadence === "frame" && n % (perMs * RECORD_FRAME_MS) !== 0) {
        continue;
      }
      const value = sim.portReading(at.path, at.port)?.[at.field];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        missing ??= `${row.quantity} has no reading at step ${n}`;
        continue;
      }
      out.push({ key: `step ${n}`, ms: n / perMs, value });
    }
  };
  // t = 0 is step 0 at any timestep, and a frame boundary.
  read(0, 1);
  const stop = sim.observe({
    step: read,
    conversion(event) {
      for (const { path, port, out } of events) {
        if (event.board !== path || event.mux !== port) continue;
        out.push({
          key: `conversion ${event.startStep}:${event.cycle}`,
          ms: event.ms,
          value: event.voltage,
          reference: { mode: event.ref, volts: event.vRef },
        });
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
