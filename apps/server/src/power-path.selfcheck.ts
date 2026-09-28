/**
 * Uno USB path (ADR 0010, D-020). The run uses this circuit. `solveRail`
 * stays the reference for the bench supply, which takes no cable.
 */

import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { RecordingRead, WorldState } from "@sfab-bench/contract";

import { closeRootWatches } from "./projects";
import { Engine, TRACE_CASES } from "./world/circuit";
import { MF_MSMF050, PtcFuseElement } from "./world/circuit/ptc-fuse";
import { boardStampOf } from "./world/circuit-stamp";
import {
  type AttachWorldOptions,
  attachWorld,
  readRecording,
  stopWorld,
} from "./world/host";
import {
  BOD_ASSERT_V,
  BOD_RELEASE_V,
  RESET_HOLD_MS,
  runningBrownout,
  solveRail,
  stepBrownout,
} from "./world/power";
import {
  UNO_F1_IHOLD,
  UNO_F1_R,
  UNO_F1_R_HOT,
  UNO_F1_TAU_S,
  UNO_F1_TMAX_8A_S,
  UNO_T1_RDS,
  unoUsbPathFor,
} from "./world/power-path";
import { createRailCircuit, type RailCircuit } from "./world/rail-circuit";
import { readDraft, writeDraft } from "./world/selfcheck-draft";

const LINE = 0.005;
/** Board node and recorded rail may sit this far under 0 V. */
const FLOOR_V = -1e-9;
const armDir = fileURLToPath(
  new URL("../../../examples/arm/", import.meta.url)
);
const fixtureDir = fileURLToPath(
  new URL("../fixtures/circuit/", import.meta.url)
);
/** Frozen at abccd10, the numbers the run used before the catalog tables left. */
const law = {
  k: 0.458,
  resistance: 7.1,
  efficiency: 0.57,
  eSat: 0.3,
  quiescent: 0.01,
};
const boardA = 0.05;
const usb = { voltage: 5, rSeries: 0.5, currentLimit: 0.9 };
const benchRs = 0.05;
const fixedStall = boardA + law.quiescent;
/**
 * Residual after a trip, so the fuse can cool. The catalog 50 mA board
 * load is I²·Rhot above the trip power, so a tripped fuse stays open
 * while the Uno is still drawing its idle current. 30 mA is under that
 * latch and still holds the board under the brownout assert until the
 * fuse cools.
 */
const RECOVER_A = 0.03;

function expect(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(label);
}

function pct(frac: number): string {
  return `${(frac * 100).toFixed(4)}%`;
}

function interp(
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

function rangeError(ours: readonly number[], ref: readonly number[]): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of ref) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo || 1;
  let worst = 0;
  for (let i = 0; i < ours.length; i++) {
    const err = Math.abs(ours[i]! - ref[i]!) / span;
    if (err > worst) worst = err;
  }
  return worst;
}

function loadCsv(name: string): { t: number[]; v: number[] } {
  const text = readFileSync(join(fixtureDir, name), "utf8");
  const t: number[] = [];
  const v: number[] = [];
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#") || line.startsWith("t,")) continue;
    const [ts, vs] = line.split(",");
    if (!ts || !vs) continue;
    t.push(Number(ts));
    v.push(Number(vs));
  }
  return { t, v };
}

function expectBoard(circuit: RailCircuit, label: string): void {
  expect(
    circuit.boardMinVoltage >= FLOOR_V,
    `${label} board min ${circuit.boardMinVoltage} V`
  );
  expect(
    circuit.boardVoltage >= FLOOR_V,
    `${label} board ${circuit.boardVoltage} V`
  );
}

function expectRecorded(read: RecordingRead, label: string): void {
  for (const frame of read.frames) {
    for (const [id, supply] of Object.entries(frame.supplies)) {
      expect(
        supply.voltage >= FLOOR_V,
        `${label} ${id} ${frame.t} s at ${supply.voltage} V`
      );
      expect(
        supply.minVoltage >= FLOOR_V,
        `${label} ${id} min ${frame.t} s at ${supply.minVoltage} V`
      );
    }
    for (const [id, board] of Object.entries(frame.boards)) {
      expect(
        board.voltage >= FLOOR_V,
        `${label} ${id} node ${frame.t} s at ${board.voltage} V`
      );
      expect(
        board.minVoltage >= FLOOR_V,
        `${label} ${id} node min ${frame.t} s at ${board.minVoltage} V`
      );
    }
  }
}

