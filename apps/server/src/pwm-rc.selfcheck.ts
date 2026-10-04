/**
 * PWM into an RC, live against the analytic answer. D9 drives
 * `analogWrite(9, 128)` (Timer1 phase-correct, prescale 64: a 2.04 ms
 * period, high 128 / 255 of it) through 10 kΩ into 1 µF; D2 reads the
 * capacitor. D2's track is the solved node of a stamped pin: each 10 ms
 * frame's time-weighted mean, lowest and highest step.
 *
 * The analytic answer is the periodic steady state of that RC, from the
 * chip part's `roh` / `rol` / `rLeak` and the solved board node. One Nano
 * runs from a bench supply on its 5V pin; a copy runs from USB, whose
 * SS14 lowers its node, and is evaluated at that node.
 */

import { ok as expect } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  RecordingRead,
  TimelineTrack,
  WorldState,
} from "@sfab-bench/contract";
import { loadWorldV2 } from "@sfab-bench/parts";
import { closeRootWatches } from "./projects";
import { attachWorld, readRecording, stopWorld } from "./world/host";
import { nodeStore } from "./world/node-store";
import { catalogRoot } from "./world/plan";

const catalog = catalogRoot();
const dir = fileURLToPath(new URL("../fixtures/pwm-rc/", import.meta.url));
const world = "pwm-rc.world.json";

{
  const loaded = loadWorldV2(`${dir}${world}`, {
    store: nodeStore,
    catalogDir: catalog,
    assetRoot: dir,
  });
  const errors = loaded.diagnostics.filter((d) => d.severity === "error");
  expect(errors.length === 0, errors.map((d) => d.message).join("; "));
}

// 250 periods of 2.04 ms are 51 frames of 10 ms, so the window holds
// whole periods. It starts after 10 τ.
const FROM_MS = 100;
const TO_MS = 610;
const PROBES = ["port:nano.D2", "port:nanoUsb.D2", "port:nano.D9"];

async function runWorld(): Promise<{
  read: RecordingRead;
  tracks: TimelineTrack[];
}> {
  const seen: { state: WorldState | null; failed: string | null } = {
    state: null,
    failed: null,
  };
  const attached = await attachWorld(dir, world, {
    sender: { kind: "loopback", label: "Mac" },
    onEvent(event) {
      if (event.type === "error") {
        seen.failed =
          event.message ?? event.errors.map((item) => item.message).join("; ");
      }
      if (event.type === "state") seen.state = event.state;
    },
  });
  if ("error" in attached) throw new Error(attached.error);
  try {
    attached.step(TO_MS);
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (seen.failed) throw new Error(seen.failed);
      if ((seen.state?.simTime ?? -1) >= TO_MS / 1000 - 1e-3) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const read = await readRecording(dir, world, {
      from: 0,
      to: TO_MS / 1000,
    });
    if ("error" in read) throw new Error(read.error);
    const probed = await attached.timeline({
      from: 0,
      to: TO_MS / 1000,
      maxPoints: 1000,
      tracks: PROBES,
    });
    if ("error" in probed) throw new Error(probed.error);
    return { read, tracks: probed.tracks };
  } finally {
    attached.detach();
    await stopWorld(dir, world);
    closeRootWatches();
  }
}

/** Two legs in series to a node with a leak to ground: target and τ. */
function leg(volts: number, rSource: number, rLeak: number, c: number) {
  return {
    target: (volts * rLeak) / (rSource + rLeak),
    tau: ((rSource * rLeak) / (rSource + rLeak)) * c,
  };
}

/** Periodic steady state of the RC node: low, high, time mean. */
function analytic(board: number, duty: number, period: number) {
  const chip = JSON.parse(
    readFileSync(join(catalog, "parts/sfab/atmega328p@1.0.0.json"), "utf8")
  );
  const { roh, rol, rLeak } = chip.axes.behaviour["1"].variants.avr8js.params;
  const R = 10_000;
  const C = 1e-6;
  // D9's own leak sits on its pin node: fold it into the drive first.
  const highPin = leg(board, roh, rLeak, 1);
  const lowPin = leg(0, rol, rLeak, 1);
  const high = leg(highPin.target, highPin.tau + R, rLeak, C);
  const low = leg(lowPin.target, lowPin.tau + R, rLeak, C);
  const tH = duty * period;
  const tL = period - tH;
  const a = Math.exp(-tH / high.tau);
  const b = Math.exp(-tL / low.tau);
  const hi = (high.target * (1 - a)) / (1 - a * b);
  const lo = hi * b;
  const intH = high.target * tH + (lo - high.target) * high.tau * (1 - a);
  const intL = hi * low.tau * (1 - b);
  return { lo, hi, mean: (intH + intL) / period };
}

