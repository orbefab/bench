/**
 * Rename part file, and a leaf opened as the root.
 * Copies only. The examples stay untouched.
 */
import { ok as expect } from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import type { LockFile, PartFile } from "@sfab-bench/contract";
import { SNAPSHOT_FORMAT } from "@sfab-bench/contract";
import {
  EditSession,
  EXTERNAL_EDIT,
  loadWorldV2,
  planPartRename,
} from "@sfab-bench/parts";
import { viewOf } from "@sfab-bench/sim/view";

import { closeRootWatches } from "./projects";
import {
  applyDocumentEdit,
  handleLiveEdit,
  historiesForConnect,
} from "./world/edit";
import { stopWorld, worldWorkerCount } from "./world/host";
import { parseWorldClient } from "./world/live-message";
import { absolutePath, nodeStore } from "./world/node-store";
import { catalogRoot, planWorld } from "./world/plan";

const SCENE = "parts/sfab/nano-servo-scene@1.0.0.json";
const SCENE_ID = "sfab/nano-servo-scene@1.0.0";
const NEXT_SCENE = "parts/sfab/servo-scene@1.0.0.json";
const NEXT_ID = "sfab/servo-scene@1.0.0";
const USB = "parts/sfab/nano-servo-usb@1.0.0.json";
const COLLAPSED = "parts/sfab/nano-servo-collapsed@1.0.0.json";
const USB_NEXT = "parts/sfab/usb-rig@1.0.0.json";
const nanoDir = fileURLToPath(
  new URL("../../../examples/nano/", import.meta.url)
);
const armDir = fileURLToPath(
  new URL("../../../examples/arm/", import.meta.url)
);
const catalogLed = fileURLToPath(
  new URL("../catalog/parts/sfab/led-red@1.0.0.json", import.meta.url)
);

function copyNano(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cpSync(nanoDir, dir, { recursive: true });
  return dir;
}

function textOf(project: string, rel: string): string {
  return readFileSync(join(project, rel), "utf8");
}

function treeOf(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (folder: string) => {
    for (const name of readdirSync(folder)) {
      const child = join(folder, name);
      if (statSync(child).isDirectory()) {
        walk(child);
        continue;
      }
      out.set(
        relative(dir, child).split("\\").join("/"),
        readFileSync(child, "utf8")
      );
    }
  };
  walk(dir);
  return out;
}

function sameTree(
  a: Map<string, string>,
  b: Map<string, string>,
  label: string
) {
  expect(a.size === b.size, `${label} file count ${a.size} vs ${b.size}`);
  for (const [path, text] of a) {
    expect(b.get(path) === text, `${label} differs at ${path}`);
  }
}

function open(
  project: string,
  world: string,
  libraryDir?: string
): EditSession {
  const file = absolutePath(join(project, world));
  const opened = EditSession.open({
    file,
    names: [world, file],
    store: nodeStore,
    catalogDir: absolutePath(catalogRoot()),
    assetRoot: absolutePath(project),
    ...(libraryDir ? { libraryDir: absolutePath(libraryDir) } : {}),
  });
  if ("error" in opened) throw new Error(opened.error);
  return opened;
}

function lockRows(project: string, world: string): LockFile["parts"] {
  const parsed = JSON.parse(
    textOf(project, world.replace(/\.json$/, ".lock.json"))
  ) as LockFile;
  return parsed.parts;
}

function rowIds(rows: LockFile["parts"]): string[] {
  return rows.map((row) => row.id).sort();
}

