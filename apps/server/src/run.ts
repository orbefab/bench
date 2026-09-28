/**
 * Headless world run. In-process `Sim`, no worker thread and no port.
 */
import { performance } from "node:perf_hooks";

import type { SeamEnergy, WorldState } from "@sfab-bench/contract";
import { healTornWrite, sha256Bytes } from "@sfab-bench/parts";
import { seamLine } from "@sfab-bench/sim/seams";
import { type LoadResult, Sim } from "@sfab-bench/sim/sim";

import {
  projectReal,
  readerFor,
  readInside,
  resolveInside,
} from "./world/files";
import { nodeStore } from "./world/node-store";
import { packageVersion } from "./world/package-version";
import { nodePlanEnv } from "./world/plan-host";

/** World v2 has no duration. This is the span when `--ms` is omitted. */
export const DEFAULT_RUN_MS = 3000;

export type RunLine = { board: string; line: string };

export type RunResult = {
  lines: RunLine[];
  simSeconds: number;
  frames: number;
  resets: number;
  degraded: { path: string; message: string }[];
  seams: SeamEnergy[];
};

export function formatRun(result: RunResult): string {
  const lines = result.degraded.map(
    (row) => `degraded ${row.path}: ${row.message}`
  );
  lines.push(...result.lines.map((row) => `${row.board}: ${row.line}`));
  lines.push(...result.seams.map((row) => seamLine(row)));
  lines.push(
    `${result.simSeconds.toFixed(3)} s, ${result.frames} frames, ${result.resets} resets`
  );
  return lines.join("\n");
}

function takeLines(
  board: string,
  text: string,
  pending: Map<string, string>,
  lines: RunLine[]
) {
  const buf = (pending.get(board) ?? "") + text;
  const parts = buf.split("\n");
  pending.set(board, parts.pop() ?? "");
  for (const part of parts) {
    const line = part.replace(/\r$/, "").trim();
    if (line.length > 0) lines.push({ board, line });
  }
}

function flushLines(pending: Map<string, string>, lines: RunLine[]) {
  for (const [board, rest] of pending) {
    const line = rest.replace(/\r$/, "").trim();
    if (line.length > 0) lines.push({ board, line });
  }
  pending.clear();
}

function loadError(result: Extract<LoadResult, { ok: false }>): string {
  if (result.message && result.message.length > 0) return result.message;
  const text = result.errors
    .map((error) => error.message)
    .filter((line) => line.length > 0)
    .join("; ");
  return text.length > 0 ? text : "world failed";
}

function resetsOf(state: WorldState): number {
  let resets = 0;
  for (const board of Object.values(state.boards)) resets += board.resets ?? 0;
  return resets;
}

export async function runHeadless(opts: {
  project: string;
  world: string;
  ms: number;
}): Promise<RunResult> {
  const root = projectReal(opts.project);
  if (root) {
    const file = resolveInside(root, opts.world);
    if (file) {
      const healed = healTornWrite(nodeStore, file);
      if (healed) throw new Error(healed.error);
    }
  }
  const lines: RunLine[] = [];
  const pending = new Map<string, string>();
  const sim = new Sim({
    post() {
      /* serial is drained below; the seam line reads the ledger */
    },
    now: () => performance.now(),
    schedule: (fn, ms) => setTimeout(fn, ms),
    clear(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
    ledTrace: false,
    sha256: sha256Bytes,
    versions: {
      mujoco: packageVersion("@mujoco/mujoco", import.meta.url),
      avr8js: packageVersion("avr8js", import.meta.url),
    },
    projectReal,
    readInside,
    readerFor,
    plan: nodePlanEnv,
    keepSerial: true,
  });
  try {
    const loaded = await sim.load({
      project: opts.project,
      world: opts.world,
      generation: 1,
    });
    if (!loaded.ok) throw new Error(loadError(loaded));
    await sim.step(opts.ms);
    const settled = sim.state();
    if (!settled) throw new Error("world produced no state");
    const body = sim.record({ op: "read", from: 0, to: settled.simTime });
    if (body.op === "error") throw new Error(body.message);
    if (body.op !== "read") throw new Error("world produced no recording");
    for (const chunk of sim.drainSerial()) {
      takeLines(chunk.board, chunk.text, pending, lines);
    }
    flushLines(pending, lines);
    return {
      lines,
      simSeconds: settled.simTime,
      frames: body.read.frames.length,
      resets: resetsOf(settled),
      degraded: (settled.diagnostics ?? []).map((row) => ({
        path: row.path,
        message: row.message,
      })),
      seams: sim.seams(),
    };
  } finally {
    sim.dispose();
  }
}

export async function runCli(opts: {
  project: string;
  world: string;
  ms: number;
}): Promise<void> {
  try {
    const result = await runHeadless(opts);
    process.stdout.write(`${formatRun(result)}\n`);
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    console.error(text.length > 0 ? text : "bench run failed");
    process.exit(1);
  }
}
