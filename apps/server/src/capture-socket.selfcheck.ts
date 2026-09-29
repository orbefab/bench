/** The socket's capture job: progress, landing, use it, undo, abort, and one job at a time. A copy only. */
import { deepStrictEqual, ok as expect } from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PartFile, WorldServerMessage } from "@sfab-bench/contract";
import { loadWorldV2 } from "@sfab-bench/parts";

import { type CaptureFile, captureFromConfig } from "./capture";
import { closeRootWatches } from "./projects";
import { abortCapture, startCapture } from "./world/capture-job";
import { handleLiveEdit } from "./world/edit";
import { attachWorld, stopWorld } from "./world/host";
import { parseWorldClient } from "./world/live-message";
import { absolutePath, nodeStore } from "./world/node-store";
import { catalogRoot } from "./world/plan-host";

const WORLD = "parts/sfab/nano-vcc-usb@1.0.0.json";
const POWER = "sfab/nano-power-input@1.0.0";
const SNAPSHOT = "snapshots/sfab/nano-power-input-behaviour-1@1.0.0.json";
const nanoDir = fileURLToPath(
  new URL("../../../examples/nano/", import.meta.url)
);
const project = mkdtempSync(join(tmpdir(), "capture-socket-"));
cpSync(nanoDir, project, { recursive: true });

function treeOf(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (folder: string) => {
    for (const name of readdirSync(folder)) {
      const child = join(folder, name);
      if (statSync(child).isDirectory()) walk(child);
      else out.set(child.slice(dir.length), readFileSync(child, "utf8"));
    }
  };
  walk(dir);
  return out;
}

const captureTemps = () =>
  readdirSync(tmpdir()).filter((name) => name.startsWith("sfab-capture-"));

const events: WorldServerMessage[] = [];
const attached = await attachWorld(project, WORLD, {
  sender: { kind: "loopback", label: "Mac" },
  onEvent: (event) => events.push(event),
});
if ("error" in attached) throw new Error(attached.error);

const loaded = loadWorldV2(absolutePath(`${project}/${WORLD}`), {
  store: nodeStore,
  catalogDir: absolutePath(catalogRoot()),
  assetRoot: project,
});
const path = loaded.resolved.find((inst) => inst.part.id === POWER)?.path;
expect(path, "the world holds a nano-power-input");

function request(nonce: string): ReturnType<typeof parseWorldClient> {
  return parseWorldClient(
    JSON.stringify({ type: "capture", nonce, path, axis: "behaviour" })
  );
}

function launch(nonce: string): void {
  const parsed = request(nonce);
  expect(
    "type" in parsed && parsed.type === "capture",
    "the capture message parses"
  );
  if (!("type" in parsed) || parsed.type !== "capture") return;
  startCapture(project, WORLD, parsed, events, (event) => events.push(event));
}

async function settled(nonce: string): Promise<WorldServerMessage> {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const hit = events.find(
      (event) =>
        (event.type === "captured" || event.type === "capture-failed") &&
        event.nonce === nonce
    );
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`capture ${nonce} did not finish`);
}