function msUntilTrip(amps: number, limitMs: number): number {
  const fuse = new PtcFuseElement("f", "a", "b", MF_MSMF050);
  let ms = 0;
  while (!fuse.tripped && ms < limitMs) {
    fuse.advance(amps, 0.001);
    ms++;
  }
  return fuse.tripped ? ms : -1;
}

const trace = loadCsv("uno-usb.csv");
{
  const spec = TRACE_CASES.find((item) => item.id === "uno-usb");
  expect(spec, "uno-usb trace case");
  const eng = new Engine(spec.elements(), { method: "be", h: spec.h });
  const samples = eng.run(spec.steps, ["v5"]);
  const ours = trace.t.map((t) =>
    interp(
      samples.map((s) => s.t),
      samples.map((s) => s.v.v5 ?? 0),
      t
    )
  );
  const err = rangeError(ours, trace.v);
  expect(err <= LINE, `uno-usb ${pct(err)} of span exceeds 0.5%`);
  for (const sample of samples) {
    const v = sample.v.v5 ?? 0;
    expect(v >= FLOOR_V, `uno-usb ${sample.t} s at ${v} V`);
  }
  console.log(`circuit uno-usb: ${pct(err)} of span`);
}

const closedStall = solveRail({
  vNom: usb.voltage,
  rSeries: usb.rSeries,
  iLimit: usb.currentLimit,
  fixed: fixedStall,
  motors: [{ fraction: 1, omega: 0, k: law.k, resistance: law.resistance }],
});
const unoStamp = boardStampOf("sfab/uno-r3@1.0.0", "circuits", {
  boardId: "uno",
});
const stall = createRailCircuit({
  vNom: usb.voltage,
  rSeries: usb.rSeries,
  iLimit: usb.currentLimit,
  motors: [{ resistance: law.resistance, k: law.k }],
  boardPath: "uno-usb",
  stamp: unoStamp,
  feed: "usb",
});
stall.setFixed(fixedStall);
stall.setMotor(0, 1, 0, true);
stall.solve();
expectBoard(stall, "usb stall");
stall.solve();
expectBoard(stall, "usb stall");
const stallDrop = stall.current * (UNO_F1_R + UNO_T1_RDS);
expect(stall.boardVoltage < closedStall.voltage, "path did not sag the board");
expect(
  Math.abs(stall.voltage - stall.boardVoltage - stallDrop) <= 0.001,
  `board ${stall.boardVoltage} V is not the terminal minus I·(Rf+Rt) (${stallDrop} V)`
);
expect(!stall.tripped, "stall current tripped the fuse");
console.log(
  `usb path stall: board ${stall.boardVoltage.toFixed(4)} V, ` +
    `terminal ${stall.voltage.toFixed(4)} V, ` +
    `supply ${stall.current.toFixed(4)} A ` +
    `(closed form ${closedStall.voltage.toFixed(4)} V, drop ${stallDrop.toFixed(4)} V)`
);

expect(
  unoUsbPathFor("usb", "path:uno-usb"),
  "a USB port on an Uno should take the path"
);
expect(
  !unoUsbPathFor(null, "path:uno-usb"),
  "a bench supply should not take the path"
);
{
  const benchClosed = solveRail({
    vNom: 5,
    rSeries: benchRs,
    iLimit: 0.3,
    fixed: fixedStall,
    motors: [{ fraction: 1, omega: 0, k: law.k, resistance: law.resistance }],
  });
  const bench = createRailCircuit({
    vNom: 5,
    rSeries: benchRs,
    iLimit: 0.3,
    motors: [{ resistance: law.resistance, k: law.k }],
  });
  bench.setFixed(fixedStall);
  bench.setMotor(0, 1, 0, true);
  bench.solve();
  expectBoard(bench, "bench");
  expect(
    Math.abs(bench.voltage - benchClosed.voltage) <= 1e-9,
    `bench path ${bench.voltage} vs solveRail ${benchClosed.voltage}`
  );
  expect(
    Math.abs(bench.boardVoltage - bench.voltage) <= 1e-9,
    "bench supply grew a second node"
  );
  console.log(
    `bench on 5V: ${bench.voltage.toFixed(6)} V equals solveRail, no path`
  );
}

