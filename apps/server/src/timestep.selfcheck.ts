/**
 * C3 prerequisite: the run's master step is `play.timestep` when it divides
 * 1 ms. The Nano servo scene (vcc firmware: a Vcc line every 100 ms and a
 * servo sweep at 1 s) runs 1.5 s at 1, 0.5 and 0.1 ms. Time, the serial lines and the
 * recorder's frame grid stay on whole milliseconds at every step. A step
 * that does not divide 1 ms warns and runs exactly the 1 ms run.
 */

import { ok as expect } from "node:assert/strict";
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

import {
  type RunReport,
  stepsPerMs,
  type WorldState,
} from "@sfab-bench/contract";

import { RunRecorder } from "@sfab-bench/sim/record";

import { closeRootWatches } from "./projects";
import { attachWorld, recordingInfo, stopWorld } from "./world/host";

const RUN_MS = 1500;
const nanoDir = fileURLToPath(
  new URL("../../../examples/nano/", import.meta.url)
);

for (const [seconds, want] of [
  [0.001, 1],
  [0.0005, 2],
  [0.0001, 10],
  [0.00001, 100],
  [0.000001, 1000],
  [0.002, null],
  [0.0003, null],
  [0.0000005, null],
  [0, null],
  [-0.001, null],
] as const) {
  expect(
    stepsPerMs(seconds) === want,
    `stepsPerMs(${seconds}) is ${stepsPerMs(seconds)}, want ${want}`
  );
}

// A finer step records at the step that ends a millisecond. The steps
// before it still fold their extremes into the frame's window.
{
  const rec = new RunRecorder({
    id: "fold",
    manifest: {
      mujoco: "3.14.0",
      avr8js: "0.21.1",
      timestep: 0.0001,
      integrator: "implicitfast",
      frameMs: 10,
      worldSha256: "0".repeat(64),
      boards: [],
      parts: {},
    },
    joints: [],
    bodies: [],
    parts: [],
    supplies: ["usb"],
    boards: [],
  });
  rec.voltage[0] = 4.2;
  rec.voltageLow[0] = 4.2;
  rec.supplyCurrent[0] = 0.9;
  rec.supplyCurrentHigh[0] = 0.9;
  rec.foldStep();
  // The step that ends the millisecond dipped and peaked between its
  // circuit sub-steps, then recovered.
  rec.voltage[0] = 5;
  rec.voltageLow[0] = 4.5;
  rec.supplyCurrent[0] = 0.02;
  rec.supplyCurrentHigh[0] = 0.3;
  rec.commit(10);
  const usb = rec.read({ from: 0, to: 0.01 }).frames[0]?.supplies.usb;
  expect(
    // The recorder stores float32.
    usb?.minVoltage === Math.fround(4.2) &&
      usb.maxCurrent === Math.fround(0.9) &&
      usb.voltage === 5,
    `a sub-millisecond dip is lost: ${JSON.stringify(usb)}`
  );
  rec.voltage[0] = 5;
  rec.voltageLow[0] = 4.5;
  rec.supplyCurrent[0] = 0.02;
  rec.supplyCurrentHigh[0] = 0.3;
  rec.commit(20);
  const next = rec.read({ from: 0.02, to: 0.02 }).frames[0]?.supplies.usb;
  expect(
    next?.minVoltage === Math.fround(4.5) &&
      next.maxCurrent === Math.fround(0.3) &&
      next.voltage === 5,
    `a dip between circuit sub-steps is lost: ${JSON.stringify(next)}`
  );
  console.log(
    "timestep: a dip and a peak inside a millisecond, or between its circuit sub-steps, reach the frame's min and max"
  );
}

type Seen = {
  /** MuJoCo's `opt.timestep`, from the recording manifest. */
  modelStep: number | null;
  state: WorldState | null;
  report: RunReport | null;
  serial: string;
};

