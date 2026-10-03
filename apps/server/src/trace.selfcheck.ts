/**
 * The trace comparer on hand-made frames: what passes, what fails, and
 * what the report says.
 */

import { ok as expect } from "node:assert/strict";

import {
  channelsOf,
  compareTraces,
  formatReport,
  REGRESSION_TOL,
  spanError,
  storedTrace,
  TRACE_FORMAT,
  type Trace,
} from "./trace";

type Frame = {
  t: number;
  supplies: { usb: { voltage: number } };
  parts: { servo: { state: string; pulseUs: number | null } };
  boards: { uno: { pins: number[] } };
};

function frames(n: number, dt: number, edit?: (f: Frame, i: number) => void) {
  const out: Frame[] = [];
  for (let i = 0; i < n; i++) {
    const t = Number((i * dt).toFixed(9));
    const f: Frame = {
      t,
      supplies: { usb: { voltage: 5 - 0.1 * t } },
      parts: {
        servo: {
          state: t < 0.5 ? "idle" : "moving",
          pulseUs: t < 0.2 ? null : 1500,
        },
      },
      boards: { uno: { pins: [32, 0] } },
    };
    edit?.(f, i);
    out.push(f);
  }
  return out;
}

function traceOf(list: Frame[], extra: Partial<Trace> = {}): Trace {
  return {
    format: TRACE_FORMAT,
    tol: REGRESSION_TOL,
    ...channelsOf(list),
    ...extra,
  };
}

const ref = traceOf(frames(11, 0.1), {
  text: { uno: "boot\nready\n" },
  events: [{ t: 0.3, kind: "reset", board: "uno" }],
});

// Channel shapes: a ramp is an array, a constant is one value, a state is
// change points, and a null that turns into a number stays numeric.
{
  const volts = ref.channels["supplies.usb.voltage"];
  expect(
    volts && "v" in volts && Array.isArray(volts.v),
    "voltage is a column"
  );
  expect(volts && "unit" in volts && volts.unit === "V", "voltage is in V");
  const pin = ref.channels["boards.uno.pins.0"];
  expect(pin && "v" in pin && pin.v === 32, "a held pin word is one value");
  const state = ref.channels["parts.servo.state"];
  expect(
    state &&
      "at" in state &&
      JSON.stringify(state.at) ===
        JSON.stringify([
          [0, "idle"],
          [0.5, "moving"],
        ]),
    `state change points ${JSON.stringify(state)}`
  );
  const pulse = ref.channels["parts.servo.pulseUs"];
  expect(pulse && "v" in pulse && Array.isArray(pulse.v), "pulse is numeric");
  console.log(
    `trace: ${Object.keys(ref.channels).length} channels from 11 frames`
  );
}

// Same run: passes. Stored at ten digits: still passes.
{
  const same = compareTraces(ref, ref);
  expect(same.ok && formatReport(same).length === 0, "a trace matches itself");
  const kept = compareTraces(storedTrace(ref), ref);
  expect(kept.ok, formatReport(kept).join("\n"));
}

// A sample outside the tolerance names the channel, the time and Δ.
{
  const moved = traceOf(
    frames(11, 0.1, (f, i) => {
      if (i === 7) f.supplies.usb.voltage += 1e-6;
    }),
    { text: ref.text, events: ref.events }
  );
  const report = compareTraces(moved, ref);
  const lines = formatReport(report);
  expect(!report.ok, "a 1 µV move fails a regression trace");
  expect(
    lines.length === 1 &&
      lines[0]!.startsWith("supplies.usb.voltage at 0.7 s:") &&
      lines[0]!.includes("Δ 1.00e-6") &&
      lines[0]!.includes("(1 samples)"),
    lines.join("\n")
  );
  const tiny = traceOf(
    frames(11, 0.1, (f) => {
      f.supplies.usb.voltage += 1e-12;
    }),
    { text: ref.text, events: ref.events }
  );
  expect(compareTraces(tiny, ref).ok, "a reordered sum passes");
  console.log(`trace: ${lines[0]}`);
}