{
  const held = new PtcFuseElement("f", "a", "b", MF_MSMF050);
  for (let ms = 0; ms < 60_000; ms++) held.advance(UNO_F1_IHOLD, 0.001);
  expect(!held.tripped, `0.5 A tripped, u=${held.u}`);
  const onRail = createRailCircuit({
    vNom: 5,
    rSeries: 0.5,
    iLimit: 2,
    motors: [],
    boardPath: "uno-usb",
    stamp: unoStamp,
    feed: "usb",
  });
  onRail.setFixed(UNO_F1_IHOLD);
  const matched = new PtcFuseElement("f", "a", "b", MF_MSMF050);
  for (let ms = 0; ms < 100; ms++) {
    onRail.solve();
    expectBoard(onRail, "fuse hold");
    matched.advance(UNO_F1_IHOLD, 0.001);
  }
  expect(
    Math.abs(onRail.current - UNO_F1_IHOLD) < 1e-6,
    `hold current ${onRail.current}`
  );
  expect(!onRail.tripped, "rail fuse tripped at 0.5 A");
  expect(onRail.boardVoltage > 4, `hold board ${onRail.boardVoltage}`);
  console.log(
    `polyfuse hold: 0.5 A for 60 s, u=${held.u.toFixed(3)}, ` +
      `board ${onRail.boardVoltage.toFixed(3)} V, τ=${UNO_F1_TAU_S.toFixed(3)} s`
  );
}

{
  // Bourns MF-MSMF050: maximum time to trip 0.15 s at 8 A. The typical
  // curve is "Typical Time to Trip at 23 °C". The model is fitted to
  // 0.10 s at 8 A. At 2 A the same pole is accepted inside 0.5–15 s,
  // the band that covers that curve at twice the trip current.
  const at8 = msUntilTrip(8, 1000);
  expect(at8 > 0 && at8 <= UNO_F1_TMAX_8A_S * 1000, `8 A trip ${at8} ms`);
  const trip = createRailCircuit({
    vNom: 5,
    rSeries: 0.5,
    iLimit: 3,
    motors: [],
    boardPath: "uno-usb",
    stamp: unoStamp,
    feed: "usb",
  });
  trip.setFixed(2);
  let bo = runningBrownout();
  let trippedAt = -1;
  let assertAt = -1;
  let terminalAtAssert = 0;
  let boardAtAssert = 0;
  let releaseAt: number | null = null;
  let rebootAt = -1;
  let dropped = false;
  for (let ms = 1; ms <= 30_000 && rebootAt < 0; ms++) {
    trip.solve();
    expectBoard(trip, "fuse trip");
    if (trip.tripped && trippedAt < 0) trippedAt = ms;
    if (trippedAt > 0 && assertAt > 0 && !dropped) {
      trip.setFixed(RECOVER_A);
      dropped = true;
    }
    const stepped = stepBrownout(bo, trip.boardMinVoltage, ms);
    bo = { phase: stepped.phase, releaseAtMs: stepped.releaseAtMs };
    if (stepped.assertReset) {
      assertAt = ms;
      terminalAtAssert = trip.voltage;
      boardAtAssert = trip.boardMinVoltage;
    }
    if (stepped.phase === "delay" && releaseAt === null) {
      releaseAt = stepped.releaseAtMs;
    }
    if (stepped.reboot) rebootAt = ms;
  }
  expect(
    trippedAt >= 500 && trippedAt <= 15_000,
    `2 A trip at ${trippedAt} ms`
  );
  expect(assertAt > 0, "tripped board did not brown out");
  expect(
    terminalAtAssert > BOD_RELEASE_V,
    `terminal at assert ${terminalAtAssert} V`
  );
  expect(boardAtAssert < BOD_ASSERT_V, `board at assert ${boardAtAssert} V`);
  expect(rebootAt > 0, "rail did not recover");
  expect(!trip.tripped, "fuse still open at reboot");
  expect(
    releaseAt !== null && rebootAt - releaseAt === RESET_HOLD_MS,
    `hold ${rebootAt - (releaseAt ?? 0)} ms`
  );
  expect(
    trip.boardVoltage > BOD_RELEASE_V,
    `recovered board ${trip.boardVoltage}`
  );
  console.log(
    `polyfuse trip: 8 A in ${at8} ms (max ${UNO_F1_TMAX_8A_S} s), ` +
      `2 A in ${(trippedAt / 1000).toFixed(3)} s, ` +
      `brownout at ${assertAt} ms (board ${boardAtAssert.toFixed(3)} V, ` +
      `terminal ${terminalAtAssert.toFixed(3)} V), ` +
      `reboot ${rebootAt - (releaseAt ?? rebootAt)} ms after release, Rhot=${UNO_F1_R_HOT} Ω`
  );
}

