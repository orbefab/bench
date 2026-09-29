/**
 * Motor and rail stamps against the class-1 law (ADR 0010).
 * `solveRail` is the reference. The equality checks call the circuit
 * directly. The run is the circuit; two runs of one world are byte-identical.
 */

import { ok as expect } from "node:assert/strict";
import { fileURLToPath } from "node:url";

import type { RecordingRead, WorldState } from "@sfab-bench/contract";

import { closeRootWatches } from "./projects";
import { attachWorld, readRecording, stopWorld } from "./world/host";
import { type RailMotor, solveRail } from "./world/power";
import { createRailCircuit, type RailCircuit } from "./world/rail-circuit";

const armDir = fileURLToPath(
  new URL("../../../examples/arm/", import.meta.url)
);
const CASES = 2000;
const SIM_MS = 3000;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lerp(rng: () => number, lo: number, hi: number): number {
  return lo + (hi - lo) * rng();
}

type CaseMotor = RailMotor & { quiescent: number };

function solveCircuit(
  vNom: number,
  rSeries: number,
  iLimit: number,
  fixed: number,
  motors: readonly CaseMotor[],
  braking: "clip" | "return" = "clip"
): RailCircuit {
  const circuit = createRailCircuit({
    vNom,
    rSeries,
    iLimit,
    braking,
    motors: motors.map((motor) => ({
      resistance: motor.resistance,
      k: motor.k,
    })),
  });
  circuit.setFixed(fixed);
  for (let i = 0; i < motors.length; i++) {
    const motor = motors[i]!;
    circuit.setMotor(i, motor.fraction, motor.omega, true);
  }
  circuit.solve();
  return circuit;
}

/** Frozen at abccd10, the numbers the run used before the catalog tables left. */
const law = {
  k: 0.458,
  resistance: 7.1,
  efficiency: 0.57,
  eSat: 0.3,
  quiescent: 0.01,
};
const board = 0.05;
const usb = { voltage: 5, rSeries: 0.5, currentLimit: 0.9 };
const bench = { voltage: 5, rSeries: 0.05, currentLimit: 1 };

{
  const motors: CaseMotor[] = [
    {
      fraction: 1,
      omega: 0,
      k: law.k,
      resistance: law.resistance,
      quiescent: law.quiescent,
    },
  ];
  const fixed = board + law.quiescent;
  const closed = solveRail({
    vNom: usb.voltage,
    rSeries: usb.rSeries,
    iLimit: usb.currentLimit,
    fixed,
    motors,
  });
  const circuit = solveCircuit(
    usb.voltage,
    usb.rSeries,
    usb.currentLimit,
    fixed,
    motors
  );
  expect(
    Math.abs(circuit.voltage - 4.643) <= 5e-4,
    `usb stall ${circuit.voltage} V`
  );
  expect(
    Math.abs(circuit.voltage - closed.voltage) <= 1e-9 &&
      Math.abs(circuit.current - closed.current) <= 1e-9,
    `usb stall circuit ${circuit.voltage} V ${circuit.current} A vs ${closed.voltage} ${closed.current}`
  );
  const again = circuit.voltage;
  circuit.solve();
  expect(
    Math.abs(circuit.voltage - again) <= 1e-12,
    "usb stall drifted on the reused factor"
  );
  console.log(
    `coupling usb stall: ${circuit.voltage.toFixed(4)} V, ${circuit.current.toFixed(4)} A`
  );
}

{
  const motors: CaseMotor[] = [
    {
      fraction: 1,
      omega: -60,
      k: law.k,
      resistance: law.resistance,
      quiescent: 0,
    },
  ];
  const input = {
    vNom: usb.voltage,
    rSeries: usb.rSeries,
    iLimit: 0.05,
    fixed: board,
    motors,
  };
  const closed = solveRail(input);
  const circuit = solveCircuit(
    input.vNom,
    input.rSeries,
    input.iLimit,
    input.fixed,
    motors
  );
  expect(
    closed.voltage === 0,
    `closed form did not floor (${closed.voltage} V)`
  );
  expect(
    circuit.voltage === 0 && Math.abs(circuit.current - closed.current) <= 1e-9,
    `negative rail ${circuit.voltage} V ${circuit.current} A vs ${closed.current} A`
  );
  console.log(
    `coupling negative rail: 0 V, draw ${circuit.current.toFixed(4)} A`
  );
}

