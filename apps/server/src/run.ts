/**
 * Headless world run. In-process `Sim`, no worker thread and no port.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

import type { WorldState } from "@sfab-bench/contract";
import { sha256Bytes } from "@sfab-bench/parts";
import { type FromWorker, Sim } from "@sfab-bench/sim/sim";

import { projectReal, readerFor, readInside } from "./world/files";
import { installPlanHost } from "./world/plan-host";

const require = createRequire(import.meta.url);

/** World v2 has no duration. This is the span when `--ms` is omitted. */
export const DEFAULT_RUN_MS = 3000;

function packageVersion(name: string): string {
  try {
    let dir = dirname(require.resolve(name));
    for (let hop = 0; hop < 6; hop++) {
      const pkgPath = join(dir, "package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === name) return pkg.version ?? "unknown";
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* the manifest says unknown rather than failing the run */
  }
  return "unknown";
}

export type RunLine = { board: string; line: string };

export type RunResult = {
  lines: RunLine[];
  simSeconds: number;
  frames: number;
  resets: number;
};

export function formatRun(result: RunResult): string {
  const lines = result.lines.map((row) => `${row.board}: ${row.line}`);
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
  installPlanHost();
  const lines: RunLine[] = [];
  const pending = new Map<string, string>();
  const box: {
    failed: string | null;
    state: WorldState | null;
    frames: number;
  } = {
    failed: null,
    state: null,
    frames: 0,
  };
  const sim = new Sim({
    post(message: FromWorker) {
      if (message.type === "error") {
        box.failed =
          message.message ??
          (message.errors.map((error) => error.message).join("; ") ||
            "world failed");
        return;
      }
      if (message.type === "serial") {
        for (const chunk of message.chunks)
          takeLines(chunk.board, chunk.text, pending, lines);
        return;
      }
      if (message.type === "state") box.state = message.state;
      if (message.type === "record" && message.body.op === "read") {
        box.frames = message.body.read.frames.length;
      }
      if (message.type === "record" && message.body.op === "error") {
        box.failed = message.body.message;
      }
    },
    now: () => performance.now(),
    schedule: (fn, ms) => setTimeout(fn, ms),
    clear(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
    ledTrace: false,
    sha256: sha256Bytes,
    versions: {
      mujoco: packageVersion("@mujoco/mujoco"),
      avr8js: packageVersion("avr8js"),
    },
    projectReal,
    readInside,
    readerFor,
  });
  const generation = 1;
  try {
    await sim.accept({
      type: "load",
      project: opts.project,
      world: opts.world,
      generation,
    });
    if (box.failed) throw new Error(box.failed);
    await sim.accept({ type: "step", n: opts.ms, generation });
    if (box.failed) throw new Error(box.failed);
    const settled = box.state;
    if (!settled) throw new Error("world produced no state");
    const simSeconds = settled.simTime;
    await sim.accept({
      type: "record",
      generation,
      request: 1,
      query: { op: "read", from: 0, to: simSeconds },
    });
    if (box.failed) throw new Error(box.failed);
    flushLines(pending, lines);
    return { lines, simSeconds, frames: box.frames, resets: resetsOf(settled) };
  } finally {
    await sim.accept({ type: "stop" });
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
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