function windowOf(read: RecordingRead, board: string) {
  let sum = 0;
  let boardSum = 0;
  let n = 0;
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const frame of read.frames) {
    const ms = Math.round(frame.t * 1000);
    if (ms <= FROM_MS || ms > TO_MS) continue;
    const row = frame.boards[board];
    const pin = row?.pinVolts?.D2;
    expect(pin, `${board} frame ${ms} ms has no D2 node`);
    if (!row || !pin) continue;
    sum += pin.v;
    boardSum += row.voltage;
    n += 1;
    if (pin.lo < lo) lo = pin.lo;
    if (pin.hi > hi) hi = pin.hi;
  }
  expect(n === 51, `${board}: ${n} frames in the window, want 51`);
  return { mean: sum / n, board: boardSum / n, lo, hi };
}

const { read, tracks } = await runWorld();
const period = (2 * 64 * 255) / 16e6;
const duty = 128 / 255;
// Backward Euler at h = 100 µs rounds the corners: about 1.2 mV off the
// ripple and under 1 µV off the mean (scratch rc-pwm). A drive with the
// wrong duty, or a pin read as its bit times the board, misses by volts.
const MEAN_V = 1e-3;
const RIPPLE_V = 2e-3;
const windows: Record<string, ReturnType<typeof windowOf>> = {};
for (const board of ["nano", "nanoUsb"]) {
  const got = windowOf(read, board);
  windows[board] = got;
  const want = analytic(got.board, duty, period);
  const ripple = got.hi - got.lo;
  const wantRipple = want.hi - want.lo;
  console.log(
    `pwm-rc: ${board} at ${got.board.toFixed(4)} V: mean ${got.mean.toFixed(6)} V vs ${want.mean.toFixed(6)} V, ripple ${ripple.toFixed(6)} V vs ${wantRipple.toFixed(6)} V`
  );
  expect(
    Math.abs(got.mean - want.mean) <= MEAN_V,
    `${board} mean ${got.mean} vs ${want.mean}`
  );
  expect(
    Math.abs(ripple - wantRipple) <= RIPPLE_V,
    `${board} ripple ${ripple} vs ${wantRipple}`
  );
}
// The bench feeds 5 V through 50 mΩ; the USB copy sits a Schottky lower.
const bench = windows.nano?.board ?? 0;
const usb = windows.nanoUsb?.board ?? 0;
expect(Math.abs(bench - 5) < 0.01, `bench board node ${bench}`);
expect(bench - usb > 0.1, `USB node ${usb} is not below the bench ${bench}`);

// The probe reads the same solved node, with its band.
const d2 = tracks.find((track) => track.id === "port:nano.D2~V");
expect(d2?.lo && d2.hi, "the D2 probe has no lo / hi band");
let probeSum = 0;
let probeN = 0;
for (let i = 0; i < (d2?.t.length ?? 0); i++) {
  const ms = Math.round((d2?.t[i] ?? 0) * 1000);
  const v = d2?.v[i];
  if (ms <= FROM_MS || ms > TO_MS || typeof v !== "number") continue;
  probeSum += v;
  probeN += 1;
}
const probeMean = probeSum / probeN;
expect(
  probeN === 51 && Math.abs(probeMean - (windows.nano?.mean ?? 0)) < 1e-6,
  `D2 probe mean ${probeMean} over ${probeN} frames`
);
// D9's node is the square wave itself: each frame spans both edges.
const d9 = tracks.find((track) => track.id === "port:nano.D9~V");
const last = (d9?.t.length ?? 0) - 1;
const d9Lo = d9?.lo?.[last] ?? Number.NaN;
const d9Hi = d9?.hi?.[last] ?? Number.NaN;
expect(d9Lo < 0.01 && d9Hi > 4.9, `D9 band ${d9Lo}..${d9Hi}`);
console.log(
  `pwm-rc: the D2 probe is the solved node (mean ${probeMean.toFixed(6)} V); D9 spans ${d9Lo.toFixed(4)}..${d9Hi.toFixed(4)} V`
);
console.log("pwm-rc.selfcheck ok");