{
  const rng = mulberry32(0xc0ffee);
  let maxV = 0;
  let maxI = 0;
  let maxW = 0;
  let limited = 0;
  let braking = 0;
  let allBraking = 0;
  for (let n = 0; n < CASES; n++) {
    const preset = n % 2 === 0 ? usb : bench;
    const vNom = preset === usb ? usb.voltage : lerp(rng, 4.8, 12);
    let count = Math.floor(rng() * 13);
    let iLimit = lerp(rng, 0.15, preset === usb ? 1.5 : 3);
    const forcedBrake = n >= 400 && n < 700;
    const forcedLimit = n < 400;
    if (forcedBrake) {
      count = 1 + Math.floor(rng() * 12);
      iLimit = preset === usb ? 0.9 : 2;
    } else if (forcedLimit) {
      count = 1 + Math.floor(rng() * 4);
      iLimit = lerp(rng, 0.05, 0.35);
    }
    const motors: CaseMotor[] = [];
    let quiescent = 0;
    for (let i = 0; i < count; i++) {
      const fraction = forcedBrake ? 1 : lerp(rng, -1, 1);
      const omega = forcedBrake
        ? lerp(rng, 40, 60)
        : forcedLimit
          ? 0
          : lerp(rng, -60, 60);
      const motor: CaseMotor = {
        fraction,
        omega,
        k: forcedBrake ? lerp(rng, 0.4, 1) : lerp(rng, 0.1, 1),
        resistance: lerp(rng, 2, 15),
        quiescent: lerp(rng, 0, 0.02),
      };
      quiescent += motor.quiescent;
      motors.push(motor);
    }
    const fixed = lerp(rng, 0, 0.2) + quiescent;
    const closed = solveRail({
      vNom,
      rSeries: preset.rSeries,
      iLimit,
      fixed,
      motors,
    });
    let circuit: RailCircuit;
    try {
      circuit = solveCircuit(vNom, preset.rSeries, iLimit, fixed, motors);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `case ${n} vNom ${vNom} Rs ${preset.rSeries} Ilim ${iLimit} fixed ${fixed} motors ${JSON.stringify(motors)}: ${message}`
      );
    }
    const dV = Math.abs(circuit.voltage - closed.voltage);
    const dI = Math.abs(circuit.current - closed.current);
    if (dV > maxV) maxV = dV;
    if (dI > maxI) maxI = dI;
    if (dV > 1e-9 || dI > 1e-9) {
      throw new Error(
        `case ${n} ΔV ${dV} ΔI ${dI} circuit ${circuit.voltage} ${circuit.current} closed ${closed.voltage} ${closed.current}`
      );
    }
    let brakes = 0;
    for (let i = 0; i < motors.length; i++) {
      const motor = motors[i]!;
      const winding = circuit.winding[i] ?? 0;
      const ref =
        (motor.fraction * closed.voltage - motor.k * motor.omega) /
        motor.resistance;
      const dW = Math.abs(winding - ref);
      if (dW > maxW) maxW = dW;
      if (dW > 1e-9) {
        throw new Error(`case ${n} motor ${i} ΔI ${dW}`);
      }
      if (motor.fraction * winding < -1e-9) brakes += 1;
    }
    if (Math.abs(closed.current - iLimit) <= 1e-9) limited += 1;
    if (brakes > 0) braking += 1;
    if (motors.length > 0 && brakes === motors.length) allBraking += 1;
    circuit.solve();
    const dV2 = Math.abs(circuit.voltage - closed.voltage);
    const dI2 = Math.abs(circuit.current - closed.current);
    if (dV2 > 1e-9 || dI2 > 1e-9) {
      throw new Error(`case ${n} reuse ΔV ${dV2} ΔI ${dI2}`);
    }
  }
  expect(limited >= 250, `only ${limited} cases hit the current limit`);
  expect(allBraking >= 200, `only ${allBraking} cases were all braking`);
  console.log(
    `coupling rail: ${CASES} cases, max |ΔV| ${maxV.toExponential(2)} V, max |ΔI| ${maxI.toExponential(2)} A, max |Δwinding| ${maxW.toExponential(2)} A, limit ${limited}, braking ${braking}, all braking ${allBraking}`
  );
}

