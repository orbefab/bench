/**
 * Brownout inside the master step. The arm stall scene (Uno on a 5 V,
 * 0.3 A bench supply, a servo pushing the arm into its stop) browns the
 * chip out and reboots it. The servo goes limp at the sub-step the rail
 * crosses the assert voltage, not at the end of the step, so a 1 ms run
 * lands near a 0.01 ms run. Deciding the reset at the step end kept the
 * servo on for the whole step: the rail fell to 2.10 V against 2.67 V,
 * and the arm ended at 2.87° against 1.38°.
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

import type { RecordingRead, WorldState } from "@sfab-bench/contract";

import { closeRootWatches } from "./projects";
import { attachWorld, readRecording, stopWorld } from "./world/host";

const RUN_MS = 1000;
const armDir = fileURLToPath(
  new URL("../../../examples/arm/", import.meta.url)
);

type Seen = {
  read: RecordingRead;
  state: WorldState;
};

async function run(dir: string, world: string): Promise<Seen> {
  let state: WorldState | null = null;
  let failed: string | null = null;
  const attached = await attachWorld(dir, world, {
    sender: { kind: "loopback", label: "Mac" },
    onEvent(event) {
      if (event.type === "error") {
        failed =
          event.message ?? event.errors.map((item) => item.message).join("; ");
      }
      if (event.type === "state") state = event.state;
    },
  });
  if ("error" in attached) throw new Error(attached.error);
  try {
    attached.step(RUN_MS);
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      if (failed) throw new Error(failed);
      const t = (state as WorldState | null)?.simTime ?? -1;
      if (t >= RUN_MS / 1000 - 1e-9) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const done = state as WorldState | null;
    if (!done || done.simTime < RUN_MS / 1000 - 1e-9) {
      throw new Error(`${world} timed out at ${done?.simTime} s`);
    }
    const read = await readRecording(dir, world, {
      from: 0,
      to: RUN_MS / 1000,
    });
    if ("error" in read) throw new Error(read.error);
    return { read, state: done };
  } finally {
    attached.detach();
    await stopWorld(dir, world);
    closeRootWatches();
  }
}

function measure(seen: Seen) {
  let minRail = Number.POSITIVE_INFINITY;
  let peakSupply = Number.NEGATIVE_INFINITY;
  for (const frame of seen.read.frames) {
    const uno = frame.boards.uno;
    if (uno && uno.minVoltage < minRail) minRail = uno.minVoltage;
    const bench = frame.supplies.bench;
    if (bench && bench.maxCurrent > peakSupply) peakSupply = bench.maxCurrent;
  }
  const rad = seen.state.joints.arm?.shoulder ?? Number.NaN;
  return {
    minRail,
    peakSupply,
    deg: (rad * 180) / Math.PI,
    resets: seen.read.events.filter((event) => event.kind === "reset").length,
    reboots: seen.read.events.filter((event) => event.kind === "reboot").length,
  };
}

const dir = mkdtempSync(join(tmpdir(), "sfab-brownout-step-"));
try {
  cpSync(armDir, dir, { recursive: true });
  const base = JSON.parse(
    readFileSync(join(dir, "parts/sfab/arm-stall@1.0.0.json"), "utf8")
  );
  const at = new Map<number, ReturnType<typeof measure>>();
  for (const seconds of [0.001, 0.00001]) {
    const name = `stall-${String(seconds).replace(".", "p")}`;
    const file = `parts/sfab/${name}@1.0.0.json`;
    writeFileSync(
      join(dir, file),
      JSON.stringify({
        ...base,
        id: `sfab/${name}@1.0.0`,
        play: { ...base.play, timestep: seconds },
      })
    );
    const got = measure(await run(dir, file));
    at.set(seconds, got);
    console.log(
      `brownout-step: ${seconds * 1000} ms: rail min ${got.minRail.toFixed(3)} V, ` +
        `supply peak ${got.peakSupply.toFixed(3)} A, arm ${got.deg.toFixed(3)}°, ` +
        `${got.resets} resets, ${got.reboots} reboots`
    );
  }
  const coarse = at.get(0.001)!;
  const fine = at.get(0.00001)!;
  expect(fine.resets > 0, "the 0.01 ms reference never browned out");
  expect(
    coarse.resets === fine.resets && coarse.reboots === fine.reboots,
    `1 ms run reset ${coarse.resets}/${coarse.reboots} times, the reference ${fine.resets}/${fine.reboots}`
  );
  // The 1 ms rail undershoots by one 0.1 ms circuit sub-step of slew.
  expect(
    Math.abs(coarse.minRail - fine.minRail) < 0.2,
    `1 ms rail min ${coarse.minRail} V, the reference ${fine.minRail} V`
  );
  expect(
    Math.abs(coarse.deg - fine.deg) < 0.2,
    `1 ms arm ${coarse.deg}°, the reference ${fine.deg}°`
  );
  // The supply sits in its 0.3 A limit inside the step that trips. The
  // frame keeps that sub-step peak although the step ends with the servo open.
  expect(
    Math.abs(coarse.peakSupply - fine.peakSupply) < 1e-3,
    `1 ms supply peak ${coarse.peakSupply} A, the reference ${fine.peakSupply} A`
  );
  console.log(
    "brownout-step: a 1 ms brownout lands within 0.2 V and 0.2° of a 0.01 ms run"
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
