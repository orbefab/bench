/** The socket's capture job: progress, landing, use it, undo, abort, and one job at a time. A copy only. */
import { deepStrictEqual, ok as expect } from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PartFile, WorldServerMessage } from "@sfab-bench/contract";
import { contentHash, loadWorldV2 } from "@sfab-bench/parts";

import { type CaptureFile, captureFromConfig } from "./capture";
import { closeRootWatches } from "./projects";
import {
  abortCapture,
  landingMessages,
  startCapture,
} from "./world/capture-job";
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

function request(
  nonce: string,
  at: string | undefined
): ReturnType<typeof parseWorldClient> {
  return parseWorldClient(
    JSON.stringify({ type: "capture", nonce, path: at, axis: "behaviour" })
  );
}

function launch(nonce: string, at: string | undefined = path): void {
  const parsed = request(nonce, at);
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
  expect(
    !abortCapture(project, WORLD, "gone", {}),
    "another socket cannot abort by nonce"
  );
  expect(
    abortCapture(project, WORLD, "gone", events),
    "the owner finds the running job"
  );
  const aborted = await settled("gone");
  deepStrictEqual(aborted, {
    type: "capture-failed",
    nonce: "gone",
    message: "aborted",
  });
  deepStrictEqual(treeOf(project), before, "an aborted capture writes nothing");
  deepStrictEqual(captureTemps(), tempsBefore, "temp directories are removed");
  expect(
    !abortCapture(project, WORLD, "gone", events),
    "no job is left to abort"
  );

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

  // A project part with its own recipe and fixture, selected inside a parent
  // world that is not that part: the variant lands in the part's own file.
  const RAIL = "local/rail@1.0.0";
  const railFile = join(project, "parts/local/rail@1.0.0.json");
  const catalog = absolutePath(catalogRoot());
  const source = JSON.parse(
    readFileSync(
      join(catalog, "parts", "sfab", "nano-power-input@1.0.0.json"),
      "utf8"
    )
  ) as PartFile & { capture?: unknown };
  if (!entry) throw new Error("no catalog entry to copy");
  const recipe = Object.fromEntries(
    Object.entries(entry).filter(([key]) => key !== "id" && key !== "part")
  );
  mkdirSync(join(project, "parts/local"), { recursive: true });
  mkdirSync(join(project, "fixtures/local"), { recursive: true });
  writeFileSync(
    railFile,
    `${JSON.stringify(
      {
        ...source,
        id: RAIL,
        capture: {
          behaviour: {
            ...recipe,
            sweep: { ...entry.sweep, fixture: "local/rail" },
            into: "1",
          },
        },
      },
      null,
      2
    )}\n`
  );
  cpSync(
    join(catalog, "fixtures", "sfab", "nano-power-input.fixture.json"),
    join(project, "fixtures/local/rail.fixture.json")
  );
  const added = parseWorldClient(
    JSON.stringify({
      type: "edit",
      ops: [{ kind: "add-instance", document: WORLD, id: "rail", part: RAIL }],
    })
  );
  if (!("type" in added) || added.type !== "edit") {
    throw new Error(`add-instance does not parse: ${JSON.stringify(added)}`);
  }
  const placed = await handleLiveEdit(project, WORLD, added);
  expect(
    placed.type === "edited",
    `the part is placed: ${JSON.stringify(placed)}`
  );
  const railPath = loadWorldV2(absolutePath(`${project}/${WORLD}`), {
    store: nodeStore,
    catalogDir: catalog,
    assetRoot: project,
  }).resolved.find((inst) => inst.part.id === RAIL)?.path;
  expect(railPath, "the world holds the project part");
  const lockFile = join(project, WORLD.replace(/\.json$/, ".lock.json"));
  const railBefore = treeOf(project);
  const railLockBefore = readFileSync(lockFile, "utf8");
  const railText = readFileSync(railFile, "utf8");
  expect(
    !JSON.stringify(JSON.parse(railText).axes).includes("capture-1"),
    "the part starts without a capture"
  );

  launch("p1", railPath);
  const projectDone = await settled("p1");
  expect(
    projectDone.type === "captured",
    `the project part captured: ${JSON.stringify(projectDone)}`
  );
  if (projectDone.type !== "captured") throw new Error("unreachable");
  deepStrictEqual(
    { ...projectDone, path: undefined },
    {
      type: "captured",
      nonce: "p1",
      path: undefined,
      axis: "behaviour",
      level: 1,
      variant: "capture-1",
      ref: "local/rail-behaviour-1@1.0.0",
    }
  );
  const railNow = JSON.parse(readFileSync(railFile, "utf8")) as PartFile;
  expect(
    railNow.axes?.behaviour?.["1"]?.variants["capture-1"]?.kind === "snapshot",
    "the variant is in the part's own document"
  );
  expect(
    railNow.axes?.behaviour?.["1"]?.default ===
      source.axes?.behaviour?.["1"]?.default,
    "the default is untouched"
  );
  expect(
    existsSync(join(project, "snapshots/local/rail-behaviour-1@1.0.0.json")),
    "the snapshot is in the project's snapshots"
  );
  expect(
    !existsSync(join(project, "overlays/local")),
    "a project part needs no overlay"
  );
  const lockNow = readFileSync(lockFile, "utf8");
  expect(lockNow !== railLockBefore, "the parent's lock is re-pinned");
  const pinned = (
    JSON.parse(lockNow) as { parts: { id: string; sha256: string }[] }
  ).parts.find((row) => row.id === RAIL);
  deepStrictEqual(
    pinned?.sha256,
    contentHash(JSON.parse(readFileSync(railFile, "utf8"))),
    "the lock pins the part's new bytes"
  );
  const undoRail = await handleLiveEdit(project, WORLD, {
    type: "undo",
    part: RAIL,
  });
  expect(
    undoRail.type === "edited",
    `undo of the capture: ${JSON.stringify(undoRail)}`
  );
  deepStrictEqual(
    treeOf(project),
    railBefore,
    "undo restores every byte of the part, snapshot, counter and lock"
  );

  // No real path fails the restart after the edit passed its own load check, so
  // the mapping from the edit's answer to the client's messages is tested directly.
  const wrote: WorldServerMessage = {
    type: "captured",
    nonce: "m",
    path: "rail",
    axis: "behaviour",
    level: 1,
    variant: "capture-1",
    ref: "local/rail-behaviour-1@1.0.0",
  };
  deepStrictEqual(
    landingMessages(
      { error: "world is not running", runFault: true },
      wrote,
      "m"
    ),
    [wrote, { type: "error", errors: [], message: "world is not running" }],
    "a landed capture whose run fails is captured, then the run error"
  );
  deepStrictEqual(
    landingMessages(
      { error: "the document changed outside this session" },
      wrote,
      "m"
    ),
    [
      {
        type: "capture-failed",
        nonce: "m",
        message: "the document changed outside this session",
      },
    ],
    "a refused edit wrote nothing and is capture-failed"
  );
  deepStrictEqual(
    landingMessages(
      { needsConfirm: true, count: 1, ports: [], message: "sure?" },
      wrote,
      "m"
    ),
    [{ type: "capture-failed", nonce: "m", message: "sure?" }],
    "a confirmation nobody can give is capture-failed"
  );
} finally {
  attached.detach();
  await stopWorld(project, WORLD);
  closeRootWatches();
  rmSync(project, { recursive: true, force: true });
}

console.log(
  "capture socket: progress, captured after edited, use it and undo, abort writes nothing, a second job is refused, card snapshot byte-identical to the CLI's"
);
