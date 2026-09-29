/** add-capture and remove-capture: a project part, a library part, undo, the counter, and a dependent rule. Copies only. */
import { deepStrictEqual, ok as expect } from "node:assert/strict";
import {
  cpSync,
  existsSync,
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

import type { EditOp, LockFile, PartFile } from "@sfab-bench/contract";
import {
  EditSession,
  formatPart,
  loadWorldV2,
  lockPathFor,
  type NeedsConfirm,
  nextCaptureRef,
  partStyle,
  writeLock,
} from "@sfab-bench/parts";

import { absolutePath, nodeStore } from "./world/node-store";
import { catalogRoot } from "./world/plan-host";

const SCENE = "parts/sfab/nano-servo-scene@1.0.0.json";
const SCENE_ID = "sfab/nano-servo-scene@1.0.0";
const ROOTS = [
  "parts/sfab/nano-servo-usb@1.0.0.json",
  "parts/sfab/nano-servo-collapsed@1.0.0.json",
];
const VCC = "parts/sfab/nano-vcc-usb@1.0.0.json";
const POWER = "sfab/nano-power-input@1.0.0";
const nanoDir = fileURLToPath(
  new URL("../../../examples/nano/", import.meta.url)
);
const catalog = absolutePath(catalogRoot());
const powerSnapshot = readFileSync(
  join(catalog, "snapshots/sfab/nano-power-input@1.0.0.json"),
  "utf8"
);
const libraryFile = join(catalog, "parts/sfab/nano-power-input@1.0.0.json");

function snapshotAs(_ref: string): string {
  return powerSnapshot;
}

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

function open(project: string, rel: string): EditSession {
  const file = join(project, rel);
  const opened = EditSession.open({
    file,
    names: [rel, file],
    store: nodeStore,
    catalogDir: catalog,
    assetRoot: project,
  });
  if ("error" in opened) throw new Error(opened.error);
  return opened;
}

function applied(result: unknown, what: string): void {
  const row = result as { error?: string; needsConfirm?: true };
  expect(!row.error && !row.needsConfirm, `${what}: ${JSON.stringify(row)}`);
}

function diagnostics(project: string, rel: string): string[] {
  return loadWorldV2(join(project, rel), {
    store: nodeStore,
    catalogDir: catalog,
    assetRoot: project,
  }).diagnostics.map((diag) => diag.message);
}

function copy(): string {
  const dir = mkdtempSync(join(tmpdir(), "capture-ops-"));
  cpSync(nanoDir, dir, { recursive: true });
  return dir;
}

const libraryBytes = readFileSync(libraryFile, "utf8");
const dirs: string[] = [];
try {
  // A project part: the variant goes into the part file.
  const one = copy();
  dirs.push(one);
  const before = treeOf(one);
  const scene = open(one, SCENE);
  const ref1 = nextCaptureRef(nodeStore, one, SCENE_ID, "behaviour");
  deepStrictEqual(ref1, "sfab/nano-servo-scene-behaviour-1@1.0.0");
  const add = (ref: string, variant: string): EditOp => ({
    kind: "add-capture",
    document: SCENE,
    axis: "behaviour",
    level: 2,
    variant,
    ref,
    snapshot: snapshotAs(ref),
    omits: ["dynamic response"],
  });
  applied(scene.apply(add(ref1 as string, "capture-1")), "add");
  const part = JSON.parse(readFileSync(join(one, SCENE), "utf8")) as PartFile;
  const slot = part.axes?.behaviour?.["2"];
  deepStrictEqual(slot?.default, "netlist");
  deepStrictEqual(slot?.variants["capture-1"], {
    kind: "snapshot",
    ref: ref1,
    omits: ["dynamic response"],
  });
  expect(
    existsSync(
      join(one, "snapshots/sfab/nano-servo-scene-behaviour-1@1.0.0.json")
    ),
    "the snapshot file is written"
  );
  const counterFile = join(one, "snapshots/.captures.json");
  deepStrictEqual(JSON.parse(readFileSync(counterFile, "utf8")), {
    "sfab/nano-servo-scene-behaviour@1.0.0": 1,
  });
  for (const root of ROOTS) {
    deepStrictEqual(diagnostics(one, root), [], `${root} loads with its lock`);
    const lock = JSON.parse(
      readFileSync(join(one, root.replace(".json", ".lock.json")), "utf8")
    ) as LockFile;
    const row = lock.parts.find((item) => item.id === SCENE_ID);
    expect(row, `${root} pins the scene`);
    expect(
      !lock.snapshots?.some((item) => item.id === ref1),
      "an unused capture is not pinned"
    );
  }
  const withOne = treeOf(one);

  // A stale or reused number is refused and writes nothing.
  const reused = scene.apply(add(ref1 as string, "capture-x"));
  expect("error" in reused, "a taken number is refused");
  deepStrictEqual(treeOf(one), withOne, "a refused add writes nothing");
  expect(
    "error" in
      scene.apply(add("sfab/nano-servo-scene-behaviour-2@1.0.0", "capture-1")),
    "a variant name clash is refused"
  );

  applied(scene.undo(), "undo add");
  deepStrictEqual(treeOf(one), before, "undo of add restores every byte");
  applied(scene.redo(), "redo add");
  deepStrictEqual(treeOf(one), withOne, "redo of add restores every byte");

  // Delete, and the number is not reused.
  const remove: EditOp = {
    kind: "remove-capture",
    document: SCENE,
    axis: "behaviour",
    level: 2,
    variant: "capture-1",
  };
  applied(scene.apply(remove), "remove");
  const removed = treeOf(one);
  expect(
    !existsSync(
      join(one, "snapshots/sfab/nano-servo-scene-behaviour-1@1.0.0.json")
    ),
    "the snapshot file is gone"
  );
  const gone = JSON.parse(readFileSync(join(one, SCENE), "utf8")) as PartFile;
  expect(
    !("capture-1" in (gone.axes?.behaviour?.["2"]?.variants ?? {})),
    "the variant is gone"
  );
  for (const root of ROOTS) deepStrictEqual(diagnostics(one, root), []);
  const ref2 = nextCaptureRef(nodeStore, one, SCENE_ID, "behaviour");
  deepStrictEqual(
    ref2,
    "sfab/nano-servo-scene-behaviour-2@1.0.0",
    "a deleted number is not reused"
  );
  applied(scene.undo(), "undo remove");
  deepStrictEqual(treeOf(one), withOne, "undo of remove restores every byte");
  applied(scene.redo(), "redo remove");
  deepStrictEqual(treeOf(one), removed);
  applied(scene.apply(add(ref2 as string, "capture-2")), "add after delete");
  expect(
    existsSync(
      join(one, "snapshots/sfab/nano-servo-scene-behaviour-2@1.0.0.json")
    ),
    "the second capture takes number 2"
  );

  // A library part: the variant goes into the project overlay.
  const two = copy();
  dirs.push(two);
  const vccBefore = treeOf(two);
  const vcc = open(two, VCC);
  const lref = nextCaptureRef(nodeStore, two, POWER, "behaviour") as string;
  deepStrictEqual(lref, "sfab/nano-power-input-behaviour-1@1.0.0");
  const overlayAdd: EditOp = {
    kind: "add-capture",
    document: VCC,
    part: POWER,
    axis: "behaviour",
    level: 1,
    variant: "capture-1",
    ref: lref,
    snapshot: snapshotAs(lref),
    omits: ["dynamic response"],
  };
  applied(vcc.apply(overlayAdd), "add to a library part");
  const overlayPath = join(
    two,
    "overlays/sfab/nano-power-input@1.0.0.levels.json"
  );
  const overlay = JSON.parse(readFileSync(overlayPath, "utf8")) as {
    axes: { behaviour: Record<string, { variants: Record<string, unknown> }> };
  };
  deepStrictEqual(Object.keys(overlay.axes.behaviour["1"]?.variants ?? {}), [
    "capture-1",
  ]);
  deepStrictEqual(
    readFileSync(libraryFile, "utf8"),
    libraryBytes,
    "the library file is untouched"
  );
  const lockOf = () =>
    JSON.parse(
      readFileSync(join(two, VCC.replace(".json", ".lock.json")), "utf8")
    ) as LockFile;
  expect(
    lockOf().overlays?.some((row) => row.id === POWER),
    "the root lock pins the overlay"
  );
  deepStrictEqual(diagnostics(two, VCC), []);
  const withOverlay = treeOf(two);

  applied(vcc.undo(), "undo overlay add");
  deepStrictEqual(
    treeOf(two),
    vccBefore,
    "undo removes the overlay and restores the lock"
  );
  applied(vcc.redo(), "redo overlay add");
  deepStrictEqual(treeOf(two), withOverlay);

  // Use it: a path rule selects the capture, so removing it needs confirmation.
  const vccFile = join(two, VCC);
  const vccText = readFileSync(vccFile, "utf8");
  const chosen = JSON.parse(vccText) as PartFile;
  (chosen.play as NonNullable<PartFile["play"]>).levels.paths = {
    "nano.power": { behaviour: { class: 1, variant: "capture-1" } },
  };
  writeFileSync(vccFile, formatPart(chosen, partStyle(vccText)));
  const pinned = loadWorldV2(vccFile, {
    store: nodeStore,
    catalogDir: catalog,
    assetRoot: two,
  }).lock as LockFile;
  writeLock(nodeStore, lockPathFor(vccFile), pinned);
  deepStrictEqual(diagnostics(two, VCC), []);
  expect(
    lockOf().snapshots?.some((row) => row.id === lref),
    "a running capture is pinned"
  );
  const using = treeOf(two);
  const overlayRemove: EditOp = {
    kind: "remove-capture",
    document: VCC,
    part: POWER,
    axis: "behaviour",
    level: 1,
    variant: "capture-1",
  };
  const asked = vcc.apply(overlayRemove) as NeedsConfirm;
  expect(asked.needsConfirm === true, "a selected variant needs confirmation");
  expect(asked.count === 1, `one dependent, got ${asked.count}`);
  expect(
    asked.ports[0]?.dependents[0]?.kind === "level" &&
      /capture-1/.test(asked.message ?? ""),
    `the answer names the rule: ${asked.message}`
  );
  deepStrictEqual(treeOf(two), using, "the question writes nothing");
  applied(vcc.apply({ ...overlayRemove, confirm: "break" }), "remove, break");
  expect(!existsSync(overlayPath), "an empty overlay file is removed");
  const vccPart = JSON.parse(readFileSync(join(two, VCC), "utf8")) as PartFile;
  deepStrictEqual(
    vccPart.play?.levels.paths?.["nano.power"],
    { behaviour: 1 },
    "the rule goes back to the level"
  );
  deepStrictEqual(diagnostics(two, VCC), []);
  expect(
    !lockOf().overlays && !lockOf().snapshots?.some((row) => row.id === lref),
    "the lock drops the overlay and the snapshot"
  );
  applied(vcc.undo(), "undo the break");
  deepStrictEqual(
    treeOf(two),
    using,
    "undo restores the rule, overlay, snapshot and lock"
  );
  deepStrictEqual(readFileSync(libraryFile, "utf8"), libraryBytes);
} finally {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

console.log(
  "capture ops: project part and library part, locks re-pinned, undo and redo byte-identical, number not reused, a selected variant asks first"
);
