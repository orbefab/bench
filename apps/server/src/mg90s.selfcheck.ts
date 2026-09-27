/**
 * Plan, lock, and a 3 s run of the MG90S on a staged copy of the arm.
 * The fit lives in fit.selfcheck.ts. The temp directory is not part of
 * any result: the lock hash is the part's content hash, and the two
 * recordings are compared to each other.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { PartFile, RecordingRead } from "@sfab-bench/contract";

import { closeRootWatches } from "./projects";
import { attachWorld, readRecording, stepWorld, stopWorld } from "./world/host";
import { loadWorldV2 } from "./world/parts/load";
import { canonicalJson, contentHash } from "./world/parts/si";
import { catalogRoot, planWorld } from "./world/plan";

const armDir = fileURLToPath(
  new URL("../../../examples/arm/", import.meta.url)
);
const fixtureDir = fileURLToPath(
  new URL("../fixtures/mg90s/", import.meta.url)
);
const worldName = "mg90s.world.json";

function expect(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(label);
}

function num(value: unknown, label: string): number {
  expect(typeof value === "number", label);
  return value as number;
}

const part = JSON.parse(
  readFileSync(path.join(catalogRoot(), "parts/sfab/mg90s@1.0.0.json"), "utf8")
) as PartFile;
const datasheet = part.axes?.behaviour?.["1"]?.variants.datasheet;
expect(datasheet?.kind === "form", "mg90s law");
if (datasheet?.kind !== "form") throw new Error("unreachable");
const k = num(datasheet.params.K, "K");
const resistance = num(datasheet.params.R, "R");
const partHash = contentHash(part);

const root = mkdtempSync(path.join(tmpdir(), "sfab-mg90s-"));
cpSync(armDir, root, { recursive: true });
cpSync(path.join(fixtureDir, worldName), path.join(root, worldName));
cpSync(
  path.join(fixtureDir, "parts/sfab/mg90s-arm-scene@1.0.0.json"),
  path.join(root, "parts/sfab/mg90s-arm-scene@1.0.0.json")
);

try {
  const planned = planWorld(root, worldName);
  expect(
    planned.ok,
    planned.ok ? "" : planned.errors.map((error) => error.message).join("; ")
  );
  if (!planned.ok) throw new Error("unreachable");
  const servo = planned.plan.parts.find((item) => item.id === "servo");
  if (servo?.model !== "mg90s" || !servo.motor) {
    throw new Error(`servo model ${servo?.model ?? "missing"}`);
  }
  expect(
    servo.motor.k === k && servo.motor.resistance === resistance,
    "plan uses the MG90S law"
  );

  const worldFile = path.join(root, worldName);
  const opts = { catalogDir: catalogRoot(), assetRoot: root };
  const loaded = loadWorldV2(worldFile, opts);
  const again = loadWorldV2(worldFile, opts);
  const errors = loaded.diagnostics.filter((diag) => diag.severity === "error");
  expect(
    errors.length === 0 && loaded.lock !== null,
    errors.map((diag) => diag.message).join("; ") || "no lock"
  );
  if (!loaded.lock || !again.lock) throw new Error("unreachable");
  const lockJson = canonicalJson(loaded.lock);
  expect(lockJson === canonicalJson(again.lock), "lock is not stable");
  expect(!lockJson.includes(root), "lock depends on the temp path");
  const locked = loaded.lock.parts.find((row) => row.id === "sfab/mg90s@1.0.0");
  if (!locked || locked.sha256 !== partHash || locked.source !== "catalog") {
    throw new Error("lock does not pin the MG90S");
  }
  expect(
    loaded.lock.parts.every((row) => row.id !== "sfab/sg90@1.0.0"),
    "MG90S world locked an SG90"
  );
  console.log(`mg90s plan and lock: ${locked.sha256}`);

  async function runOnce(): Promise<RecordingRead> {
    const events: { type: string; message?: string }[] = [];
    const attached = await attachWorld(root, worldName, {
      sender: { kind: "loopback", label: "Mac" },
      onEvent(event) {
        if (event.type === "error") {
          events.push({
            type: event.type,
            message:
              event.message ??
              event.errors.map((item) => item.message).join("; "),
          });
        }
      },
    });
    if ("error" in attached) throw new Error(attached.error);
    try {
      const stepped = await stepWorld(root, worldName, 3000, {
        kind: "loopback",
        label: "Mac",
      });
      if ("error" in stepped) throw new Error(stepped.error);
      const read = await readRecording(root, worldName, { from: 0, to: 3 });
      if ("error" in read) throw new Error(read.error);
      const failed = events.find((event) => event.type === "error");
      expect(!failed, failed?.message ?? "world error");
      return read;
    } finally {
      attached.detach();
      await stopWorld(root, worldName);
      closeRootWatches();
    }
  }

  const first = await runOnce();
  const second = await runOnce();
  const payload = (read: RecordingRead) =>
    JSON.stringify({ frames: read.frames, events: read.events });
  const firstPayload = payload(first);
  expect(first.frames.length > 100, `mg90s frames ${first.frames.length}`);
  expect(firstPayload === payload(second), "mg90s runs are not byte-identical");
  expect(!firstPayload.includes(root), "run depends on the temp path");
  console.log(`mg90s run: 3 s, ${first.frames.length} frames, byte-identical`);
  console.log("mg90s.selfcheck ok");
} finally {
  await stopWorld(root, worldName);
  closeRootWatches();
  rmSync(root, { recursive: true, force: true });
}