async function run(dir: string, world: string): Promise<Seen> {
  const seen: Seen & { failed: string | null } = {
    state: null,
    report: null,
    serial: "",
    failed: null,
    modelStep: null,
  };
  const attached = await attachWorld(dir, world, {
    sender: { kind: "loopback", label: "Mac" },
    onEvent(event) {
      if (event.type === "error") {
        seen.failed =
          event.message ?? event.errors.map((item) => item.message).join("; ");
      }
      if (event.type === "serial") seen.serial += event.text;
      if (event.type === "state") {
        seen.state = event.state;
        if (event.report) seen.report = event.report;
      }
    },
  });
  if ("error" in attached) throw new Error(attached.error);
  try {
    attached.step(RUN_MS);
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      if (seen.failed) throw new Error(seen.failed);
      if ((seen.state?.simTime ?? -1) >= RUN_MS / 1000 - 1e-9) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!seen.state || seen.state.simTime < RUN_MS / 1000 - 1e-9) {
      throw new Error(`${world} timed out at ${seen.state?.simTime} s`);
    }
    const info = await recordingInfo(dir, world);
    if ("error" in info) throw new Error(info.error);
    seen.modelStep = info.manifest.timestep;
  } finally {
    attached.detach();
    await stopWorld(dir, world);
    closeRootWatches();
  }
  return seen;
}

const vccLines = (serial: string) =>
  serial
    .split("\n")
    .map((line) => line.trim())
    .flatMap((line) => /^vcc,(\d+)$/.exec(line)?.slice(1) ?? [])
    .map(Number);

const dir = mkdtempSync(join(tmpdir(), "sfab-timestep-"));
try {
  cpSync(nanoDir, dir, { recursive: true });
  const base = JSON.parse(
    readFileSync(join(dir, "parts/sfab/nano-vcc-usb@1.0.0.json"), "utf8")
  );
  const runs = new Map<number, Seen>();
  for (const seconds of [0.001, 0.0005, 0.0001, 0.002]) {
    const name = `step-${String(seconds).replace(".", "p")}`;
    const file = `parts/sfab/${name}@1.0.0.json`;
    writeFileSync(
      join(dir, file),
      JSON.stringify({
        ...base,
        id: `sfab/${name}@1.0.0`,
        play: { ...base.play, timestep: seconds },
      })
    );
    runs.set(seconds, await run(dir, file));
  }

  const at1 = runs.get(0.001)!;
  const lines1 = vccLines(at1.serial);
  expect(lines1.length >= 2, `1 ms run printed ${lines1.length} Vcc lines`);
  const angle = (seen: Seen) =>
    Object.values(seen.state?.joints ?? {}).flatMap((joints) =>
      Object.values(joints)
    );
  const busA = (seen: Seen) =>
    Object.values(seen.state?.supplies ?? {}).map((row) => row.current ?? 0);

  for (const [seconds, seen] of runs) {
    const warned = (seen.report?.warnings ?? []).filter(
      (row) => row.code === "timestep-unsupported"
    );
    const supported = stepsPerMs(seconds) !== null;
    expect(
      seen.modelStep === (supported ? seconds : 0.001),
      `${seconds} s: MuJoCo steps ${seen.modelStep}`
    );
    expect(
      warned.length === (supported ? 0 : 1),
      `${seconds} s: ${warned.length} timestep warnings`
    );
    expect(
      Math.abs((seen.state?.simTime ?? 0) - RUN_MS / 1000) < 1e-9,
      `${seconds} s: sim time ${seen.state?.simTime}`
    );
    const lines = vccLines(seen.serial);
    expect(
      lines.length === lines1.length,
      `${seconds} s: ${lines.length} Vcc lines, ${lines1.length} at 1 ms`
    );
    console.log(
      `timestep: ${seconds * 1000} ms: Vcc ${lines.join(", ")} mV; joints ${angle(
        seen
      )
        .map((rad) => ((rad * 180) / Math.PI).toFixed(3))
        .join(", ")} deg; supply ${busA(seen)
        .map((amps) => (amps * 1000).toFixed(3))
        .join(", ")} mA`
    );
  }

  // The unsupported step falls back to 1 ms: the same run, not a near one.
  const at2 = runs.get(0.002)!;
  expect(at2.serial === at1.serial, "2 ms fallback serial differs from 1 ms");
  expect(
    JSON.stringify(angle(at2)) === JSON.stringify(angle(at1)) &&
      JSON.stringify(busA(at2)) === JSON.stringify(busA(at1)),
    "2 ms fallback state differs from 1 ms"
  );
  console.log(
    "timestep: 1, 0.5 and 0.1 ms run on whole milliseconds; 2 ms warns and is the 1 ms run"
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
