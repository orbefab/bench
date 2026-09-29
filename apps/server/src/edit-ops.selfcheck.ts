/**
 * Typed edits, undo, and the agent and socket paths.
 * Copies only. Catalog files and the examples stay untouched.
 */
import { ok as expect } from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  type EditOp,
  emptySnapshot,
  type Pose,
  type RunReport,
  type WorldViewNode,
} from "@sfab-bench/contract";
import {
  EditSession,
  EXTERNAL_EDIT,
  formatPart,
  lockPathFor,
  partStyle,
  sha256Bytes,
} from "@sfab-bench/parts";
import type { SerialChunk } from "@sfab-bench/sim/sim";
import { Sim } from "@sfab-bench/sim/sim";
import { partWriteRefusal } from "./local-sandbox";
import { closeRootWatches } from "./projects";
import { runHeadless } from "./run";
import { runViewerContext } from "./viewer-context";
import { handleLiveEdit } from "./world/edit";
import { projectReal, readerFor, readInside } from "./world/files";
import { stopWorld, worldWorkerCount } from "./world/host";
import { parseWorldClient } from "./world/live-message";
import { absolutePath, nodeStore } from "./world/node-store";
import { packageVersion } from "./world/package-version";
import { catalogRoot, planWorld } from "./world/plan";
import { nodePlanEnv } from "./world/plan-host";
import { worldTools } from "./world-tools";

const SPAN_MS = 3000;
const SCENE = "parts/sfab/nano-servo-scene@1.0.0.json";
const USB = "parts/sfab/nano-servo-usb@1.0.0.json";
const COLLAPSED = "parts/sfab/nano-servo-collapsed@1.0.0.json";
const nanoDir = fileURLToPath(
  new URL("../../../examples/nano/", import.meta.url)
);
const catalogLed = fileURLToPath(
  new URL("../catalog/parts/sfab/led-red@1.0.0.json", import.meta.url)
);

function copyNano(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cpSync(nanoDir, dir, { recursive: true });
  return dir;
}

type Pair = { part: string; lock: string | null };

function pairOf(project: string, world: string): Pair {
  const file = join(project, world);
  const lock = lockPathFor(file);
  return {
    part: readFileSync(file, "utf8"),
    lock: existsSync(lock) ? readFileSync(lock, "utf8") : null,
  };
}

function samePair(a: Pair, b: Pair): boolean {
  return a.part === b.part && a.lock === b.lock;
}

function putPair(project: string, world: string, saved: Pair) {
  const file = join(project, world);
  writeFileSync(file, saved.part);
  const lock = lockPathFor(file);
  if (saved.lock === null) {
    if (existsSync(lock)) rmSync(lock);
  } else {
    writeFileSync(lock, saved.lock);
  }
}

function openSession(project: string, world: string): EditSession {
  const file = absolutePath(join(project, world));
  const opened = EditSession.open({
    file,
    names: [world, file],
    store: nodeStore,
    catalogDir: absolutePath(catalogRoot()),
    assetRoot: absolutePath(project),
  });
  if ("error" in opened) throw new Error(opened.error);
  return opened;
}

function loads(project: string, world: string) {
  const planned = planWorld(project, world);
  if (!planned.ok) {
    throw new Error(planned.errors.map((error) => error.message).join("; "));
  }
  return planned.plan.report;
}

function pose(z: number): Pose {
  return { position: [0, 0, z], rotation: [1, 0, 0, 0] };
}

function docOp(
  world: string,
  op: { kind: EditOp["kind"] } & Record<string, unknown>
): EditOp {
  return { ...op, document: world } as EditOp;
}

