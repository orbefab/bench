/**
 * Node host for the capture runner. Provenance versions are read from
 * this package's manifest, the same strings the catalog snapshots name.
 */
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import type { RecordingRead, WorldState } from "@sfab-bench/contract";
import type { CaptureEnv } from "@sfab-bench/sim";

import { closeRootWatches } from "./projects";
import { attachWorld, readRecording, stopWorld } from "./world/host";
import { nodeStore } from "./world/node-store";
import { catalogRoot } from "./world/plan-host";

function benchVersions(): { version: string; mujoco: string; avr8js: string } {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  ) as { version: string; dependencies: Record<string, string> };
  return {
    version: pkg.version,
    mujoco: pkg.dependencies["@mujoco/mujoco"] ?? "unknown",
    avr8js: pkg.dependencies.avr8js ?? "unknown",
  };
}

async function runWorld(
  project: string,
  world: string,
  ms: number
): Promise<{ state: WorldState; read: RecordingRead }> {
  const seen: { state: WorldState | null; failed: string | null } = {
    state: null,
    failed: null,
  };
  const attached = await attachWorld(project, world, {
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
    return { state, read };
  } finally {
    attached.detach();
    await stopWorld(project, world);
    closeRootWatches();
  }
}

export const nodeCaptureEnv: CaptureEnv = {
  store: nodeStore,
  catalogDir: catalogRoot,
  examplesDir: () =>
    fileURLToPath(new URL("../../../examples/", import.meta.url)),
  now: () => performance.now(),
  readText: (file) => readFileSync(file, "utf8"),
  writeText: (file, text) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  },
  join: (...parts) => path.join(...parts),
  dirname: (file) => path.dirname(file),
  mkdir: (dir) => {
    mkdirSync(dir, { recursive: true });
  },
  copyTree: (from, to) => {
    cpSync(from, to, { recursive: true });
  },
  copyFile: (from, to) => {
    cpSync(from, to);
  },
  makeTemp: (prefix) => mkdtempSync(path.join(tmpdir(), prefix)),
  removeTree: (dir) => {
    rmSync(dir, { recursive: true, force: true });
  },
  runWorld,
  bench: benchVersions,
};
