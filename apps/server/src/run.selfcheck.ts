/**
 * `sfab-bench run` on the gauge, against the same span the recording reads.
 */
import { ok as expect } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { RecordingRead, WorldSender } from "@sfab-bench/contract";

import { closeRootWatches } from "./projects";
import { runHeadless } from "./run";
import { attachWorld, readRecording, stepWorld, stopWorld } from "./world/host";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const gaugeDir = join(root, "examples/gauge");
const world = "parts/sfab/gauge-usb@1.0.0.json";
const ms = 3000;
const bin = fileURLToPath(new URL("../bin/sfab-bench.mjs", import.meta.url));

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

// One step call is capped at 60 s of sim time. A longer run still runs.
{
  const dir = mkdtempSync(join(tmpdir(), "sfab-run-long-"));
  try {
    const none = {
      "0": { default: "none", variants: { none: { kind: "none" } } },
    };
    mkdirSync(join(dir, "parts", "sfab"), { recursive: true });
    writeFileSync(
      join(dir, "parts", "sfab", "long@1.0.0.json"),
      JSON.stringify({
        format: "sfab.part@1",
        id: "sfab/long@1.0.0",
        type: "assembly",
        play: { seed: 1, levels: { default: 1 } },
        axes: {
          behaviour: {
            "1": {
              default: "netlist",
              variants: {
                netlist: {
                  kind: "composite",
                  omits: ["test scene"],
                  netlist: {
                    instances: {
                      bench: { part: "sfab/bench-supply@1.0.0" },
                      r: {
                        part: "sfab/resistor@1.0.0",
                        params: { R: 1000 },
                      },
                    },
                    wires: [
                      ["bench.5V", "r.A"],
                      ["bench.GND", "r.B"],
                    ],
                    expose: {},
                  },
                },
              },
            },
          },
          body: none,
          visual: none,
        },
      })
    );
    const long = await runHeadless({
      project: dir,
      world: "parts/sfab/long@1.0.0.json",
      ms: 60_001,
    });
    expect(
      Math.round(long.simSeconds * 1000) === 60_001,
      `a 60 001 ms run stopped at ${long.simSeconds} s`
    );
    console.log(`bench run past the step cap: ${long.simSeconds.toFixed(3)} s`);
    // A span the chunks cannot cover is refused before the first step.
    const half = await runHeadless({
      project: dir,
      world: "parts/sfab/long@1.0.0.json",
      ms: 60_000.5,
    }).then(
      () => "",
      (error: unknown) => String(error)
    );
    expect(
      half.includes("whole number of ms"),
      `a 60 000.5 ms run was not refused up front: ${half}`
    );
    console.log("bench run: 60 000.5 ms refused before stepping");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