function roundTrip(
  project: string,
  world: string,
  op: EditOp,
  name: string,
  changed: (text: string) => boolean
) {
  const before = pairOf(project, world);
  const session = openSession(project, world);
  const applied = session.apply(op);
  if ("error" in applied) throw new Error(`${name}: ${applied.error}`);
  const after = pairOf(project, world);
  expect(after.part !== before.part, `${name}: part did not change`);
  expect(changed(after.part), `${name}: part text was unexpected`);
  loads(project, world);
  const undone = session.undo();
  if ("error" in undone) throw new Error(`${name} undo: ${undone.error}`);
  expect(
    samePair(pairOf(project, world), before),
    `${name}: undo is not byte-identical`
  );
  const redone = session.redo();
  if ("error" in redone) throw new Error(`${name} redo: ${redone.error}`);
  expect(
    samePair(pairOf(project, world), after),
    `${name}: redo is not byte-identical`
  );
  const reset = session.undo();
  if ("error" in reset) throw new Error(`${name} reset: ${reset.error}`);
  expect(
    samePair(pairOf(project, world), before),
    `${name}: reset left the files dirty`
  );
  console.log(
    `edit ${name}: applied, undo byte-identical, redo byte-identical`
  );
}

function assertRoundTrip(file: string) {
  const text = readFileSync(file, "utf8");
  const printed = formatPart(JSON.parse(text), partStyle(text));
  if (printed === text) return;
  let at = 0;
  const limit = Math.min(printed.length, text.length);
  while (at < limit && printed[at] === text[at]) at += 1;
  throw new Error(
    `round trip ${file} at ${at}: ${JSON.stringify(text.slice(at, at + 40))} vs ${JSON.stringify(printed.slice(at, at + 40))}`
  );
}

function reject(project: string, world: string, op: EditOp, needle: string) {
  const before = pairOf(project, world);
  const session = openSession(project, world);
  const applied = session.apply(op);
  expect("error" in applied, `${needle}: the edit was accepted`);
  if (!("error" in applied)) return;
  expect(applied.error.includes(needle), applied.error);
  expect(
    samePair(pairOf(project, world), before),
    `${needle}: a rejected edit wrote`
  );
  console.log(`edit rejected: ${applied.error}`);
}

const ARM_SCENE = "parts/sfab/arm-scene@1.0.0.json";
const armDir = fileURLToPath(
  new URL("../../../examples/arm/", import.meta.url)
);

function viewPorts(project: string, world: string, refs: string[]) {
  const planned = planWorld(project, world);
  if (!planned.ok) {
    throw new Error(planned.errors.map((error) => error.message).join("; "));
  }
  const find = (
    nodes: readonly WorldViewNode[],
    id: string
  ): WorldViewNode | null => {
    for (const node of nodes) {
      if (node.id === id) return node;
      const inner = find(node.children, id);
      if (inner) return inner;
    }
    return null;
  };
  const tree = planned.plan.tree;
  expect(tree, `${world} has no view tree`);
  const words = refs.map((ref) => {
    const at = ref.indexOf(".");
    const node = find(tree.nodes, ref.slice(0, at));
    const port = node?.ports.find((item) => item.name === ref.slice(at + 1));
    expect(port, `view port ${ref} is missing`);
    expect(port.domain, `view port ${ref} has no domain`);
    return `${ref} ${port.domain} ${port.wired ? "wired" : "free"}`;
  });
  console.log(`view ports ${basename(world)}: ${words.join(", ")}`);
}

const work = copyNano("sfab-edit-ops-");
const arm = mkdtempSync(join(tmpdir(), "sfab-edit-arm-"));
cpSync(armDir, arm, { recursive: true });
const frames = copyNano("sfab-edit-frames-");
const tools = copyNano("sfab-edit-tools-");

