/**
 * The snapshot ghost (layered-sim unit 3). The arm bench runs its SG90 in
 * detail (behaviour 2 on the gear-train body) and, beside it, the same
 * world with only the servo's behaviour on its group snapshot. Both runs
 * step together, so the gap between their shoulders is the snapshot's
 * error in this world.
 *
 * - The ghost is the snapshot run: its gap equals the gap to that world
 *   run on its own (C), frame for frame.
 * - The ghost does not move the run: the detailed run with a ghost ends
 *   where it ends without one.
 * - The gap is the snapshot's stated size: above zero, under 0.4°.
 * - A ghost that cannot run says why and leaves the run alone.
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
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import type {
  RecordingRead,
  WorldGhostSpec,
  WorldGhostState,
  WorldState,
} from "@sfab-bench/contract";
import { sha256Bytes } from "@sfab-bench/parts";
import { Sim } from "@sfab-bench/sim/sim";
import { projectReal, readerFor, readInside } from "./world/files";
import { parseWorldClient } from "./world/live-message";
import { packageVersion } from "./world/package-version";
import { nodePlanEnv } from "./world/plan-host";

const armDir = fileURLToPath(
  new URL("../../../examples/arm/", import.meta.url)
);

const RUN_MS = 3000;
const DEG = 180 / Math.PI;
const SNAPSHOT: WorldGhostSpec = { path: "servo", class: 1, variant: "group" };

type Run = {
  /** Shoulder angle per recorded frame, degrees. */
  joint: number[];
  end: number;
  ghost: WorldGhostState | null;
  /** How many posted states carried a ghost. */
  ghostStates: number;
  states: number;
  sim: Sim;
};

function newSim(box: { states: WorldState[] }): Sim {
  return new Sim({
    post(message) {
      if (message.type === "state") box.states.push(message.state);
    },
    now: () => performance.now(),
    schedule: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clear(handle: unknown) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
    sha256: sha256Bytes,
    versions: {
      mujoco: packageVersion("@mujoco/mujoco", import.meta.url),
      avr8js: packageVersion("avr8js", import.meta.url),
    },
    projectReal,
    readInside,
    readerFor,
    plan: nodePlanEnv,
    keepSerial: false,
  });
}

/** Runs the world for RUN_MS. The caller disposes `sim`. */
async function runWorld(
  project: string,
  world: string,
  ghost?: WorldGhostSpec
): Promise<Run> {
  const box: { states: WorldState[] } = { states: [] };
  const sim = newSim(box);
  const loaded = await sim.load({
    project,
    world,
    generation: 1,
    ...(ghost ? { ghost } : {}),
  });
  if (!loaded.ok) {
    throw new Error(loaded.errors.map((item) => item.message).join("; "));
  }
  await sim.step(RUN_MS);
  const state = sim.state();
  if (!state) throw new Error(`${world} has no state`);
  const body = sim.record({ op: "read", from: 0, to: state.simTime });
  if (body.op !== "read") throw new Error("no recording");
  const read = body.read as RecordingRead;
  const joint = read.frames.map(
    (frame) => (frame.joints.arm?.shoulder ?? Number.NaN) * DEG
  );
  return {
    joint,
    end: (state.joints.arm?.shoulder ?? Number.NaN) * DEG,
    ghost: sim.ghost(),
    ghostStates: box.states.filter((row) => row.ghost).length,
    states: box.states.length,
    sim,
  };
}

function shoulder(ghost: WorldGhostState | null) {
  if (!ghost || "error" in ghost) return null;
  return ghost.joints.find(
    (row) => row.robot === "arm" && row.joint === "shoulder"
  );
}