{
  const shared = {
    vNom: usb.voltage,
    rSeries: usb.rSeries,
    iLimit: usb.currentLimit,
    fixed: board + law.quiescent,
  };
  const live: CaseMotor = {
    fraction: 1,
    omega: 0,
    k: law.k,
    resistance: law.resistance,
    quiescent: law.quiescent,
  };
  const closed = solveRail({ ...shared, motors: [live] });
  const withOpen = createRailCircuit({
    vNom: shared.vNom,
    rSeries: shared.rSeries,
    iLimit: shared.iLimit,
    motors: [
      { resistance: law.resistance, k: law.k },
      { resistance: law.resistance, k: law.k },
    ],
  });
  withOpen.setFixed(shared.fixed);
  withOpen.setMotor(0, 1, 0, true);
  withOpen.setMotor(1, 1, 10, false);
  withOpen.solve();
  expect(
    Math.abs(withOpen.voltage - closed.voltage) <= 1e-9 &&
      Math.abs(withOpen.current - closed.current) <= 1e-9 &&
      (withOpen.winding[1] ?? 1) === 0,
    `open winding moved the rail to ${withOpen.voltage} V`
  );
  console.log("coupling open winding: rail unchanged, current 0");
}

{
  const inductive = createRailCircuit({
    vNom: usb.voltage,
    rSeries: usb.rSeries,
    iLimit: usb.currentLimit,
    motors: [{ resistance: law.resistance, k: law.k, inductance: 5e-3 }],
  });
  expect(inductive.substeps === 10, `substeps ${inductive.substeps}`);
  inductive.setFixed(board + law.quiescent);
  inductive.setMotor(0, 1, 0, true);
  inductive.solve();
  const stalled = inductive.winding[0] ?? 0;
  inductive.setMotor(0, 1, 30, true);
  inductive.solve();
  expect(
    inductive.lastFrozen >= 8,
    `inductive step froze ${inductive.lastFrozen} substeps`
  );
  const mid = inductive.winding[0] ?? 0;
  expect(
    Math.abs(mid - stalled) > 1e-3,
    "inductance did not move the winding current"
  );
  for (let i = 0; i < 40; i++) inductive.solve();
  const settled = inductive.winding[0] ?? 0;
  const algebraic = solveCircuit(
    usb.voltage,
    usb.rSeries,
    usb.currentLimit,
    board + law.quiescent,
    [
      {
        fraction: 1,
        omega: 30,
        k: law.k,
        resistance: law.resistance,
        quiescent: law.quiescent,
      },
    ]
  );
  expect(
    Math.abs(settled - (algebraic.winding[0] ?? 0)) < 1e-5,
    `L settled at ${settled}, algebraic ${algebraic.winding[0]}`
  );
  console.log(
    `coupling inductance: 10 substeps, frozen ${inductive.lastFrozen}, settled`
  );
}

