/**
 * Fixed ports, Stay / Break, and dirtying upward.
 * Copies only. Catalog files and the examples stay untouched.
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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  type EditOp,
  emptySnapshot,
  type Pose,
  type SnapshotFile,
} from "@sfab-bench/contract";
import {
  contentHash,
  type EditResult,
  EditSession,
  loadLibrary,
  lockPathFor,
  partFilePath,
  partPorts,
  sha256Bytes,
} from "@sfab-bench/parts";
import { provenanceHash } from "@sfab-bench/sim/freshness";
import type { SerialChunk } from "@sfab-bench/sim/sim";
import { Sim } from "@sfab-bench/sim/sim";

import { closeRootWatches } from "./projects";
import { runViewerContext } from "./viewer-context";
import { handleLiveEdit } from "./world/edit";
import { projectReal, readerFor, readInside } from "./world/files";
import { stopWorld, worldWorkerCount } from "./world/host";
import { parseWorldClient } from "./world/live-message";
import { absolutePath, nodeStore } from "./world/node-store";
import { packageVersion } from "./world/package-version";
import { catalogRoot, planWorld } from "./world/plan";
import { nodePlanEnv, nodeStampEnv } from "./world/plan-host";
import { worldTools } from "./world-tools";

const SPAN_MS = 3000;
const USB = "parts/sfab/nano-servo-usb@1.0.0.json";
const COLLAPSED = "parts/sfab/nano-servo-collapsed@1.0.0.json";
const SCENE = "parts/sfab/nano-servo-scene@1.0.0.json";
const SCENE_ID = "sfab/nano-servo-scene@1.0.0";
const CLASS1 = "parts/sfab/nano-vcc-class1@1.0.0.json";
const POWER_ID = "sfab/nano-power-input@1.0.0";
const nanoDir = fileURLToPath(
  new URL("../../../examples/nano/", import.meta.url)
);

function copyNano(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cpSync(nanoDir, dir, { recursive: true });
  return dir;
}

function textOf(project: string, rel: string): string {
  return readFileSync(join(project, rel), "utf8");
}

function pose(): Pose {
  return { position: [0.042, 0, 0.0025], rotation: [1, 0, 0, 0] };
}

function doc(
  rel: string,
  op: { kind: EditOp["kind"] } & Record<string, unknown>
): EditOp {
  return { ...op, document: rel } as EditOp;
}

function session(project: string, rel: string, partId?: string): EditSession {
  const root = absolutePath(project);
  const file = partId
    ? (partFilePath(root, partId) ?? absolutePath(join(project, rel)))
    : absolutePath(join(project, rel));
  const opened = EditSession.open({
    file,
    names: [rel, file, ...(partId ? [partId] : [])],
    store: nodeStore,
    catalogDir: absolutePath(catalogRoot()),
    assetRoot: root,
  });
  if ("error" in opened) throw new Error(opened.error);
  return opened;
}

function apply(
  project: string,
  rel: string,
  op: EditOp,
  partId?: string
): EditResult {
  return session(project, rel, partId).apply(op);
}

function must(
  project: string,
  rel: string,
  op: EditOp,
  partId?: string
): EditResult {
  const applied = apply(project, rel, op, partId);
  if ("error" in applied) throw new Error(applied.error);
  if ("needsConfirm" in applied) {
    throw new Error(`needs confirm ${applied.count}`);
  }
  return applied;
}

function libraryOf(project: string) {
  const loaded = loadLibrary(join(project, USB), {
    store: nodeStore,
    catalogDir: absolutePath(catalogRoot()),
    assetRoot: absolutePath(project),
  });
  if (!loaded.library) {
    throw new Error(loaded.diagnostics.map((diag) => diag.message).join("; "));
  }
  return loaded.library;
}

function reportOf(project: string, world: string) {
  const planned = planWorld(project, world);
  if (!planned.ok) {
    throw new Error(planned.errors.map((error) => error.message).join("; "));
  }
  return planned.plan.report;
}

async function recorded(project: string, world: string, ms = SPAN_MS) {
  const sim = new Sim({
    post() {
      /* serial is drained after the step */
    },
    now: () => performance.now(),
    schedule: (fn, delay) => setTimeout(fn, delay),
    clear(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
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
    const loaded = await sim.load({ project, world, generation: 1 });
    if (!loaded.ok) {
      const text = loaded.errors.map((error) => error.message).join("; ");
      throw new Error(text || loaded.message || `${world} did not load`);
    }
    await sim.step(ms);
    const settled = sim.state();
    if (!settled) throw new Error(`${world} produced no state`);
    const body = sim.record({ op: "read", from: 0, to: settled.simTime });
    if (body.op !== "read") throw new Error(`${world} produced no recording`);
    const warnings = (sim.report()?.warnings ?? []).filter(
      (row) => row.code === "broken-port" || row.code === "stale-capture"
    );
    return {
      frames: JSON.stringify(body.read.frames),
      serial: takeLines(sim.drainSerial()),
      count: body.read.frames.length,
      warnings,
      stale: sim.report()?.snapshots.some((row) => row.stale === true) === true,
    };
  } finally {
    sim.dispose();
  }
}