try {
  assertRoundTrip(join(work, SCENE));
  assertRoundTrip(join(work, USB));

  roundTrip(
    work,
    SCENE,
    docOp(SCENE, {
      kind: "wire",
      a: "nano.D10",
      b: "servo.signal",
    }),
    "wire nano.D10 servo.signal",
    (text) => text.includes("nano.D10") && text.includes("servo.signal")
  );
  roundTrip(
    work,
    SCENE,
    docOp(SCENE, { kind: "unwire", a: "nano.D9", b: "servo.signal" }),
    "unwire nano.D9 servo.signal",
    (text) => !text.includes('["nano.D9", "servo.signal"]')
  );
  roundTrip(
    work,
    SCENE,
    docOp(SCENE, {
      kind: "add-instance",
      id: "extra",
      part: "sfab/led-red@1.0.0",
      pose: pose(0.05),
    }),
    "add-instance extra sfab/led-red@1.0.0",
    (text) => text.includes('"extra"')
  );
  roundTrip(
    work,
    USB,
    docOp(USB, { kind: "remove-instance", id: "ground" }),
    "remove-instance ground",
    (text) => !text.includes('"ground"')
  );
  roundTrip(
    work,
    SCENE,
    docOp(SCENE, { kind: "set-pose", id: "flag", pose: pose(0.04) }),
    "set-pose flag",
    (text) => text.includes("0.04")
  );
  roundTrip(
    work,
    SCENE,
    docOp(SCENE, { kind: "set-param", id: "usb", name: "V", value: 4.5 }),
    "set-param usb V",
    (text) => text.includes("4.5")
  );
  roundTrip(
    work,
    USB,
    docOp(USB, {
      kind: "set-level",
      scope: "path",
      key: "servo",
      axis: "body",
      class: 1,
    }),
    "set-level path servo body 1",
    (text) => text.includes('"servo"') && text.includes('"body": 1')
  );
  roundTrip(
    work,
    SCENE,
    docOp(SCENE, { kind: "rename-instance", id: "flag", to: "vane" }),
    "rename-instance flag vane",
    (text) => text.includes('"vane"') && !text.includes('"flag"')
  );
  roundTrip(
    work,
    USB,
    docOp(USB, { kind: "set-play", gravity: [0, 0, -9.8] }),
    "set-play gravity",
    (text) => text.includes("-9.8")
  );
  roundTrip(
    work,
    SCENE,
    docOp(SCENE, {
      kind: "batch",
      label: "nudge",
      ops: [
        docOp(SCENE, { kind: "set-pose", id: "flag", pose: pose(0.04) }),
        docOp(SCENE, { kind: "set-param", id: "usb", name: "V", value: 4.5 }),
      ],
    }),
    "batch nudge",
    (text) => text.includes("0.04") && text.includes("4.5")
  );

  const sceneBefore = pairOf(work, SCENE);
  const rootLocks = [USB, COLLAPSED].map((rel) => ({
    path: lockPathFor(join(work, rel)),
    text: readFileSync(lockPathFor(join(work, rel)), "utf8"),
  }));
  const sequence: EditOp[] = [
    docOp(SCENE, { kind: "set-pose", id: "flag", pose: pose(0.03) }),
    docOp(SCENE, { kind: "set-pose", id: "servo", pose: pose(0.02) }),
    docOp(SCENE, { kind: "set-param", id: "usb", name: "V", value: 4.9 }),
    docOp(SCENE, { kind: "wire", a: "nano.D10", b: "servo.signal" }),
    docOp(SCENE, {
      kind: "add-instance",
      id: "extra",
      part: "sfab/led-red@1.0.0",
      pose: pose(0.05),
    }),
    docOp(SCENE, { kind: "set-pose", id: "extra", pose: pose(0.06) }),
    docOp(SCENE, { kind: "rename-instance", id: "extra", to: "lamp" }),
    docOp(SCENE, { kind: "set-play", gravity: [0, 0, -9.8] }),
    docOp(SCENE, { kind: "set-play", seed: 3 }),
    docOp(SCENE, {
      kind: "set-level",
      scope: "path",
      key: "servo",
      axis: "body",
      class: 1,
    }),
    docOp(SCENE, { kind: "rename-instance", id: "flag", to: "vane" }),
    docOp(SCENE, { kind: "unwire", a: "servo.mount", b: "vane.base" }),
    docOp(SCENE, { kind: "wire", a: "servo.mount", b: "vane.base" }),
    docOp(SCENE, {
      kind: "batch",
      label: "nudge",
      ops: [
        docOp(SCENE, { kind: "set-pose", id: "lamp", pose: pose(0.07) }),
        docOp(SCENE, { kind: "set-param", id: "usb", name: "V", value: 4.7 }),
      ],
    }),
    docOp(SCENE, { kind: "remove-instance", id: "lamp" }),
    docOp(SCENE, { kind: "set-play", timestep: 0.002 }),
    docOp(SCENE, {
      kind: "add-instance",
      id: "pad",
      part: "sfab/ground-plane@1.0.0",
    }),
    docOp(SCENE, { kind: "set-pose", id: "pad", pose: pose(0) }),
    docOp(SCENE, { kind: "remove-instance", id: "pad" }),
    docOp(SCENE, { kind: "unwire", a: "nano.D10", b: "servo.signal" }),
  ];
  expect(sequence.length === 20, `sequence ${sequence.length}`);
  const script = openSession(work, SCENE);
  for (let i = 0; i < sequence.length; i += 1) {
    const op = sequence[i];
    if (!op) throw new Error(`missing op ${i}`);
    const applied = script.apply(op);
    if ("error" in applied)
      throw new Error(`sequence ${i} ${op.kind}: ${applied.error}`);
  }
  loads(work, SCENE);
  const finalPair = pairOf(work, SCENE);
  let undos = 0;
  for (;;) {
    const undone = script.undo();
    if ("error" in undone) {
      expect(undone.error === "nothing to undo", undone.error);
      break;
    }
    undos += 1;
  }
  expect(undos === 20, `undos ${undos}`);
  expect(
    samePair(pairOf(work, SCENE), sceneBefore),
    "sequence undo is not byte-identical"
  );
  let redos = 0;
  for (;;) {
    const redone = script.redo();
    if ("error" in redone) {
      expect(redone.error === "nothing to redo", redone.error);
      break;
    }
    redos += 1;
  }
  expect(redos === 20, `redos ${redos}`);
  expect(
    samePair(pairOf(work, SCENE), finalPair),
    "sequence redo is not byte-identical"
  );
  console.log(
    "edit sequence: 20 ops undone to the original bytes, redone to the final bytes"
  );
  putPair(work, SCENE, sceneBefore);
  for (const lock of rootLocks) writeFileSync(lock.path, lock.text);

  reject(
    work,
    SCENE,
    docOp(SCENE, {
      kind: "add-instance",
      id: "ghost",
      part: "sfab/no-such@1.0.0",
    }),
    "not in the library"
  );
  reject(
    work,
    SCENE,
    docOp(SCENE, { kind: "set-param", id: "usb", name: "V", value: "five" }),
    "quantity Voltage"
  );
  reject(
    work,
    SCENE,
    docOp(SCENE, { kind: "wire", a: "nano.NOPE", b: "servo.signal" }),
    "does not exist"
  );
  reject(
    work,
    SCENE,
    docOp(SCENE, { kind: "wire", a: "nano.D10", b: "servo.shaft" }),
    "nano.D10 is electrical and servo.shaft is rotational"
  );
  reject(
    work,
    SCENE,
    docOp(SCENE, { kind: "wire", a: "nano.D10", b: "nano.D10" }),
    "nano.D10 cannot be wired to itself"
  );
  reject(
    work,
    SCENE,
    docOp(SCENE, { kind: "remove-instance", id: "missing" }),
    'no instance "missing"'
  );
  reject(
    work,
    SCENE,
    docOp(SCENE, {
      kind: "add-instance",
      id: "extra",
      part: "sfab/led-red@1.0.0",
      level: { body: "collapsed" },
    }),
    "add-instance level is not a class"
  );
  reject(
    work,
    USB,
    docOp(USB, {
      kind: "set-level",
      scope: "path",
      key: "servo",
      axis: "body",
      class: 1,
      variant: "no-such",
    }),
    "variant no-such is not on this part"
  );
  const catalogBefore = readFileSync(catalogLed, "utf8");
  const catalogWorld = catalogLed;
  const catalogSession = EditSession.open({
    file: absolutePath(catalogWorld),
    names: [catalogWorld],
    store: nodeStore,
    catalogDir: absolutePath(catalogRoot()),
    assetRoot: absolutePath(catalogRoot()),
  });
  if ("error" in catalogSession) throw new Error(catalogSession.error);
  const catalogEdit = catalogSession.apply(
    docOp(catalogWorld, {
      kind: "set-pose",
      id: "anything",
      pose: pose(1),
    })
  );
  expect("error" in catalogEdit, "catalog part was edited");
  if ("error" in catalogEdit) {
    expect(
      catalogEdit.error === "catalog part is read-only",
      catalogEdit.error
    );
    console.log(`edit rejected: ${catalogEdit.error}`);
  }
  expect(
    readFileSync(catalogLed, "utf8") === catalogBefore,
    "catalog part was written"
  );

  const external = openSession(work, USB);
  const externalBefore = pairOf(work, USB);
  const poked = external.apply(
    docOp(USB, { kind: "set-play", gravity: [0, 0, -9.7] })
  );
  if ("error" in poked) throw new Error(poked.error);
  writeFileSync(join(work, USB), externalBefore.part.replace("-9.81", "-9.82"));
  const refused = external.undo();
  expect("error" in refused, "undo accepted an external change");
  if ("error" in refused) {
    expect(refused.error === EXTERNAL_EDIT, refused.error);
    console.log(`edit undo refused: ${refused.error}`);
  }
  putPair(work, USB, externalBefore);
  await proveHeal(work, USB);
  await proveOrphan(work, USB);

  const editedLevel = openSession(frames, USB).apply(
    docOp(USB, {
      kind: "set-level",
      scope: "path",
      key: "servo",
      axis: "body",
      class: 1,
      variant: "collapsed",
    })
  );
  if ("error" in editedLevel) throw new Error(editedLevel.error);
  const editedRun = await recorded(frames, USB);
  const collapsedRun = await recorded(nanoDir, COLLAPSED);
  expect(editedRun.frames === collapsedRun.frames, "collapsed frames differ");
  expect(
    editedRun.serial.join("\n") === collapsedRun.serial.join("\n"),
    "collapsed serial differs"
  );
  const fields = differing(loads(frames, USB), loads(nanoDir, COLLAPSED));
  expect(
    fields.length === 2 && fields[0] === "lock" && fields[1] === "world",
    `collapsed report fields ${fields.join(", ")}`
  );
  console.log(
    `edit set-level path servo body collapsed: ${SPAN_MS} ms, ${editedRun.count} frames byte-identical, serial ${editedRun.serial.length} lines identical, report differs only in world, lock`
  );

  // The view's ports carry the type's domain and whether a wire in the
  // parent names them. The stage's port markers read these two fields.
  viewPorts(work, SCENE, ["nano.D9", "nano.D10", "servo.shaft", "servo.mount"]);
  viewPorts(arm, ARM_SCENE, [
    "uno.D9",
    "uno.D10",
    "servo.signal",
    "servo.shaft",
  ]);

  await runViewerContext(
    { root: tools, file: "", snapshot: emptySnapshot(), show: () => {} },
    async () => {
      const edited = await call(worldTools.world_edit, {
        world: USB,
        ops: [
          {
            kind: "set-pose",
            document: USB,
            id: "scene",
            pose: pose(0.01),
          },
        ],
      });
      expect(typeof edited === "string", JSON.stringify(edited));
      console.log(`world_edit: ${edited}`);
      const undone = await call(worldTools.world_undo, { world: USB });
      expect(typeof undone === "string", JSON.stringify(undone));
      console.log(`world_undo: ${undone}`);
      const redone = await call(worldTools.world_redo, { world: USB });
      expect(typeof redone === "string", JSON.stringify(redone));
      console.log(`world_redo: ${redone}`);

      const editRaw = JSON.stringify({
        type: "edit",
        ops: [
          {
            kind: "set-pose",
            document: USB,
            id: "ground",
            pose: pose(0),
          },
        ],
      });
      const editMsg = parseWorldClient(editRaw);
      if ("error" in editMsg) throw new Error(editMsg.error);
      if (editMsg.type !== "edit") throw new Error(editMsg.type);
      const editEvent = await handleLiveEdit(tools, USB, editMsg);
      expect(editEvent.type === "edited", JSON.stringify(editEvent));
      if (editEvent.type === "edited") {
        console.log(
          `socket edit: ${editEvent.label} undo ${editEvent.canUndo} redo ${editEvent.canRedo}`
        );
      }
      const undoMsg = parseWorldClient(JSON.stringify({ type: "undo" }));
      if ("error" in undoMsg || undoMsg.type !== "undo") {
        throw new Error("undo did not parse");
      }
      const undoEvent = await handleLiveEdit(tools, USB, undoMsg);
      expect(
        undoEvent.type === "edited" && undoEvent.canUndo,
        JSON.stringify(undoEvent)
      );
      if (undoEvent.type === "edited") {
        console.log(
          `socket undo: ${undoEvent.label} undo ${undoEvent.canUndo} redo ${undoEvent.canRedo}`
        );
      }
      const redoMsg = parseWorldClient(JSON.stringify({ type: "redo" }));
      if ("error" in redoMsg || redoMsg.type !== "redo") {
        throw new Error("redo did not parse");
      }
      const redoEvent = await handleLiveEdit(tools, USB, redoMsg);
      expect(redoEvent.type === "edited", JSON.stringify(redoEvent));
      if (redoEvent.type === "edited") {
        console.log(
          `socket redo: ${redoEvent.label} undo ${redoEvent.canUndo} redo ${redoEvent.canRedo}`
        );
      }

      const badLabel = parseWorldClient(
        JSON.stringify({
          type: "edit",
          label: 5,
          ops: [
            { kind: "set-pose", document: USB, id: "ground", pose: pose(0) },
          ],
        })
      );
      expect(
        "error" in badLabel && badLabel.error === "edit label must be a string",
        JSON.stringify(badLabel)
      );
      console.log("socket edit with a non-string label: refused as a label");

      // What the web's Move and Rotate tools send: one labelled set-pose in
      // the document frame with a scalar-first quaternion, then one undo.
      const beforeMove = pairOf(tools, USB);
      const quarter = Math.SQRT1_2;
      const moveRaw = JSON.stringify({
        type: "edit",
        label: "Move scene",
        ops: [
          {
            kind: "set-pose",
            document: USB,
            id: "scene",
            pose: {
              position: [0.1234, -0.0567, 0.006],
              rotation: [quarter, 0, 0, quarter],
            },
          },
        ],
      });
      const moveMsg = parseWorldClient(moveRaw);
      if ("error" in moveMsg) throw new Error(moveMsg.error);
      if (moveMsg.type !== "edit") throw new Error(moveMsg.type);
      const moveEvent = await handleLiveEdit(tools, USB, moveMsg);
      expect(
        moveEvent.type === "edited" && moveEvent.label === "Move scene",
        JSON.stringify(moveEvent)
      );
      const afterMove = pairOf(tools, USB);
      expect(!samePair(afterMove, beforeMove), "the web move wrote nothing");
      expect(
        afterMove.part.includes("0.1234") && afterMove.part.includes("0.7071"),
        "the web move is not in the part file"
      );
      const moveUndo = await handleLiveEdit(
        tools,
        USB,
        parseWorldClient(JSON.stringify({ type: "undo" })) as never
      );
      expect(moveUndo.type === "edited", JSON.stringify(moveUndo));
      expect(
        samePair(pairOf(tools, USB), beforeMove),
        "undo of the web move changed the files"
      );
      console.log(
        "socket set-pose from the web: labelled, wrote the pose, undo restored the files byte for byte"
      );

      // The tab Open part makes from the USB root: its world is the scene's
      // own file and the edit names that file, with no `part`. The part id
      // is a name only a nested owner's edit carries, with `part`.
      const beforeTab = pairOf(tools, SCENE);
      const tabMove = (document: string) =>
        parseWorldClient(
          JSON.stringify({
            type: "edit",
            label: "Move nano",
            ops: [
              {
                kind: "set-pose",
                document,
                id: "nano",
                pose: {
                  position: [0.0912, 0.0123, 0.004],
                  rotation: [1, 0, 0, 0],
                },
              },
            ],
          })
        );
      const byId = tabMove("sfab/nano-servo-scene@1.0.0");
      if ("error" in byId || byId.type !== "edit") throw new Error("parse");
      const refusedById = await handleLiveEdit(tools, SCENE, byId);
      expect(
        refusedById.type === "edit-refused" &&
          refusedById.kind === "edit" &&
          refusedById.message === "an edit names a different document",
        JSON.stringify(refusedById)
      );
      expect(
        samePair(pairOf(tools, SCENE), beforeTab),
        "a refused part-tab edit wrote"
      );
      const byFile = tabMove(SCENE);
      if ("error" in byFile || byFile.type !== "edit") throw new Error("parse");
      const tabEvent = await handleLiveEdit(tools, SCENE, byFile);
      expect(
        tabEvent.type === "edited" && tabEvent.label === "Move nano",
        JSON.stringify(tabEvent)
      );
      expect(
        pairOf(tools, SCENE).part.includes("0.0912"),
        "the part-tab move is not in the scene file"
      );
      const tabUndo = await handleLiveEdit(
        tools,
        SCENE,
        parseWorldClient(JSON.stringify({ type: "undo" })) as never
      );
      expect(tabUndo.type === "edited", JSON.stringify(tabUndo));
      expect(
        samePair(pairOf(tools, SCENE), beforeTab),
        "undo of the part-tab move changed the files"
      );
      console.log(
        "socket set-pose on a part tab: the tab's file is accepted, the part id is refused, undo restored the files byte for byte"
      );

      // What the Wire tool sends: one labelled wire on the tab's file, then
      // the two refusals, which write nothing, then one undo.
      const wireMsg = (a: string, b: string) => {
        const parsed = parseWorldClient(
          JSON.stringify({
            type: "edit",
            label: `Wire ${a} to ${b}`,
            ops: [{ kind: "wire", document: SCENE, a, b }],
          })
        );
        if ("error" in parsed || parsed.type !== "edit") {
          throw new Error("parse");
        }
        return parsed;
      };
      const beforeWire = pairOf(tools, SCENE);
      const wireEvent = await handleLiveEdit(
        tools,
        SCENE,
        wireMsg("nano.D10", "servo.signal")
      );
      expect(
        wireEvent.type === "edited" &&
          wireEvent.label === "Wire nano.D10 to servo.signal",
        JSON.stringify(wireEvent)
      );
      expect(
        pairOf(tools, SCENE).part.includes('["nano.D10", "servo.signal"]'),
        "the web wire is not in the scene file"
      );
      const afterWire = pairOf(tools, SCENE);
      for (const [a, b, text] of [
        [
          "nano.D10",
          "servo.shaft",
          "nano.D10 is electrical and servo.shaft is rotational; a wire joins ports of one domain",
        ],
        ["nano.D9", "nano.D9", "nano.D9 cannot be wired to itself"],
      ] as const) {
        const refused = await handleLiveEdit(tools, SCENE, wireMsg(a, b));
        expect(
          refused.type === "edit-refused" &&
            refused.kind === "edit" &&
            !!refused.message.includes(text) &&
            refused.refusal?.detail === text,
          JSON.stringify(refused)
        );
        expect(
          samePair(pairOf(tools, SCENE), afterWire),
          `a refused wire ${a} ${b} wrote`
        );
      }
      const wireUndo = await handleLiveEdit(
        tools,
        SCENE,
        parseWorldClient(JSON.stringify({ type: "undo" })) as never
      );
      expect(wireUndo.type === "edited", JSON.stringify(wireUndo));
      expect(
        samePair(pairOf(tools, SCENE), beforeWire),
        "undo of the web wire changed the files"
      );
      console.log(
        "socket wire from the web: labelled, wrote the wire, a domain mismatch and a self wire were refused without writing, undo restored the files byte for byte"
      );
    }
  );

  const refusedPart = partWriteRefusal("parts/sfab/nano-servo-usb@1.0.0.json");
  const refusedLock = partWriteRefusal(
    "parts/sfab/nano-servo-usb@1.0.0.lock.json"
  );
  expect(
    refusedPart === "part and lock files are edited with world_edit" &&
      refusedLock === refusedPart,
    `${refusedPart} ${refusedLock}`
  );
  console.log(`sandbox: ${refusedPart}`);
} finally {
  await stopWorld(tools, USB);
  await stopWorld(tools, SCENE);
  closeRootWatches();
  rmSync(work, { recursive: true, force: true });
  rmSync(arm, { recursive: true, force: true });
  rmSync(frames, { recursive: true, force: true });
  rmSync(tools, { recursive: true, force: true });
}