{
  const motors = Array.from({ length: 12 }, () => ({
    resistance: law.resistance,
    k: law.k,
  }));
  const cost = createRailCircuit({
    vNom: usb.voltage,
    rSeries: usb.rSeries,
    iLimit: usb.currentLimit,
    motors,
    boardPath: "uno-usb",
    stamp: unoStamp,
    feed: "usb",
  });
  cost.setFixed(boardA + 12 * law.quiescent);
  for (let i = 0; i < motors.length; i++) cost.setMotor(i, 0.5, 1, true);
  cost.solve();
  expectBoard(cost, "twelve servos");
  const n = 200;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    cost.solve();
    expectBoard(cost, "twelve servos");
  }
  const us = ((performance.now() - t0) * 1000) / n;
  console.log(
    `INFO uno usb path, 12 servos: ${us.toFixed(1)} µs per 1 ms step`
  );
}

async function runWorld(
  project: string,
  world: string,
  ms: number,
  options?: AttachWorldOptions
): Promise<{ state: WorldState; read: RecordingRead }> {
  const seen: { state: WorldState | null; failed: string | null } = {
    state: null,
    failed: null,
  };
  const attached = await attachWorld(
    project,
    world,
    {
      sender: { kind: "loopback", label: "Mac" },
      onEvent(event) {
        if (event.type === "error") {
          seen.failed =
            event.message ??
            event.errors.map((item) => item.message).join("; ");
        }
        if (event.type === "state") seen.state = event.state;
      },
    },
    options
  );
  if ("error" in attached) throw new Error(attached.error);
  try {
    attached.step(ms);
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (seen.failed) throw new Error(seen.failed);
      const simTime = seen.state?.simTime ?? -1;
      if (simTime >= ms / 1000 - 1e-3) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const state = seen.state;
    if (!state || state.simTime < ms / 1000 - 1e-3) {
      throw new Error(
        `${world} timed out at ${state ? state.simTime : "no state"} s`
      );
    }
    const read = await readRecording(project, world, {
      from: 0,
      to: ms / 1000,
    });
    if ("error" in read) throw new Error(read.error);
    expectRecorded(read, world);
    if (state.supplies) {
      for (const [id, supply] of Object.entries(state.supplies)) {
        expect(
          supply.voltage >= FLOOR_V,
          `${world} live ${id} at ${supply.voltage} V`
        );
      }
    }
    return { state, read };
  } finally {
    attached.detach();
    await stopWorld(project, world);
    closeRootWatches();
  }
}