function proveScene() {
  const project = copyNano("sfab-rename-scene-");
  try {
    const snapRel = "snapshots/sfab/scene-shot.json";
    const snap = {
      format: SNAPSHOT_FORMAT,
      part: SCENE_ID,
      provenance: { from: { part: SCENE_ID } },
    };
    mkdirSync(join(project, "snapshots/sfab"), { recursive: true });
    writeFileSync(join(project, snapRel), `${JSON.stringify(snap, null, 2)}\n`);
    const before = treeOf(project);
    const session = open(project, SCENE);
    const applied = session.apply({
      kind: "rename-part",
      document: SCENE,
      to: "servo-scene",
    });
    if ("error" in applied || "needsConfirm" in applied) {
      throw new Error("error" in applied ? applied.error : "needs confirm");
    }
    expect(existsSync(join(project, NEXT_SCENE)), "new scene file");
    expect(!existsSync(join(project, SCENE)), "old scene file remains");
    const next = JSON.parse(textOf(project, NEXT_SCENE)) as PartFile;
    expect(next.id === NEXT_ID, `scene id ${next.id}`);
    for (const parent of [USB, COLLAPSED]) {
      const body = textOf(project, parent);
      expect(body.includes(NEXT_ID), `${parent} missed the new id`);
      expect(!body.includes(SCENE_ID), `${parent} kept the old id`);
    }
    for (const parent of [USB, COLLAPSED]) {
      const oldLock = JSON.parse(
        before.get(parent.replace(/\.json$/, ".lock.json")) ?? ""
      ) as LockFile;
      const now = lockRows(project, parent);
      const mapped = oldLock.parts.map((row) =>
        row.id === SCENE_ID ? NEXT_ID : row.id
      );
      expect(
        rowIds(now).join(" ") === [...mapped].sort().join(" "),
        `${parent} lock rows changed`
      );
      const scene = now.find((row) => row.id === NEXT_ID);
      expect(
        scene?.path === NEXT_SCENE && scene.sha256.length === 64,
        `${parent} scene row`
      );
      for (const row of now) {
        if (row.id === NEXT_ID) continue;
        const prev = oldLock.parts.find((item) => item.id === row.id);
        expect(prev, `${parent} lost ${row.id}`);
        if (!prev) continue;
        const parentId = JSON.parse(textOf(project, parent)).id as string;
        if (row.id === parentId) {
          expect(
            row.path === prev.path && row.sha256 !== prev.sha256,
            "parent sha"
          );
          continue;
        }
        expect(
          JSON.stringify(row) === JSON.stringify(prev),
          `${row.id} row changed`
        );
      }
    }
    for (const parent of [USB, COLLAPSED]) proveLockOrder(project, parent);
    const shot = textOf(project, snapRel);
    expect(shot.includes(NEXT_ID) && !shot.includes(SCENE_ID), "snapshot part");
    const leftover = [...treeOf(project).values()].some((text) =>
      text.includes(SCENE_ID)
    );
    expect(!leftover, "the old id remains in the project");
    console.log(
      `rename nano-servo-scene: file ${NEXT_SCENE}, parents 2, locks 2`
    );

    const undone = session.undo();
    if ("error" in undone || "needsConfirm" in undone) {
      throw new Error("error" in undone ? undone.error : "needs confirm");
    }
    sameTree(before, treeOf(project), "undo");
    const redone = session.redo();
    if ("error" in redone || "needsConfirm" in redone) {
      throw new Error("error" in redone ? redone.error : "needs confirm");
    }
    expect(existsSync(join(project, NEXT_SCENE)), "redo scene file");
    expect(!existsSync(join(project, SCENE)), "redo left the old file");
    expect(textOf(project, USB).includes(NEXT_ID), "redo parent");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

function proveLockOrder(project: string, world: string) {
  const disk = JSON.parse(
    textOf(project, world.replace(/\.json$/, ".lock.json"))
  ) as LockFile;
  const loaded = loadWorldV2(absolutePath(join(project, world)), {
    store: nodeStore,
    catalogDir: absolutePath(catalogRoot()),
    assetRoot: absolutePath(project),
  });
  expect(loaded.lock, `${world} did not build a lock`);
  const fresh = loaded.lock?.parts.map((row) => row.id).join("\n");
  const written = disk.parts.map((row) => row.id).join("\n");
  expect(written === fresh, `${world} lock order\n${written}\nvs\n${fresh}`);
}

function proveRootLock() {
  const project = copyNano("sfab-rename-root-");
  try {
    const session = open(project, USB);
    const applied = session.apply({
      kind: "rename-part",
      document: USB,
      to: "usb-rig",
    });
    if ("error" in applied || "needsConfirm" in applied) {
      throw new Error("error" in applied ? applied.error : "needs confirm");
    }
    expect(!existsSync(join(project, USB)), "old root remains");
    expect(existsSync(join(project, USB_NEXT)), "new root");
    const oldLock = USB.replace(/\.json$/, ".lock.json");
    const newLock = USB_NEXT.replace(/\.json$/, ".lock.json");
    expect(!existsSync(join(project, oldLock)), "old lock remains");
    expect(existsSync(join(project, newLock)), "lock did not move");
    const lock = JSON.parse(textOf(project, newLock)) as LockFile;
    expect(lock.world === "usb-rig@1.0.0", `lock world ${lock.world}`);
    expect(
      lock.parts.some((row) => row.id === "sfab/usb-rig@1.0.0"),
      "root row"
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

function proveRefusals() {
  const project = copyNano("sfab-rename-refuse-");
  try {
    const start = treeOf(project);
    const session = open(project, SCENE);
    const refuse = (to: string, error: string) => {
      const applied = session.apply({
        kind: "rename-part",
        document: SCENE,
        to,
      });
      expect(
        "error" in applied && applied.error === error,
        JSON.stringify(applied)
      );
    };
    refuse("nano-servo-scene", "the name is unchanged");
    refuse("Servo", "the name is not a part name");
    refuse("flag", "sfab/flag@1.0.0 already exists");
    writeFileSync(
      join(project, SCENE),
      `${textOf(project, SCENE).trimEnd()} \n`
    );
    const external = session.apply({
      kind: "rename-part",
      document: SCENE,
      to: "servo-scene",
    });
    expect(
      "error" in external && external.error === EXTERNAL_EDIT,
      JSON.stringify(external)
    );
    const library = open(project, COLLAPSED, project);
    const blocked = library.apply({
      kind: "rename-part",
      document: COLLAPSED,
      to: "collapsed-rig",
    });
    expect(
      "error" in blocked && blocked.error === "library part is read-only",
      JSON.stringify(blocked)
    );
    const catalogBefore = readFileSync(catalogLed, "utf8");
    const catalog = EditSession.open({
      file: absolutePath(catalogLed),
      names: [catalogLed],
      store: nodeStore,
      catalogDir: absolutePath(catalogRoot()),
      assetRoot: absolutePath(catalogRoot()),
    });
    if ("error" in catalog) throw new Error(catalog.error);
    const catalogEdit = catalog.apply({
      kind: "rename-part",
      document: catalogLed,
      to: "led-blue",
    });
    expect(
      "error" in catalogEdit &&
        catalogEdit.error === "catalog part is read-only",
      JSON.stringify(catalogEdit)
    );
    expect(
      readFileSync(catalogLed, "utf8") === catalogBefore,
      "catalog changed"
    );
    const after = treeOf(project);
    expect(
      after.size === start.size + 0 || after.has(SCENE),
      "refusal removed a file"
    );
    for (const [path, text] of start) {
      if (path === SCENE) continue;
      expect(after.get(path) === text, `refusal wrote ${path}`);
    }
    expect(
      after.get(SCENE) !== start.get(SCENE),
      "drift was not the test write"
    );
    expect(
      !existsSync(join(project, NEXT_SCENE)),
      "refusal created the new file"
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

function proveTorn() {
  const project = copyNano("sfab-rename-torn-");
  try {
    const file = absolutePath(join(project, SCENE));
    const text = readFileSync(file, "utf8");
    const part = JSON.parse(text) as PartFile;
    const planned = planPartRename({
      store: nodeStore,
      projectDir: absolutePath(project),
      catalogDir: absolutePath(catalogRoot()),
      file,
      text,
      part,
      to: "servo-scene",
      document: SCENE,
    });
    if ("error" in planned) throw new Error(planned.error);
    const rows = planned.files.map((item) => ({
      path: item.path,
      empty: item.text === null,
    }));
    const manifest = `${JSON.stringify({ committed: true, files: rows })}\n`;
    for (const item of planned.files) {
      writeFileSync(`${item.path}.edit-set`, manifest);
      writeFileSync(`${item.path}.edit-tmp`, item.text ?? "");
    }
    const opened = EditSession.open({
      file: planned.nextFile,
      names: [NEXT_SCENE, planned.nextFile],
      store: nodeStore,
      catalogDir: absolutePath(catalogRoot()),
      assetRoot: absolutePath(project),
    });
    if ("error" in opened) throw new Error(opened.error);
    expect(
      readFileSync(planned.nextFile, "utf8") === planned.text,
      "torn scene"
    );
    expect(!existsSync(file), "torn left the old file");
    for (const item of planned.files) {
      expect(!existsSync(`${item.path}.edit-tmp`), `marker ${item.path}`);
      expect(!existsSync(`${item.path}.edit-set`), `manifest ${item.path}`);
    }
    console.log("rename torn write: healed on open of the new file");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

function proveLeaf(project: string, world: string, name: string) {
  const planned = planWorld(project, world);
  if (!planned.ok)
    throw new Error(planned.errors.map((row) => row.message).join("; "));
  const view = viewOf(planned.plan);
  const tree = view.tree.nodes[0]?.name;
  expect(view.robots.length === 1, `${name} robots ${view.robots.length}`);
  expect(tree === name, `${name} tree ${tree}`);
  console.log(
    `leaf root ${name}: stage ${tree}, robots ${view.robots.length}, tree ${tree}`
  );
}

function proveIdle() {
  const project = copyNano("sfab-rename-idle-");
  try {
    const flag = JSON.parse(textOf(project, "parts/sfab/flag@1.0.0.json")) as {
      id: string;
      axes: { body: { "1": { variants: { urdf: { file?: string } } } } };
    };
    flag.id = "sfab/blank@1.0.0";
    delete flag.axes.body["1"].variants.urdf.file;
    writeFileSync(
      join(project, "parts/sfab/blank@1.0.0.json"),
      `${JSON.stringify(flag, null, 2)}\n`
    );
    const planned = planWorld(project, "parts/sfab/blank@1.0.0.json");
    if (!planned.ok)
      throw new Error(planned.errors.map((row) => row.message).join("; "));
    const messages = (planned.plan.degraded ?? [])
      .map((row) => row.message)
      .join(" ");
    expect(
      messages.includes("blank sits idle"),
      messages || "no degraded diagnostic"
    );
    expect(
      viewOf(planned.plan).tree.nodes[0]?.name === "blank",
      "idle tree name"
    );
    console.log("leaf idle blank: blank sits idle");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

async function proveMoved() {
  const project = copyNano("sfab-rename-moved-");
  try {
    const sceneEdit = parseWorldClient(
      JSON.stringify({
        type: "edit",
        part: SCENE_ID,
        ops: [{ kind: "rename-part", document: SCENE_ID, to: "servo-scene" }],
      })
    );
    if ("error" in sceneEdit || sceneEdit.type !== "edit") {
      throw new Error("scene edit did not parse");
    }
    const sceneApplied = await handleLiveEdit(project, USB, sceneEdit);
    expect(sceneApplied.type === "edited", JSON.stringify(sceneApplied));
    if (sceneApplied.type !== "edited") return;
    expect(
      sceneApplied.moved?.from === SCENE &&
        sceneApplied.moved.to === NEXT_SCENE,
      JSON.stringify(sceneApplied.moved)
    );
    const sceneUndo = parseWorldClient(
      JSON.stringify({ type: "undo", part: SCENE_ID })
    );
    if ("error" in sceneUndo || sceneUndo.type !== "undo") {
      throw new Error("scene undo did not parse");
    }
    const sceneUndone = await handleLiveEdit(project, USB, sceneUndo);
    expect(sceneUndone.type === "edited", JSON.stringify(sceneUndone));
    if (sceneUndone.type === "edited") {
      expect(
        sceneUndone.moved?.from === NEXT_SCENE &&
          sceneUndone.moved.to === SCENE,
        JSON.stringify(sceneUndone.moved)
      );
    }
    const sceneRedo = parseWorldClient(
      JSON.stringify({ type: "redo", part: SCENE_ID })
    );
    if ("error" in sceneRedo || sceneRedo.type !== "redo") {
      throw new Error("scene redo did not parse");
    }
    const sceneRedone = await handleLiveEdit(project, USB, sceneRedo);
    expect(
      sceneRedone.type === "edited" &&
        sceneRedone.moved?.from === SCENE &&
        sceneRedone.moved.to === NEXT_SCENE,
      JSON.stringify(sceneRedone)
    );
    await stopWorld(project, USB);

    const rootEdit = parseWorldClient(
      JSON.stringify({
        type: "edit",
        ops: [{ kind: "rename-part", document: USB, to: "usb-rig" }],
      })
    );
    if ("error" in rootEdit || rootEdit.type !== "edit") {
      throw new Error("root edit did not parse");
    }
    const applied = await handleLiveEdit(project, USB, rootEdit);
    expect(applied.type === "edited", JSON.stringify(applied));
    if (applied.type !== "edited") return;
    expect(
      applied.moved?.from === USB && applied.moved.to === USB_NEXT,
      JSON.stringify(applied.moved)
    );
    console.log(
      `rename moved apply ${applied.moved?.from} -> ${applied.moved?.to}`
    );
    const history = historiesForConnect(project, USB_NEXT);
    expect(
      history.some((row) => row.part === undefined && row.canUndo),
      JSON.stringify(history)
    );
    const undo = parseWorldClient(JSON.stringify({ type: "undo" }));
    if ("error" in undo || undo.type !== "undo")
      throw new Error("undo did not parse");
    const undone = await handleLiveEdit(project, USB_NEXT, undo);
    expect(undone.type === "edited", JSON.stringify(undone));
    if (undone.type === "edited") {
      expect(
        undone.moved?.from === USB_NEXT && undone.moved.to === USB,
        JSON.stringify(undone.moved)
      );
      console.log(
        `rename moved undo ${undone.moved?.from} -> ${undone.moved?.to}`
      );
    }
    const redo = parseWorldClient(JSON.stringify({ type: "redo" }));
    if ("error" in redo || redo.type !== "redo")
      throw new Error("redo did not parse");
    const redone = await handleLiveEdit(project, USB, redo);
    expect(
      redone.type === "edited" &&
        redone.moved?.from === USB &&
        redone.moved.to === USB_NEXT,
      JSON.stringify(redone)
    );
    if (redone.type === "edited") {
      console.log(
        `rename moved redo ${redone.moved?.from} -> ${redone.moved?.to}`
      );
    }
    const again = historiesForConnect(project, USB_NEXT);
    expect(
      again.some((row) => row.part === undefined && row.canUndo),
      "history left the new path"
    );
  } finally {
    await stopWorld(project, USB);
    await stopWorld(project, USB_NEXT);
    closeRootWatches();
    rmSync(project, { recursive: true, force: true });
  }
}

async function proveUndoOrder() {
  const project = copyNano("sfab-rename-order-");
  try {
    const sceneEdit = parseWorldClient(
      JSON.stringify({
        type: "edit",
        part: SCENE_ID,
        ops: [{ kind: "rename-part", document: SCENE_ID, to: "servo-scene" }],
      })
    );
    if ("error" in sceneEdit || sceneEdit.type !== "edit") {
      throw new Error("scene edit did not parse");
    }
    const sceneApplied = await handleLiveEdit(project, USB, sceneEdit);
    expect(sceneApplied.type === "edited", JSON.stringify(sceneApplied));
    const rootEdit = parseWorldClient(
      JSON.stringify({
        type: "edit",
        ops: [{ kind: "rename-part", document: USB, to: "usb-rig" }],
      })
    );
    if ("error" in rootEdit || rootEdit.type !== "edit") {
      throw new Error("root edit did not parse");
    }
    const renamed = await handleLiveEdit(project, USB, rootEdit);
    expect(renamed.type === "edited", JSON.stringify(renamed));
    const onRig = historiesForConnect(project, USB_NEXT);
    expect(
      onRig.some((row) => row.part === SCENE_ID && row.canUndo),
      `rig histories ${JSON.stringify(onRig)}`
    );
    const undo = parseWorldClient(JSON.stringify({ type: "undo" }));
    if ("error" in undo || undo.type !== "undo") {
      throw new Error("undo did not parse");
    }
    const undone = await handleLiveEdit(project, USB_NEXT, undo);
    expect(undone.type === "edited", JSON.stringify(undone));
    const onUsb = historiesForConnect(project, USB);
    expect(
      onUsb.some((row) => row.part === SCENE_ID && row.canUndo) &&
        onUsb.some((row) => row.part === undefined && !row.canUndo),
      `usb histories ${JSON.stringify(onUsb)}`
    );
  } finally {
    await stopWorld(project, USB);
    await stopWorld(project, USB_NEXT);
    closeRootWatches();
    rmSync(project, { recursive: true, force: true });
  }
}

async function proveUnreadable() {
  const project = copyNano("sfab-rename-broken-");
  try {
    const brokenRel = "parts/sfab/broken@1.0.0.json";
    const brokenText = '{ "id": "sfab/broken@1.0.0", ';
    writeFileSync(join(project, brokenRel), brokenText);
    const old = new Date("2001-02-03T04:05:06Z");
    const stamped = new Map<string, number>();
    for (const [rel] of treeOf(project)) {
      utimesSync(join(project, rel), old, old);
      stamped.set(rel, statSync(join(project, rel)).mtimeMs);
    }
    const before = treeOf(project);

    const file = absolutePath(join(project, SCENE));
    const text = readFileSync(file, "utf8");
    const planned = planPartRename({
      store: nodeStore,
      projectDir: absolutePath(project),
      catalogDir: absolutePath(catalogRoot()),
      file,
      text,
      part: JSON.parse(text) as PartFile,
      to: "servo-scene",
      document: SCENE,
    });
    if ("error" in planned) throw new Error(planned.error);
    expect(
      planned.skipped.length === 1 &&
        planned.skipped[0]?.file === brokenRel &&
        planned.skipped[0].error === "not valid JSON",
      JSON.stringify(planned.skipped)
    );
    const planPaths = new Set(
      planned.files.map((row) =>
        relative(absolutePath(project), row.path).split("\\").join("/")
      )
    );
    expect(!planPaths.has(brokenRel), "the broken file is in the plan");
    expect(
      !planPaths.has("parts/sfab/flag@1.0.0.json"),
      "an untouched part is in the plan"
    );

    const applied = await applyDocumentEdit(project, SCENE, [
      { kind: "rename-part", document: SCENE, to: "servo-scene" },
    ]);
    expect("sentence" in applied, JSON.stringify(applied));
    if (!("sentence" in applied)) return;
    expect(
      applied.warnings?.length === 1 &&
        applied.warnings[0]?.includes(`${brokenRel}: not valid JSON`),
      JSON.stringify(applied.warnings)
    );
    expect(
      applied.sentence.includes(`Not checked for the old name: ${brokenRel}`),
      applied.sentence
    );
    expect(existsSync(join(project, NEXT_SCENE)), "the rename did not land");
    const after = treeOf(project);
    expect(after.get(brokenRel) === brokenText, "the broken file was written");
    const written = new Set<string>();
    for (const [rel, body] of after) {
      if (before.get(rel) === body) {
        expect(
          statSync(join(project, rel)).mtimeMs === stamped.get(rel),
          `${rel} has the same bytes but was rewritten`
        );
      } else written.add(rel);
    }
    const flag = "parts/sfab/flag@1.0.0.json";
    expect(
      !written.has(flag) && !written.has(brokenRel),
      `written: ${[...written].join(", ")}`
    );
    const clean = copyNano("sfab-rename-clean-");
    try {
      const cleanApplied = await applyDocumentEdit(clean, SCENE, [
        { kind: "rename-part", document: SCENE, to: "servo-scene" },
      ]);
      expect(
        "sentence" in cleanApplied &&
          cleanApplied.warnings === undefined &&
          !cleanApplied.sentence.includes("Not checked"),
        JSON.stringify(cleanApplied)
      );
    } finally {
      await stopWorld(clean, NEXT_SCENE);
      await stopWorld(clean, SCENE);
      rmSync(clean, { recursive: true, force: true });
    }
    console.log(
      `rename unreadable: ${brokenRel} reported, ${written.size} files written, the rest untouched`
    );
  } finally {
    await stopWorld(project, NEXT_SCENE);
    await stopWorld(project, SCENE);
    closeRootWatches();
    rmSync(project, { recursive: true, force: true });
  }
}

proveScene();
proveRootLock();
proveRefusals();
proveTorn();
proveLeaf(nanoDir, "parts/sfab/flag@1.0.0.json", "flag");
proveLeaf(armDir, "parts/sfab/arm@1.0.0.json", "arm");
proveIdle();
await proveMoved();
await proveUndoOrder();
await proveUnreadable();
expect(worldWorkerCount() === 0, "a world worker was left behind");
console.log("rename-part.selfcheck ok");