// A discrete change, a null that became a number, text and events.
{
  const changed = traceOf(
    frames(11, 0.1, (f, i) => {
      if (i === 5) f.parts.servo.state = "stall";
      if (i === 1) f.parts.servo.pulseUs = 1500;
    }),
    {
      text: { uno: "boot\nreaDy\n" },
      events: [{ t: 0.4, kind: "reset", board: "uno" }],
    }
  );
  const lines = formatReport(compareTraces(changed, ref));
  const has = (start: string) => lines.some((line) => line.startsWith(start));
  expect(
    has('parts.servo.state at 0.5 s: "stall", want "moving"'),
    lines.join("\n")
  );
  expect(
    has("parts.servo.pulseUs at 0.1 s: 1500 µs, want null"),
    lines.join("\n")
  );
  expect(has('text uno at char 8: "Dy\\n", want "dy\\n"'), lines.join("\n"));
  expect(has("event 0:"), lines.join("\n"));
}

// A renamed field is a missing channel plus a new one with the same data.
// A new field alone does not fail.
{
  const renamed = channelsOf(frames(11, 0.1));
  renamed.channels["supplies.usb.volts"] =
    renamed.channels["supplies.usb.voltage"]!;
  delete renamed.channels["supplies.usb.voltage"];
  const report = compareTraces({ ...ref, channels: renamed.channels }, ref);
  const lines = formatReport(report);
  expect(!report.ok, "a rename fails");
  expect(
    lines[0] ===
      "renamed? supplies.usb.voltage -> supplies.usb.volts (same data)",
    lines.join("\n")
  );
  const grown = channelsOf(
    frames(11, 0.1).map((f) => ({ ...f, extra: { temp: 25 } }))
  );
  const more = compareTraces({ ...ref, channels: grown.channels }, ref);
  expect(more.ok, formatReport(more).join("\n"));
  expect(
    formatReport(more)[0] === "new channels, not compared: extra.temp",
    formatReport(more).join("\n")
  );
  console.log(`trace: ${lines[0]}`);
}

// Another time base is resampled onto the reference's, and a span
// tolerance is a fraction of the reference's range.
{
  const fine = traceOf(frames(21, 0.05), {
    text: ref.text,
    events: ref.events,
  });
  const report = compareTraces(fine, ref);
  expect(report.ok, formatReport(report).join("\n"));
  const loose: Trace = {
    ...ref,
    tol: { span: 0.005 },
    text: undefined,
    events: undefined,
  };
  const off = traceOf(
    frames(11, 0.1, (f) => {
      f.supplies.usb.voltage += 0.0004; // 0.4% of the 0.1 V span
    })
  );
  const within = compareTraces(off, loose);
  expect(
    !within.misses.some((miss) => miss.channel === "supplies.usb.voltage"),
    formatReport(within).join("\n")
  );
  const ours = [0, 1, 2.01, 3];
  const want = [0, 1, 2, 3];
  expect(Math.abs(spanError(ours, want) - 0.01 / 3) < 1e-15, "span error");
  console.log(
    "trace: a finer time base resamples; 0.4% of span passes a 0.5% span tolerance"
  );
}

// A named sample compares each leaf. A missing label is a missing channel.
{
  const withEnd: Trace = {
    ...ref,
    samples: { end: { "boards.uno.voltage": 4.9 } },
  };
  const moved: Trace = {
    ...ref,
    samples: { end: { "boards.uno.voltage": 4.8 } },
  };
  const lines = formatReport(compareTraces(moved, withEnd));
  expect(
    lines.length === 1 &&
      lines[0]!.startsWith("end boards.uno.voltage at 1 s: 4.8, want 4.9"),
    lines.join("\n")
  );
  const gone = formatReport(compareTraces(ref, withEnd));
  expect(gone[0] === "missing channel sample end", gone.join("\n"));
  console.log(`trace: ${lines[0]}`);
}
