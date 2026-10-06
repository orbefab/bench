/**
 * Replay golden. Every example root that has a firmware board runs headless
 * for a fixed simulated time, and the run is compared, channel by channel,
 * with its trace in `fixtures/traces/replay/` (see `trace.ts`).
 *
 * A trace keeps every recorded frame field as a channel, every recorded
 * event, the serial text per board, the end state and the warnings. Boards
 * keep their ids. A field the run gains is a new channel and does not fail
 * the check. A value that moves names the channel, the time and Δ.
 *
 * `--write` rewrites the traces. Do it only for a change that is meant to move
 * behaviour, never for a refactor. The diff then shows which channels moved.
 */

import { ok as expect } from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { recordingTrace, stateSample } from "./board-trace";
import { closeRootWatches } from "./projects";
import { headlessSim } from "./run";
import { checkTraceDir, type Trace } from "./trace";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const traceDir = fileURLToPath(
  new URL("../fixtures/traces/replay/", import.meta.url)
);
const write = process.argv.includes("--write");

/** Simulated milliseconds each world runs. */
const RUN_MS = 3000;

function exampleWorlds(): { project: string; world: string }[] {
  const worlds: { project: string; world: string }[] = [];
  const examples = join(root, "examples");
  for (const name of readdirSync(examples).sort()) {
    const dir = join(examples, name, "parts", "sfab");
    let files: string[];
    try {
      files = readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".json") || file.endsWith(".lock.json")) continue;
      const doc = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
        type?: string;
      };
      if (doc.type !== "assembly") continue;
      worlds.push({
        project: join(examples, name),
        world: `parts/sfab/${file}`,
      });
    }
  }
  return worlds;
}

/** `<example>/<file stem>`: the trace's name under `traceDir`. */
function traceName(target: { project: string; world: string }): string {
  const stem = target.world
    .split("/")
    .pop()!
    .replace(/\.json$/, "");
  return `${relative(join(root, "examples"), target.project)}/${stem}`;
}

function worldId(target: { project: string; world: string }): string {
  return `${relative(root, target.project)}/${target.world}`;
}

/** One world's trace, or null when the world has no firmware board. */
async function replay(target: {
  project: string;
  world: string;
}): Promise<Trace | null> {
  const sim = headlessSim();
  try {
    const loaded = await sim.load({ ...target, generation: 1 });
    if (!loaded.ok) return null;
    await sim.step(RUN_MS);
    const state = sim.state();
    if (!state) throw new Error(`${target.world}: no state`);
    if (Object.keys(state.boards).length === 0) return null;
    const body = sim.record({ op: "read", from: 0, to: state.simTime });
    if (body.op !== "read") throw new Error(`${target.world}: no recording`);
    const serial: Record<string, string> = {};
    for (const chunk of sim.drainSerial()) {
      serial[chunk.board] = (serial[chunk.board] ?? "") + chunk.text;
    }
    return recordingTrace({
      source: worldId(target),
      read: body.read,
      serial,
      samples: { end: stateSample(state) },
      warnings: sim.report()?.warnings ?? [],
    });
  } finally {
    sim.dispose();
  }
}

const traces = new Map<string, Trace>();
const skipped: string[] = [];
for (const target of exampleWorlds()) {
  const trace = await replay(target);
  if (trace) traces.set(traceName(target), trace);
  else skipped.push(worldId(target));
}
closeRootWatches();

const problems = checkTraceDir(traceDir, traces, write);
expect(problems.length === 0, `board replay moved:\n${problems.join("\n")}`);
expect(traces.size > 0, "at least one board world");
console.log(
  write
    ? `board-replay: wrote ${traces.size} traces (${skipped.length} roots have no board)`
    : `board-replay: ${traces.size} board worlds match their traces (${RUN_MS} ms each; ${skipped.length} roots have no board)`
);