function takeLines(chunks: SerialChunk[]): string[] {
  const pending = new Map<string, string>();
  const lines: string[] = [];
  for (const chunk of chunks) {
    const buf = (pending.get(chunk.board) ?? "") + chunk.text;
    const parts = buf.split("\n");
    pending.set(chunk.board, parts.pop() ?? "");
    for (const part of parts) {
      const line = part.replace(/\r$/, "").trim();
      if (line.length > 0) lines.push(`${chunk.board}: ${line}`);
    }
  }
  for (const [board, rest] of pending) {
    const line = rest.replace(/\r$/, "").trim();
    if (line.length > 0) lines.push(`${board}: ${line}`);
  }
  return lines;
}

function unprefix(text: string): string {
  return text.replaceAll("scene.", "");
}

function lockHash(
  project: string,
  rel: string,
  id: string
): string | undefined {
  const raw = readFileSync(lockPathFor(join(project, rel)), "utf8");
  const lock = JSON.parse(raw) as { parts?: { id: string; sha256: string }[] };
  return lock.parts?.find((row) => row.id === id)?.sha256;
}

function listPorts() {
  const scenes = [
    "sfab/nano-divider-scene@1.0.0",
    "sfab/nano-led-module-scene@1.0.0",
    "sfab/nano-led-scene@1.0.0",
    "sfab/nano-servo-scene@1.0.0",
    "sfab/nano-vcc-scene@1.0.0",
  ];
  for (const id of scenes) {
    const file = partFilePath(nanoDir, id);
    if (!file) throw new Error(`no ${id}`);
    const loaded = loadLibrary(file, {
      store: nodeStore,
      catalogDir: absolutePath(catalogRoot()),
      assetRoot: absolutePath(nanoDir),
    });
    if (!loaded.library) {
      throw new Error(
        loaded.diagnostics.map((diag) => diag.message).join("; ")
      );
    }
    const ports = partPorts(loaded.library, id);
    const counts = { type: 0, expose: 0, auto: 0 };
    for (const port of ports) counts[port.source] += 1;
    const names = ports
      .slice(0, 4)
      .map((port) => port.name)
      .join(", ");
    console.log(
      `ports ${id}: type ${counts.type}, expose ${counts.expose}, auto ${counts.auto}; ${names}`
    );
  }
  const typedLib = libraryOf(nanoDir);
  const typed = partPorts(typedLib, "sfab/usb-port-500ma@1.0.0");
  const counts = { type: 0, expose: 0, auto: 0 };
  for (const port of typed) counts[port.source] += 1;
  console.log(
    `ports sfab/usb-port-500ma@1.0.0: type ${counts.type}, expose ${counts.expose}, auto ${counts.auto}; ${typed
      .slice(0, 4)
      .map((port) => port.name)
      .join(", ")}`
  );
}