expect(worldWorkerCount() === 0, "a world worker was left behind");
console.log("edit-ops.selfcheck ok");

async function proveHeal(project: string, world: string) {
  const saved = pairOf(project, world);
  const session = openSession(project, world);
  const poked = session.apply(
    docOp(world, { kind: "set-play", gravity: [0, 0, -9.7] })
  );
  if ("error" in poked) throw new Error(poked.error);
  const healed = pairOf(project, world);
  putPair(project, world, saved);
  const file = realpathSync(join(project, world));
  const lock = lockPathFor(file);
  writeFileSync(`${file}.edit-tmp`, healed.part);
  writeFileSync(`${lock}.edit-tmp`, healed.lock ?? "");
  renameSync(`${file}.edit-tmp`, file);
  const ran = await runHeadless({ project, world, ms: 20 });
  expect(ran.frames > 0, "torn write did not load");
  expect(samePair(pairOf(project, world), healed), "torn write was not healed");
  expect(!existsSync(`${lock}.edit-tmp`), "lock marker remains");
  expect(!existsSync(`${file}.edit-tmp`), "part marker remains");
  console.log(
    `edit open: healed a torn write of ${basename(world)}, run loaded`
  );
  putPair(project, world, saved);
}

async function proveOrphan(project: string, world: string) {
  const saved = pairOf(project, world);
  const file = realpathSync(join(project, world));
  writeFileSync(`${file}.edit-tmp`, "not a part\n");
  const ran = await runHeadless({ project, world, ms: 20 });
  expect(ran.frames > 0, "orphan marker did not load");
  expect(!existsSync(`${file}.edit-tmp`), "orphan marker remains");
  expect(
    samePair(pairOf(project, world), saved),
    "orphan changed the document"
  );
  console.log(`edit open: removed an orphan part marker of ${basename(world)}`);
}