{
  const opened = await runWorld(armDir, "arm.world.json", 200, {
    fuseStart: "tripped",
  });
  expect(opened.state.supplies, "circuit supplies");
  const boardV = opened.state.boards.uno?.voltage ?? Number.NaN;
  const amps = opened.state.supplies?.usb?.current ?? Number.NaN;
  const terminal = opened.state.supplies?.usb?.voltage ?? Number.NaN;
  expect(
    opened.state.boards.uno?.brownout === true,
    "tripped fuse did not reset"
  );
  expect(
    boardV < BOD_ASSERT_V,
    `board node ${boardV} V stayed above the assert`
  );
  expect(amps < usb.currentLimit, `supply left CV at ${amps} A`);
  expect(terminal > BOD_RELEASE_V, `terminal ${terminal} V`);
  console.log(
    `brownout from the board node: board ${boardV.toFixed(3)} V, ` +
      `terminal ${terminal.toFixed(3)} V, reset`
  );
}

{
  const bench = await runWorld(armDir, "arm-stall.world.json", 2000);
  const browned = bench.read.frames.some(
    (frame) => frame.boards.uno?.brownoutAny === true
  );
  let benchMin = Infinity;
  for (const frame of bench.read.frames) {
    const voltage = frame.boards.uno?.minVoltage ?? frame.boards.uno?.voltage;
    if (voltage !== undefined && voltage < benchMin) benchMin = voltage;
  }
  expect(browned, "bench stall did not brown out");
  expect(benchMin < BOD_ASSERT_V, `bench stall minimum ${benchMin} V`);
  expect(
    bench.state.supplies?.bench?.voltage === bench.state.boards.uno?.voltage,
    `bench terminal ${bench.state.supplies?.bench?.voltage} V is not the board node`
  );
  console.log(
    `bench stall: minimum ${benchMin.toFixed(3)} V, brownout, no path`
  );
}

const usbRoot = mkdtempSync(join(tmpdir(), "sfab-uno-path-"));
try {
  cpSync(armDir, usbRoot, { recursive: true });
  const world = readDraft(usbRoot, "arm-stall.world.json");
  world.supplies = [
    {
      id: "usb",
      kind: "usb",
      voltage: usb.voltage,
      currentLimit: usb.currentLimit,
      rSeries: usb.rSeries,
    },
  ];
  world.wires = world.wires.map((wire) => [
    wire[0].replace(/^bench\./, "usb."),
    wire[1].replace(/^bench\./, "usb."),
  ]);
  writeDraft(usbRoot, "usb-stall.world.json", world);
  const first = await runWorld(usbRoot, "usb-stall.world.json", 3000);
  const second = await runWorld(usbRoot, "usb-stall.world.json", 3000);
  expect(
    JSON.stringify(first.read) === JSON.stringify(second.read),
    "usb stall circuit runs are not byte-identical"
  );
  const frames = first.read.frames;
  const last = frames[frames.length - 1];
  expect(last, "no frames");
  const steady = last.boards.uno?.voltage ?? Number.NaN;
  const liveTerminal = first.state.supplies?.usb?.voltage ?? Number.NaN;
  const liveAmps = first.state.supplies?.usb?.current ?? Number.NaN;
  const liveNode = first.state.boards.uno?.voltage ?? Number.NaN;
  expect(
    Math.abs(liveTerminal - (usb.voltage - usb.rSeries * liveAmps)) <= 1e-9,
    `usb terminal ${liveTerminal} V at ${liveAmps} A`
  );
  expect(Math.abs(liveNode - 4.5067) <= 1e-4, `usb board node ${liveNode} V`);
  expect(
    first.state.parts?.servo?.voltage === liveNode,
    `servo V+ ${first.state.parts?.servo?.voltage} V is not the board node`
  );
  expect(
    frames.every((frame) => frame.boards.uno?.brownout !== true),
    "usb stall browned out"
  );
  expect(
    Math.abs(steady - stall.boardVoltage) <= 0.001,
    `steady board ${steady} V vs stall figure ${stall.boardVoltage} V`
  );
  expect(
    last.parts.servo?.state === "stall",
    `tail state ${last.parts.servo?.state}`
  );
  console.log(
    `arm stall on the usb path: board ${steady.toFixed(4)} V at 3 s, ` +
      `within 1 mV of ${stall.boardVoltage.toFixed(4)} V, no brownout, runs identical`
  );
} finally {
  rmSync(usbRoot, { recursive: true, force: true });
}