function freshToday() {
  const catalog = catalogRoot();
  const roots = [join(catalog, "snapshots"), join(nanoDir, "snapshots")];
  let n = 0;
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const files = walk(root);
    for (const file of files) {
      const snap = JSON.parse(readFileSync(file, "utf8")) as SnapshotFile;
      const fresh = provenanceHash(
        snap,
        { catalogDir: catalog, worldDir: catalog, assetRoot: catalog },
        nodeStampEnv
      );
      const stored = snap.provenance?.from?.hash;
      expect(
        fresh.checked && fresh.hash === stored,
        `${file} is not fresh (${fresh.checked ? fresh.hash : "unchecked"} vs ${stored})`
      );
      n += 1;
    }
  }
  console.log(`fresh today: ${n} catalog and example snapshots, all fresh`);

  const power = JSON.parse(
    readFileSync(
      join(catalog, "snapshots", "sfab", "nano-power-input@1.0.0.json"),
      "utf8"
    )
  ) as SnapshotFile;
  const opts = { catalogDir: catalog, worldDir: catalog, assetRoot: catalog };
  expect(
    power.provenance.variant === "netlist" &&
      power.provenance.instance === "power",
    "the catalog snapshot records its variant and instance"
  );
  const asRecorded = provenanceHash(power, opts, nodeStampEnv);
  const { variant: _v, instance: _i, ...bare } = power.provenance;
  const legacy = provenanceHash(
    { ...power, provenance: bare },
    opts,
    nodeStampEnv
  );
  expect(
    asRecorded.checked && asRecorded.hash === power.provenance.from?.hash,
    "the recorded variant and instance give the recorded hash"
  );
  expect(
    !legacy.checked && legacy.reason.includes("variant"),
    "a snapshot without a variant is unchecked, and says so"
  );
  const moved = provenanceHash(
    { ...power, provenance: { ...power.provenance, variant: "no-such" } },
    opts,
    nodeStampEnv
  );
  expect(!moved.checked, "a wrong recorded variant is not silently repaired");
  console.log(
    "fresh from provenance: variant and instance recorded; without them, unchecked"
  );
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, name.name);
    if (name.isDirectory()) out.push(...walk(child));
    else if (name.name.endsWith(".json")) out.push(child);
  }
  return out.sort();
}

async function proveBubble() {
  const flat = await recorded(nanoDir, USB);
  const project = copyNano("sfab-ports-bubble-");
  try {
    must(
      project,
      SCENE,
      doc(SCENE, {
        kind: "batch",
        label: "move usb",
        ops: [
          doc(SCENE, { kind: "unwire", a: "usb.5V", b: "nano.5V" }),
          doc(SCENE, { kind: "unwire", a: "usb.GND", b: "nano.GND" }),
          doc(SCENE, { kind: "remove-instance", id: "usb" }),
        ],
      }),
      SCENE_ID
    );
    must(
      project,
      USB,
      doc(USB, {
        kind: "batch",
        label: "power the scene",
        ops: [
          doc(USB, {
            kind: "add-instance",
            id: "usb",
            part: "sfab/usb-port-500ma@1.0.0",
            pose: pose(),
          }),
          doc(USB, { kind: "wire", a: "usb.5V", b: "scene.5V" }),
          doc(USB, { kind: "wire", a: "usb.GND", b: "scene.GND" }),
        ],
      })
    );
    const bubbled = await recorded(project, USB);
    expect(
      unprefix(bubbled.frames) === flat.frames,
      "bubbled frames differ from the flat original"
    );
    expect(
      unprefix(bubbled.serial.join("\n")) === flat.serial.join("\n"),
      "bubbled serial differs from the flat original"
    );
    expect(bubbled.warnings.length === 0, "bubbled run warned");
    console.log(
      `bubbled 5V and GND: ${SPAN_MS} ms, ${bubbled.count} frames byte-identical to the flat original after the scene. prefix, serial ${bubbled.serial.length} lines identical`
    );
    return project;
  } catch (err) {
    rmSync(project, { recursive: true, force: true });
    throw err;
  }
}