{
  const phases = [
    { steps: 8, fraction: 1, omega: 0 },
    { steps: 8, fraction: 1, omega: 20 },
    { steps: 8, fraction: 0, omega: 20 },
  ];
  const run = (braking: "clip" | "return") => {
    const circuit = createRailCircuit({
      vNom: usb.voltage,
      rSeries: usb.rSeries,
      iLimit: usb.currentLimit,
      braking,
      motors: [{ resistance: law.resistance, k: law.k }],
    });
    circuit.setFixed(board + law.quiescent);
    const current: number[] = [];
    const winding: number[] = [];
    const fraction: number[] = [];
    for (const phase of phases) {
      for (let i = 0; i < phase.steps; i++) {
        circuit.setMotor(0, phase.fraction, phase.omega, true);
        circuit.solve();
        current.push(circuit.current);
        winding.push(circuit.winding[0] ?? 0);
        fraction.push(phase.fraction);
      }
    }
    return { current, winding, fraction };
  };
  const clipped = run("clip");
  const returned = run("return");
  let maxDiff = 0;
  let differed = false;
  for (let i = 0; i < clipped.current.length; i++) {
    const sI = (clipped.fraction[i] ?? 0) * (clipped.winding[i] ?? 0);
    const diff = Math.abs(
      (clipped.current[i] ?? 0) - (returned.current[i] ?? 0)
    );
    if (diff > maxDiff) maxDiff = diff;
    if (sI < -1e-9) {
      if (diff > 1e-6) differed = true;
    } else {
      expect(
        diff <= 1e-9,
        `braking modes differed by ${diff} A while motoring`
      );
    }
  }
  expect(differed, "return mode never left the clipped supply current");
  console.log(
    `INFO coupling braking return: max supply-current difference ${maxDiff.toExponential(3)} A`
  );
}

{
  const circuit = createRailCircuit({
    vNom: usb.voltage,
    rSeries: usb.rSeries,
    iLimit: usb.currentLimit,
    motors: Array.from({ length: 12 }, () => ({
      resistance: law.resistance,
      k: law.k,
    })),
  });
  const rng = mulberry32(12);
  circuit.setFixed(board + 12 * law.quiescent);
  const prime = () => {
    for (let i = 0; i < 12; i++) {
      circuit.setMotor(i, lerp(rng, -1, 1), lerp(rng, -60, 60), true);
    }
  };
  prime();
  circuit.solve();
  for (let i = 0; i < 20; i++) {
    prime();
    circuit.solve();
  }
  const samples = 80;
  const times = new Float64Array(samples);
  for (let i = 0; i < samples; i++) {
    prime();
    const t0 = process.hrtime.bigint();
    circuit.solve();
    const t1 = process.hrtime.bigint();
    times[i] = Number(t1 - t0) / 1000;
  }
  const sorted = Array.from(times).sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1] ?? 0;
  if (process.env.BENCH_TIMINGS === "1")
    console.log(
      `INFO coupling cost: ${median.toFixed(1)} µs per 1 ms for 12 servos`
    );
}

async function runWorld(world: string): Promise<RecordingRead> {
  const seen: { state: WorldState | null; failed: string | null } = {
    state: null,
    failed: null,
  };
  const attached = await attachWorld(armDir, world, {
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
    attached.step(SIM_MS);
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (seen.failed) throw new Error(seen.failed);
      const simTime = seen.state?.simTime ?? -1;
      if (simTime >= SIM_MS / 1000 - 1e-3) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const simTime = seen.state?.simTime ?? -1;
    if (simTime < SIM_MS / 1000 - 1e-3) {
      throw new Error(
        `${world} timed out at ${seen.state ? simTime : "no state"} s`
      );
    }
    const read = await readRecording(armDir, world, {
      from: 0,
      to: SIM_MS / 1000,
    });
    if ("error" in read) throw new Error(read.error);
    return read;
  } finally {
    attached.detach();
    await stopWorld(armDir, world);
    closeRootWatches();
  }
}

const worlds = [
  "parts/sfab/arm-bench@1.0.0.json",
  "parts/sfab/arm-stall@1.0.0.json",
] as const;
for (const world of worlds) {
  const circuit = await runWorld(world);
  const again = await runWorld(world);
  expect(
    JSON.stringify(circuit) === JSON.stringify(again),
    `${world} circuit runs are not byte-identical`
  );
  console.log(
    `coupling ${world}: ${circuit.frames.length} frames, circuit runs identical`
  );
}
