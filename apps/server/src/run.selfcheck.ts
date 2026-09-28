/**
 * `sfab-bench run` on the gauge, against the same span the recording reads.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { RecordingRead, WorldSender } from "@sfab-bench/contract";

import { closeRootWatches } from "./projects";
import { attachWorld, readRecording, stepWorld, stopWorld } from "./world/host";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const gaugeDir = join(root, "examples/gauge");
const world = "gauge-usb.world.json";
const ms = 3000;
const bin = fileURLToPath(new URL("../bin/sfab-bench.mjs", import.meta.url));

function expect(cond: unknown, label: string) {
  if (!cond) throw new Error(label);
}

function recordedLines(read: RecordingRead): string[] {
  const pending = new Map<string, string>();
  const lines: string[] = [];
  for (const event of read.events) {
    if (event.kind !== "serial") continue;
    const buf = (pending.get(event.board) ?? "") + (event.text ?? "");
    const parts = buf.split("\n");
    pending.set(event.board, parts.pop() ?? "");
    for (const part of parts) {
      const line = part.replace(/\r$/, "").trim();
      if (line.length > 0 && line !== "boot")
        lines.push(`${event.board}: ${line}`);
    }
  }
  for (const [board, rest] of pending) {
    const line = rest.replace(/\r$/, "").trim();
    if (line.length > 0 && line !== "boot") lines.push(`${board}: ${line}`);
  }
  return lines;
}

function cliLines(stdout: string): string[] {
  const lines: string[] = [];
  for (const raw of stdout.split("\n")) {
    // Seam totals are not serial. The gauge has a motor, so `bench run` prints one.
    if (raw.startsWith("seam ")) continue;
    const match = /^([^:]+): (.*)$/.exec(raw);
    if (!match?.[1] || match[2] === undefined) continue;
    const line = match[2].trim();
    if (line.length > 0 && line !== "boot") lines.push(`${match[1]}: ${line}`);
  }
  return lines;
}

const sender: WorldSender = { kind: "loopback", label: "Mac" };
const attached = await attachWorld(gaugeDir, world, { sender, onEvent() {} });
if ("error" in attached) throw new Error(attached.error);
let recorded: string[];
try {
  const stepped = await stepWorld(gaugeDir, world, ms, sender);
  if ("error" in stepped) throw new Error(stepped.error);
  const read = await readRecording(gaugeDir, world, { from: 0, to: ms / 1000 });
  if ("error" in read) throw new Error(read.error);
  recorded = recordedLines(read);
} finally {
  attached.detach();
  await stopWorld(gaugeDir, world);
  closeRootWatches();
}

const child = spawnSync(
  process.execPath,
  [bin, "run", gaugeDir, world, "--ms", String(ms)],
  {
    encoding: "utf8",
    cwd: root,
    env: process.env,
    timeout: 120_000,
  }
);
if (child.status !== 0) {
  throw new Error(
    `bench run exited ${child.status}: ${child.stderr || child.stdout}`
  );
}
const printed = cliLines(child.stdout);
expect(recorded.length > 0, "gauge recording has no nano serial");
expect(
  printed.join("\n") === recorded.join("\n"),
  `bench run serial differs from the recording\ncli:\n${printed.join("\n")}\nrecording:\n${recorded.join("\n")}`
);
expect(
  /^\d+\.\d{3} s, \d+ frames, \d+ resets$/m.test(child.stdout),
  "bench run summary line"
);
console.log(
  `bench run gauge-usb: serial matches the 3000 ms recording (${printed.length} lines)`
);