async function provePin(project: string) {
  const before = await recorded(project, USB);
  const sceneBefore = textOf(project, SCENE);
  const usbBefore = textOf(project, USB);
  const usbLock = textOf(project, USB.replace(/\.json$/, ".lock.json"));
  const collapsedLock = textOf(
    project,
    COLLAPSED.replace(/\.json$/, ".lock.json")
  );
  const opened = session(project, SCENE, SCENE_ID);
  const applied = opened.apply(
    doc(SCENE, {
      kind: "add-instance",
      id: "a",
      part: "sfab/usb-port-500ma@1.0.0",
      pose: pose(),
    })
  );
  if ("error" in applied) throw new Error(applied.error);
  if ("needsConfirm" in applied) throw new Error("pin asked to confirm");
  const scene = textOf(project, SCENE);
  expect(scene.includes('"5V": "nano.5V"'), "expose did not pin 5V");
  const after = await recorded(project, USB);
  expect(
    unprefix(after.serial.join("\n")) === unprefix(before.serial.join("\n")),
    "pinned parent serial changed"
  );
  expect(after.count === before.count, "pinned parent frame count changed");
  const undone = opened.undo();
  if ("error" in undone) throw new Error(undone.error);
  expect(
    textOf(project, SCENE) === sceneBefore,
    "undo scene is not byte-identical"
  );
  expect(textOf(project, USB) === usbBefore, "undo root changed");
  expect(
    textOf(project, USB.replace(/\.json$/, ".lock.json")) === usbLock,
    "undo usb lock is not byte-identical"
  );
  expect(
    textOf(project, COLLAPSED.replace(/\.json$/, ".lock.json")) ===
      collapsedLock,
    "undo collapsed lock is not byte-identical"
  );
  console.log(
    "fixed port: 5V stayed 5V, expose pinned nano.5V, parent serial identical, undo byte-identical"
  );
}

async function proveStay(project: string) {
  must(project, USB, doc(USB, { kind: "wire", a: "scene.D2", b: "scene.D3" }));
  const files = [
    SCENE,
    USB,
    `${USB.replace(/\.json$/, ".lock.json")}`,
    COLLAPSED,
    `${COLLAPSED.replace(/\.json$/, ".lock.json")}`,
  ];
  const before = new Map(files.map((rel) => [rel, textOf(project, rel)]));
  const sceneSession = session(project, SCENE, SCENE_ID);
  const stayed = sceneSession.apply(
    doc(SCENE, { kind: "remove-instance", id: "nano" })
  );
  expect("needsConfirm" in stayed, JSON.stringify(stayed));
  if (!("needsConfirm" in stayed)) return;
  expect(stayed.count >= 2, `confirm count ${stayed.count}`);
  const listed = stayed.ports.flatMap((port) =>
    port.dependents.map((dep) => `${port.name} ${dep.ref}`)
  );
  expect(
    listed.some((line) => line.includes("scene.D2") || line.includes("D2")),
    `dependents ${listed.join("; ")}`
  );
  for (const [rel, text] of before) {
    expect(textOf(project, rel) === text, `${rel} changed on stay`);
  }
  console.log(
    `stay: needs-confirm N=${stayed.count} (${stayed.ports.map((port) => port.name).join(", ")}), files byte-identical`
  );
  const broken = sceneSession.apply(
    doc(SCENE, { kind: "remove-instance", id: "nano", confirm: "break" })
  );
  if ("error" in broken) throw new Error(broken.error);
  if ("needsConfirm" in broken) throw new Error("break still needs confirm");
  const ran = await recorded(project, USB, 200);
  const warnings = ran.warnings.filter((row) => row.code === "broken-port");
  expect(
    warnings.length === stayed.count,
    `warnings ${warnings.length} vs N ${stayed.count}`
  );
  expect(ran.count > 0, "broken run did not play");
  const undone = sceneSession.undo();
  if ("error" in undone) throw new Error(undone.error);
  for (const [rel, text] of before) {
    expect(textOf(project, rel) === text, `${rel} undo is not byte-identical`);
  }
  console.log(
    `break: ${warnings.length} broken-port warnings, run played, undo restored the scene and the locks`
  );
}