try {
  deepStrictEqual(
    parseWorldClient(
      JSON.stringify({ type: "capture", nonce: "x", path, axis: "visual" })
    ),
    {
      error: "capture axis must be behaviour or body",
      kind: "capture",
      nonce: "x",
    }
  );
  const before = treeOf(project);
  const tempsBefore = captureTemps();

  // Abort: nothing is written and no temp directory stays behind.
  launch("gone");
  expect(abortCapture(project, WORLD, "gone"), "the running job is found");
  const aborted = await settled("gone");
  deepStrictEqual(aborted, {
    type: "capture-failed",
    nonce: "gone",
    message: "aborted",
  });
  deepStrictEqual(treeOf(project), before, "an aborted capture writes nothing");
  deepStrictEqual(captureTemps(), tempsBefore, "temp directories are removed");
  expect(!abortCapture(project, WORLD, "gone"), "no job is left to abort");

  // Capture, and a second request while it runs is refused.
  launch("c1");
  launch("c2");
  const refused = events.find(
    (event) => event.type === "capture-failed" && event.nonce === "c2"
  );
  expect(
    refused?.type === "capture-failed" &&
      /already running/.test(refused.message),
    "a second capture is refused with a reason"
  );
  const done = await settled("c1");
  expect(done.type === "captured", `captured, got ${JSON.stringify(done)}`);
  if (done.type !== "captured") throw new Error("unreachable");
  deepStrictEqual(
    { ...done, ref: undefined },
    {
      type: "captured",
      nonce: "c1",
      path,
      axis: "behaviour",
      level: 1,
      variant: "capture-1",
      ref: undefined,
    }
  );
  deepStrictEqual(done.ref, "sfab/nano-power-input-behaviour-1@1.0.0");
  const progress = events.filter(
    (event) => event.type === "capture-progress" && event.nonce === "c1"
  );
  expect(progress.length > 0, "progress was reported");
  for (const row of progress) {
    expect(
      row.type === "capture-progress" && row.done <= row.total && row.label,
      "progress counts up to a total and names its step"
    );
  }
  const editedAt = events.findIndex((event) => event.type === "edited");
  expect(
    editedAt >= 0 && editedAt < events.indexOf(done),
    "the edit is announced before captured"
  );
  expect(existsSync(join(project, SNAPSHOT)), "the snapshot file exists");
  expect(
    existsSync(
      join(project, "overlays/sfab/nano-power-input@1.0.0.levels.json")
    ),
    "the level overlay exists"
  );
  expect(
    loadWorldV2(absolutePath(`${project}/${WORLD}`), {
      store: nodeStore,
      catalogDir: absolutePath(catalogRoot()),
      assetRoot: project,
    }).diagnostics.every((diag) => diag.severity !== "error"),
    "the world still loads"
  );
  const captured = treeOf(project);

  // Use it, then undo that, then undo the capture.
  const use = parseWorldClient(
    JSON.stringify({
      type: "edit",
      ops: [
        {
          kind: "set-level",
          document: WORLD,
          scope: "path",
          key: "nano.power",
          axis: "behaviour",
          class: 1,
          variant: "capture-1",
        },
      ],
    })
  );
  if (!("type" in use) || use.type !== "edit") {
    throw new Error(`use it does not parse: ${JSON.stringify(use)}`);
  }
  const used = await handleLiveEdit(project, WORLD, use);
  expect(used.type === "edited", `use it lands: ${JSON.stringify(used)}`);
  const rule = (
    JSON.parse(readFileSync(join(project, WORLD), "utf8")) as PartFile
  ).play?.levels.paths?.["nano.power"];
  expect(
    JSON.stringify(rule).includes("capture-1"),
    "the path rule names the capture"
  );
  const undoUse = await handleLiveEdit(project, WORLD, { type: "undo" });
  expect(undoUse.type === "edited", "undo of use it");
  deepStrictEqual(
    treeOf(project),
    captured,
    "undo of use it keeps the capture"
  );
  const undoCapture = await handleLiveEdit(project, WORLD, { type: "undo" });
  expect(undoCapture.type === "edited", "undo of the capture");
  deepStrictEqual(
    treeOf(project),
    before,
    "undo of the capture restores every byte"
  );

  // Card equals CLI: the runner with an output file writes the same bytes.
  const config = JSON.parse(
    readFileSync(
      join(absolutePath(catalogRoot()), "fixtures", "capture.config.json"),
      "utf8"
    )
  ) as CaptureFile;
  const entry = config.entries.find((row) => row.part === POWER);
  expect(entry, "the catalog has a nano-power-input entry");
  const tmp = mkdtempSync(join(tmpdir(), "capture-cli-"));
  try {
    const out = join(tmp, "cli.json");
    await captureFromConfig({
      config: { ...config, entries: entry ? [entry] : [] },
      outFile: out,
    });
    const cli = readFileSync(out, "utf8");
    expect(
      cli === captured.get(`/${SNAPSHOT}`),
      "the card's snapshot is byte-identical to the CLI's"
    );
    expect(
      cli.includes('"created": "2026-09-27T00:00:00.000Z"'),
      "created is the config's"
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
} finally {
  attached.detach();
  await stopWorld(project, WORLD);
  closeRootWatches();
  rmSync(project, { recursive: true, force: true });
}

console.log(
  "capture socket: progress, captured after edited, use it and undo, abort writes nothing, a second job is refused, card snapshot byte-identical to the CLI's"
);