function call(
  tool: { execute?: (input: never, options: never) => unknown },
  input: unknown
): Promise<unknown> {
  const execute = tool.execute;
  if (!execute) throw new Error("tool has no execute");
  return Promise.resolve(execute(input as never, {} as never));
}

async function recorded(
  project: string,
  world: string
): Promise<{ frames: string; serial: string[]; count: number }> {
  const sim = new Sim({
    post() {
      /* serial is drained after the step */
    },
    now: () => performance.now(),
    schedule: (fn, ms) => setTimeout(fn, ms),
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
    await sim.step(SPAN_MS);
    const settled = sim.state();
    if (!settled) throw new Error(`${world} produced no state`);
    const body = sim.record({ op: "read", from: 0, to: settled.simTime });
    if (body.op !== "read") throw new Error(`${world} produced no recording`);
    return {
      frames: JSON.stringify(body.read.frames),
      serial: takeLines(sim.drainSerial()),
      count: body.read.frames.length,
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

function differing(
  left: RunReport | null | undefined,
  right: RunReport | null | undefined
): string[] {
  if (!left || !right) return ["missing"];
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]) as Set<
    keyof RunReport
  >;
  const fields: string[] = [];
  for (const key of keys) {
    if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) {
      fields.push(key);
    }
  }
  return fields.sort();
}