async function proveCapture() {
  const project = copyNano("sfab-ports-capture-");
  try {
    const catalog = catalogRoot();
    const partRel = "parts/sfab/nano-power-input@1.0.0.json";
    const partSrc = partFilePath(catalog, POWER_ID);
    expect(partSrc, "catalog power part");
    cpSync(partSrc as string, join(project, partRel));
    const snapRel = "snapshots/sfab/nano-power-input@1.0.0.json";
    mkdirSync(join(project, "snapshots/sfab"), { recursive: true });
    cpSync(join(catalog, snapRel), join(project, snapRel));
    const snap = JSON.parse(
      readFileSync(join(project, snapRel), "utf8")
    ) as SnapshotFile;
    const fresh = provenanceHash(
      snap,
      {
        catalogDir: catalog,
        worldDir: absolutePath(project),
        assetRoot: absolutePath(project),
      },
      nodeStampEnv
    );
    expect(
      fresh.checked && fresh.hash === snap.provenance.from?.hash,
      "copied capture was not fresh"
    );
    const before = await recorded(project, CLASS1, 200);
    expect(before.stale === false, "capture started stale");
    const edited = session(project, partRel, POWER_ID);
    const applied = edited.apply(
      doc(partRel, {
        kind: "set-param",
        id: "c106",
        name: "C",
        value: 0.00002,
      })
    );
    if ("error" in applied) throw new Error(applied.error);
    if ("needsConfirm" in applied) throw new Error("param needs confirm");
    const after = await recorded(project, CLASS1, 200);
    expect(after.stale === true, "edit did not mark the capture stale");
    expect(
      after.warnings.some((row) => row.code === "stale-capture"),
      "missing stale-capture warning"
    );
    expect(after.frames === before.frames, "stale frames changed");
    const undone = edited.undo();
    if ("error" in undone) throw new Error(undone.error);
    const restored = await recorded(project, CLASS1, 200);
    expect(restored.stale === false, "undo left the capture stale");
    console.log(
      "stale capture: project copy of nano-power-input, edit marks stale, frames identical, undo fresh"
    );

    const sceneSnap = join(
      project,
      "snapshots/sfab/nano-servo-scene-capture@1.0.0.json"
    );
    writeFileSync(
      sceneSnap,
      `${JSON.stringify(
        {
          part: "sfab/nano-servo-scene-capture@1.0.0",
          provenance: {
            from: { part: SCENE_ID, level: "2", hash: "unchecked-scene" },
          },
          ports: { inputs: ["5V.current"], outputs: ["5V.voltage"] },
          params: { across: ["5V", "GND"] },
        },
        null,
        2
      )}\n`
    );
    const confirm = apply(
      project,
      SCENE,
      doc(SCENE, {
        kind: "batch",
        label: "drop the rail",
        ops: [
          doc(SCENE, { kind: "remove-instance", id: "usb" }),
          doc(SCENE, { kind: "remove-instance", id: "nano" }),
          doc(SCENE, { kind: "remove-instance", id: "servo" }),
        ],
      }),
      SCENE_ID
    );
    expect("needsConfirm" in confirm, JSON.stringify(confirm));
    if ("needsConfirm" in confirm) {
      const snaps = confirm.ports.flatMap((port) =>
        port.dependents.filter((dep) => dep.kind === "snapshot")
      );
      expect(snaps.length > 0, "needs-confirm did not list the capture");
      console.log(
        `capture dependent: needs-confirm lists ${snaps.length} capture${snaps.length === 1 ? "" : "s"}`
      );
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

function proveDirty() {
  const project = copyNano("sfab-ports-dirty-");
  try {
    const before = {
      scene: textOf(project, SCENE),
      usbLock: textOf(project, USB.replace(/\.json$/, ".lock.json")),
      collapsedLock: textOf(
        project,
        COLLAPSED.replace(/\.json$/, ".lock.json")
      ),
    };
    const opened = session(project, SCENE, SCENE_ID);
    const applied = opened.apply(
      doc(SCENE, {
        kind: "set-pose",
        id: "flag",
        pose: { position: [0, 0, 0.03], rotation: [1, 0, 0, 0] },
      })
    );
    if ("error" in applied) throw new Error(applied.error);
    if ("needsConfirm" in applied) throw new Error("pose needs confirm");
    const hash = contentHash(JSON.parse(textOf(project, SCENE)));
    const usbHash = lockHash(project, USB, SCENE_ID);
    const collapsedHash = lockHash(project, COLLAPSED, SCENE_ID);
    expect(usbHash === hash, `usb lock ${usbHash} is not ${hash}`);
    expect(
      collapsedHash === hash,
      `collapsed lock ${collapsedHash} is not ${hash}`
    );
    expect(
      usbHash !== contentHash(JSON.parse(before.scene)),
      "usb lock did not change"
    );
    for (const world of [USB, COLLAPSED]) {
      const report = reportOf(project, world);
      expect(!report?.degraded?.length, `${world} degraded`);
      expect((report?.errors.length ?? 1) === 0, `${world} errors`);
    }
    console.log(
      `dirty upward: re-pinned ${USB.replace(/\.json$/, ".lock.json")} and ${COLLAPSED.replace(/\.json$/, ".lock.json")}`
    );
    const undone = opened.undo();
    if ("error" in undone) throw new Error(undone.error);
    expect(textOf(project, SCENE) === before.scene, "undo scene differs");
    expect(
      textOf(project, USB.replace(/\.json$/, ".lock.json")) === before.usbLock,
      "undo usb lock differs"
    );
    expect(
      textOf(project, COLLAPSED.replace(/\.json$/, ".lock.json")) ===
        before.collapsedLock,
      "undo collapsed lock differs"
    );
    console.log("dirty upward: undo restored the scene and both locks");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

function proveTorn() {
  const project = copyNano("sfab-ports-torn-");
  try {
    const scene = join(project, SCENE);
    const usbLock = lockPathFor(join(project, USB));
    const collapsedLock = lockPathFor(join(project, COLLAPSED));
    const nextScene = textOf(project, SCENE).replace("0.029", "0.031");
    const nextUsb = textOf(
      project,
      USB.replace(/\.json$/, ".lock.json")
    ).replace(/"sha256": "[0-9a-f]{64}"/, `"sha256": "${"ab".repeat(32)}"`);
    const files = [
      { path: scene, text: nextScene },
      { path: usbLock, text: nextUsb },
      { path: collapsedLock, text: nextUsb },
    ];
    const manifest = `${JSON.stringify({
      committed: true,
      files: files.map((file) => ({ path: file.path, empty: false })),
    })}\n`;
    for (const file of files) {
      writeFileSync(`${file.path}.edit-set`, manifest);
      writeFileSync(`${file.path}.edit-tmp`, file.text);
    }
    writeFileSync(scene, nextScene);
    rmSync(`${scene}.edit-tmp`);
    const opened = EditSession.open({
      file: scene,
      names: [SCENE, scene],
      store: nodeStore,
      catalogDir: absolutePath(catalogRoot()),
      assetRoot: absolutePath(project),
    });
    if ("error" in opened) throw new Error(opened.error);
    expect(readFileSync(scene, "utf8") === nextScene, "scene was not kept");
    expect(
      readFileSync(usbLock, "utf8") === nextUsb,
      "usb lock was not finished"
    );
    expect(
      readFileSync(collapsedLock, "utf8") === nextUsb,
      "collapsed lock was not finished"
    );
    for (const file of files) {
      expect(!existsSync(`${file.path}.edit-tmp`), "temp remains");
      expect(!existsSync(`${file.path}.edit-set`), "manifest remains");
    }
    console.log("torn write: healed 3 files from a committed edit-set");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

async function proveCallers() {
  const project = copyNano("sfab-ports-callers-");
  try {
    must(
      project,
      USB,
      doc(USB, { kind: "wire", a: "scene.D2", b: "scene.D3" })
    );
    await runViewerContext(
      { root: project, file: "", snapshot: emptySnapshot(), show: () => {} },
      async () => {
        const stayed = await call(worldTools.world_edit, {
          world: USB,
          part: SCENE_ID,
          ops: [{ kind: "remove-instance", id: "nano" }],
        });
        expect(typeof stayed === "string", JSON.stringify(stayed));
        expect(
          String(stayed).includes("Nothing changed") &&
            String(stayed).includes("break"),
          String(stayed)
        );
        console.log(`world_edit needs-confirm: ${stayed}`);
        const broken = await call(worldTools.world_edit, {
          world: USB,
          part: SCENE_ID,
          break: true,
          ops: [{ kind: "remove-instance", id: "nano" }],
        });
        expect(typeof broken === "string", JSON.stringify(broken));
        expect(String(broken).includes("removed nano"), String(broken));
        console.log(`world_edit break: ${broken}`);
        const undone = await call(worldTools.world_undo, {
          world: USB,
          part: SCENE_ID,
        });
        expect(typeof undone === "string", JSON.stringify(undone));
        const raw = JSON.stringify({
          type: "edit",
          part: SCENE_ID,
          ops: [{ kind: "remove-instance", document: SCENE, id: "nano" }],
        });
        const parsed = parseWorldClient(raw);
        if ("error" in parsed || parsed.type !== "edit") {
          throw new Error("edit did not parse");
        }
        const event = await handleLiveEdit(project, USB, parsed);
        expect(event.type === "needs-confirm", JSON.stringify(event));
        if (event.type === "needs-confirm") {
          console.log(
            `socket needs-confirm: N=${event.count} ${event.message}`
          );
        }
        const again = parseWorldClient(
          JSON.stringify({
            type: "edit",
            part: SCENE_ID,
            confirm: "break",
            ops: [{ kind: "remove-instance", document: SCENE, id: "nano" }],
          })
        );
        if ("error" in again || again.type !== "edit") {
          throw new Error("break did not parse");
        }
        const edited = await handleLiveEdit(project, USB, again);
        expect(edited.type === "edited", JSON.stringify(edited));
        if (edited.type === "edited") {
          console.log(`socket edited: ${edited.label}`);
        }
      }
    );
  } finally {
    await stopWorld(project, USB);
    closeRootWatches();
    rmSync(project, { recursive: true, force: true });
  }
}

function call(
  tool: { execute?: (input: never, options: never) => unknown },
  input: unknown
): Promise<unknown> {
  const execute = tool.execute;
  if (!execute) throw new Error("tool has no execute");
  return Promise.resolve(execute(input as never, {} as never));
}

listPorts();
freshToday();
const bubble = await proveBubble();
try {
  await provePin(bubble);
  await proveStay(bubble);
} finally {
  rmSync(bubble, { recursive: true, force: true });
}
await proveCapture();
proveDirty();
proveTorn();
await proveCallers();
expect(worldWorkerCount() === 0, "a world worker was left behind");
console.log("ports-dirty.selfcheck ok");