const dir = mkdtempSync(join(tmpdir(), "sfab-ghost-"));
const open: Sim[] = [];
try {
  cpSync(armDir, dir, { recursive: true });
  const parts = join(dir, "parts/sfab");
  const bench = JSON.parse(
    readFileSync(join(parts, "arm-bench@1.0.0.json"), "utf8")
  );
  const world = (name: string, levels: unknown) => {
    const copy = structuredClone(bench);
    copy.id = `sfab/${name}@1.0.0`;
    copy.play.levels = levels;
    writeFileSync(join(parts, `${name}@1.0.0.json`), JSON.stringify(copy));
    return `parts/sfab/${name}@1.0.0.json`;
  };
  // Detailed: the four sub-parts on the gear-train body.
  const detailed = world("ghost-gc", {
    default: 1,
    paths: { servo: { behaviour: 2, body: 2 } },
  });
  // What the ghost should be: the snapshot law on the same body.
  const snapshot = world("ghost-c", {
    default: 1,
    paths: { servo: { behaviour: { class: 1, variant: "group" }, body: 2 } },
  });

  const alone = await runWorld(dir, detailed);
  open.push(alone.sim);
  const c = await runWorld(dir, snapshot);
  open.push(c.sim);
  const both = await runWorld(dir, detailed, SNAPSHOT);
  open.push(both.sim);

  expect(alone.ghost === null, "no ghost asked, none carried");
  expect(
    alone.ghostStates === 0,
    `a run without a ghost posts no ghost: ${alone.ghostStates} states`
  );

  const ghost = both.ghost;
  expect(
    ghost && !("error" in ghost),
    `the ghost runs: ${JSON.stringify(ghost)}`
  );
  if (!ghost || "error" in ghost) throw new Error("unreachable");
  expect(
    ghost.path === "servo" && ghost.ref === "sfab/sg90-servo@1.0.0",
    `the ghost reads the servo's snapshot: ${ghost.path} ${ghost.ref} ${ghost.impl}`
  );
  expect(
    both.ghostStates === both.states && both.states > 0,
    `every posted state carries the ghost: ${both.ghostStates}/${both.states}`
  );
  expect(
    Object.keys(ghost.poses.arm ?? {}).length > 0,
    "the ghost carries the arm's link poses"
  );

  // The ghost does not move the run.
  expect(
    Math.abs(both.end - alone.end) < 1e-9,
    `the detailed run ends where it ends alone: ${both.end}° vs ${alone.end}°`
  );

  // The ghost is the snapshot world: same inputs, same answer.
  const row = shoulder(ghost);
  if (!row) throw new Error("the ghost has no shoulder row");
  const endGap = Math.abs(alone.end - c.end);
  expect(
    Math.abs(row.now * DEG - endGap) < 1e-9,
    `the ghost's gap now is the gap to the snapshot world: ${row.now * DEG}° vs ${endGap}°`
  );
  let framed = 0;
  for (let i = 0; i < Math.min(alone.joint.length, c.joint.length); i++) {
    const gap = Math.abs((alone.joint[i] ?? 0) - (c.joint[i] ?? 0));
    if (gap > framed) framed = gap;
  }
  const max = row.max * DEG;
  console.log(
    `ghost: servo → ${ghost.ref}; shoulder gap now ${(row.now * DEG).toFixed(3)}°, max ${max.toFixed(3)}° (each ms), ${framed.toFixed(3)}° (recorded frames); ${both.states} states`
  );
  expect(
    max >= framed - 1e-9,
    `the max over every ms covers the recorded frames: ${max}° vs ${framed}°`
  );
  expect(
    max > 0.01 && max < 0.4,
    `the ghost's gap is the stated error: ${max}°`
  );

  // Off again: a reload with null drops it.
  await both.sim.accept({ type: "reload", generation: 1, ghost: null });
  expect(both.sim.ghost() === null, "a reload with no ghost turns it off");

  // A ghost that cannot run says why. The run itself still runs.
  const box: { states: WorldState[] } = { states: [] };
  const bad = newSim(box);
  open.push(bad);
  const loaded = await bad.load({
    project: dir,
    world: detailed,
    generation: 1,
    ghost: { path: "servo", class: 2, variant: "netlist" },
  });
  const said = bad.ghost();
  expect(loaded.ok, "a ghost that cannot run leaves the run alone");
  expect(
    said !== null && "error" in said && /not a snapshot/.test(said.error),
    `a ghost on a detailed level says it is not a snapshot: ${JSON.stringify(said)}`
  );
  const missing = newSim(box);
  open.push(missing);
  await missing.load({
    project: dir,
    world: detailed,
    generation: 1,
    ghost: { path: "nope", class: 1, variant: "group" },
  });
  const none = missing.ghost();
  expect(
    none !== null && "error" in none && /no behaviour at nope/.test(none.error),
    `a ghost on a path that is not there says so: ${JSON.stringify(none)}`
  );

  // The socket message.
  const on = parseWorldClient(
    JSON.stringify({ type: "ghost", ghost: SNAPSHOT })
  );
  expect(
    !("error" in on) && on.type === "ghost" && on.ghost?.path === "servo",
    `a ghost message parses: ${JSON.stringify(on)}`
  );
  const off = parseWorldClient(JSON.stringify({ type: "ghost", ghost: null }));
  expect(
    !("error" in off) && off.type === "ghost" && off.ghost === null,
    "null turns the ghost off"
  );
  const wrong = parseWorldClient(
    JSON.stringify({ type: "ghost", ghost: { path: "servo", class: 7 } })
  );
  expect(
    "error" in wrong &&
      wrong.error ===
        "ghost must be null or a path, a level class 0 to 3, and a variant",
    `a bad ghost is refused in words: ${JSON.stringify(wrong)}`
  );
} finally {
  for (const sim of open) sim.dispose();
  rmSync(dir, { recursive: true, force: true });
}

console.log("ghost.selfcheck ok");
