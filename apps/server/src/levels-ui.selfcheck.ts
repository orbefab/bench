/**
 * Level cards, world_set_level, and part visual boxes.
 */

import { deepStrictEqual, ok as expect } from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  emptySnapshot,
  type WorldServerMessage,
  type WorldViewNode,
} from "@sfab-bench/contract";
import { contentHash, replaceLevels } from "@sfab-bench/parts";
import { viewOf } from "@sfab-bench/sim/view";
import { levelCard, reasonWords } from "../../web/src/lib/level-card";
import { closeRootWatches } from "./projects";
import { runViewerContext } from "./viewer-context";
import {
  attachWorld,
  stopWorld,
  type WorldHandle,
  worldWorkerCount,
} from "./world/host";
import { planWorld } from "./world/plan";
import { worldTools } from "./world-tools";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorOf(value: unknown): string {
  return isRecord(value) && typeof value.error === "string" ? value.error : "";
}

function call(
  tool: { execute?: (input: never, options: never) => unknown },
  input: unknown
): Promise<unknown> {
  const execute = tool.execute;
  if (!execute) throw new Error("tool has no execute");
  return Promise.resolve(execute(input as never, {} as never));
}

function openReport(project: string, world: string) {
  const planned = planWorld(project, world);
  if (!planned.ok) {
    throw new Error(planned.errors.map((item) => item.message).join("; "));
  }
  const report = planned.plan.report;
  if (!report) throw new Error(`${world} produced no report`);
  return { plan: planned.plan, report };
}

const gaugeDir = fileURLToPath(
  new URL("../../../examples/gauge/", import.meta.url)
);
const nanoDir = fileURLToPath(
  new URL("../../../examples/nano/", import.meta.url)
);

const gauge = openReport(gaugeDir, "parts/sfab/gauge-usb@1.0.0.json");
const nanoCard = levelCard(gauge.report, "nano");
expect(nanoCard !== null, "gauge nano has a level card");
const nanoBehaviour = nanoCard.axes.find((row) => row.axis === "behaviour");
expect(
  nanoBehaviour?.line === "behaviour 2 · circuits",
  `gauge nano behaviour ${nanoBehaviour?.line}`
);
expect(
  nanoBehaviour?.reason === "type rule arduino-nano",
  `gauge nano reason ${nanoBehaviour?.reason}`
);

const sensor = levelCard(gauge.report, "sensor");
const sensorVisual = sensor?.axes.find((row) => row.axis === "visual");
expect(
  sensorVisual?.reason === "fallback from 1",
  `sensor visual ${sensorVisual?.reason}`
);
expect(
  reasonWords(
    "fallback from 2 to 3 (only deeper; capture suggested)",
    "fallback"
  ) === "fallback from 2, capture suggested",
  "capture suggested stays on a deeper fallback"
);

const class1 = openReport(nanoDir, "parts/sfab/nano-vcc-class1@1.0.0.json");
const class1Nano = levelCard(class1.report, "nano");
expect(class1Nano?.snapshot === null, "class 1 nano carries its own snapshot");
const class1Power = class1Nano?.nested.find((row) => row.path === "nano.power");
expect(
  class1Power?.ref === "sfab/nano-power-input@1.0.0" &&
    class1Power.quality === "Q1",
  `snapshot ${class1Power?.ref} ${class1Power?.quality}`
);
expect(
  class1Power?.errors.some(
    (line) =>
      line.startsWith("VBUS static max ") && line.includes(" vs class 2")
  ) === true,
  `error ${class1Power?.errors.join(" | ")}`
);
expect(
  class1Power?.provenance ===
    "captured, from sfab/nano-power-input@1.0.0 class 2, fixture sfab/nano-power-input, tool sfab-bench-capture 1",
  `provenance ${class1Power?.provenance}`
);
expect(
  class1Nano?.omits.some((line) =>
    line.includes("rail capacitance (snapshot has no state)")
  ) === true,
  "class 1 omits the rail capacitance"
);
console.log(
  "level card: gauge nano type rule, sensor fallback, class 1 snapshot"
);

const nestedDir = mkdtempSync(join(tmpdir(), "sfab-nested-snap-"));
try {
  cpSync(nanoDir, nestedDir, { recursive: true });
  const nestedFile = join(nestedDir, "parts/sfab/nano-vcc-usb@1.0.0.json");
  const nestedWorld = JSON.parse(readFileSync(nestedFile, "utf8")) as {
    run?: { levels: { paths?: Record<string, { behaviour: number }> } };
    play?: { levels: { paths?: Record<string, { behaviour: number }> } };
  };
  const nestedLevels = nestedWorld.play?.levels ?? nestedWorld.run?.levels;
  if (!nestedLevels) throw new Error("nested world has no levels");
  nestedLevels.paths = {
    ...(nestedLevels.paths ?? {}),
    "nano.power": { behaviour: 1 },
  };
  writeFileSync(nestedFile, `${JSON.stringify(nestedWorld, null, 2)}\n`);
  const snapFile = fileURLToPath(
    new URL(
      "../catalog/snapshots/sfab/nano-power-input@1.0.0.json",
      import.meta.url
    )
  );
  const lockFile = join(nestedDir, "parts/sfab/nano-vcc-usb@1.0.0.lock.json");
  const lock = JSON.parse(readFileSync(lockFile, "utf8")) as {
    snapshots?: {
      id: string;
      path: string;
      sha256: string;
      source: string;
    }[];
  };
  lock.snapshots = [
    {
      id: "sfab/nano-power-input@1.0.0",
      path: "../../apps/server/catalog/snapshots/sfab/nano-power-input@1.0.0.json",
      sha256: contentHash(JSON.parse(readFileSync(snapFile, "utf8"))),
      source: "catalog",
    },
  ];
  writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
  const mixed = openReport(nestedDir, "parts/sfab/nano-vcc-usb@1.0.0.json");
  const boardCard = levelCard(mixed.report, "nano");
  const power = boardCard?.nested.find((row) => row.path === "nano.power");
  expect(
    power?.ref === "sfab/nano-power-input@1.0.0" &&
      power.quality.length > 0 &&
      power.errors.some((line) => line.includes("static max")) &&
      power.provenance !== null,
    `nested snapshot ${power?.path} ${power?.ref} ${power?.errors.join(" | ")}`
  );
  console.log(
    `level card: nested snapshot ${power?.path} · ${power?.ref} · ${power?.quality}`
  );
} finally {
  rmSync(nestedDir, { recursive: true, force: true });
}

const moduleWorld = openReport(
  nanoDir,
  "parts/sfab/nano-led-module@1.0.0.json"
);
const moduleView = viewOf(moduleWorld.plan);
const modulePart = moduleView.parts.find((part) => part.id === "module");
const moduleBox = moduleView.boxes.find((box) => box.id === "module");
expect(
  modulePart?.model === "led-module-red" && modulePart.signalPin === null,
  `module part ${JSON.stringify(modulePart)}`
);
expect(
  moduleBox?.pick === "part" &&
    moduleBox.size[0] === 0.01 &&
    moduleBox.size[1] === 0.005 &&
    moduleBox.size[2] === 0.008 &&
    moduleBox.pose.position[0] === 0.04 &&
    moduleBox.pose.position[2] === 0.004,
  `module box ${JSON.stringify(moduleBox)}`
);
const nanoBoard = moduleView.boards.find((board) => board.id === "nano");
const usbBox = moduleView.boxes.find((box) => box.id === "usb");
expect(
  nanoBoard?.pose.position[0] === 0 &&
    usbBox?.pose.position[0] === -0.04 &&
    moduleBox?.pose.position[0] === 0.04,
  "nano, usb, and module sit on separate poses"
);
console.log(`parts: ${modulePart?.id} · ${modulePart?.model}`);

/** Capture readiness and where each level comes from, as the card reads them. */
{
  const flat = (nodes: WorldViewNode[]): WorldViewNode[] =>
    nodes.flatMap((node) => [node, ...flat(node.children)]);
  const nodeAt = (view: ReturnType<typeof viewOf>, id: string) => {
    const node = flat(view.tree.nodes).find((item) => item.id === id);
    if (!node) throw new Error(`no node ${id}`);
    return node;
  };
  const axisOf = (node: WorldViewNode, axis: string) =>
    node.levels.find((row) => row.axis === axis);
  const nanoView = viewOf(
    openReport(nanoDir, "parts/sfab/nano-vcc-usb@1.0.0.json").plan
  );
  const power = nodeAt(nanoView, "nano.power");
  deepStrictEqual(axisOf(power, "behaviour")?.capture, { ready: true });
  // The SG90's class 2 is its gear train, motor, pot and control, and
  // each of them has a level.
  const servoOptions = (
    axisOf(nodeAt(nanoView, "servo"), "behaviour")?.options ?? []
  ).map(
    (opt) => `${opt.class}:${opt.variant}:${opt.runnable}:${opt.reason ?? ""}`
  );
  deepStrictEqual(servoOptions, [
    "0:slew:false:no runtime for form slew@1",
    "1:datasheet:true:",
    "2:netlist:true:",
  ]);
  expect(
    axisOf(power, "visual")?.capture === undefined,
    "a visual axis never captures"
  );
  const snap = axisOf(power, "behaviour")?.options.find(
    (opt) => opt.source === "snapshot"
  );
  expect(
    snap?.ref?.startsWith("sfab/nano-power-input") === true &&
      axisOf(power, "behaviour")?.options.some((opt) => opt.source === "part"),
    `catalog part: snapshot and part levels ${JSON.stringify(power.levels)}`
  );
  const board = nodeAt(nanoView, "nano");
  const noRecipe = axisOf(board, "behaviour")?.capture;
  expect(
    noRecipe?.ready === false &&
      noRecipe.reason === `no capture recipe for ${board.type}`,
    `board without a recipe ${JSON.stringify(noRecipe)}`
  );

  const dir = mkdtempSync(join(tmpdir(), "sfab-level-source-"));
  try {
    cpSync(nanoDir, dir, { recursive: true });
    const partId = "sfab/nano-power-input@1.0.0";
    const overlayFile = join(
      dir,
      "overlays/sfab/nano-power-input@1.0.0.levels.json"
    );
    mkdirSync(dirname(overlayFile), { recursive: true });
    writeFileSync(
      overlayFile,
      `${JSON.stringify(
        {
          format: "sfab.level-overlay@1",
          part: partId,
          axes: {
            behaviour: {
              "1": {
                variants: {
                  "behaviour-1": {
                    kind: "snapshot",
                    ref: "sfab/nano-power-input-behaviour-1@1.0.0",
                    omits: ["dynamic response"],
                  },
                },
              },
            },
          },
        },
        null,
        2
      )}\n`
    );
    const overlaid = nodeAt(
      viewOf(openReport(dir, "parts/sfab/nano-vcc-usb@1.0.0.json").plan),
      "nano.power"
    );
    const added = axisOf(overlaid, "behaviour")?.options.find(
      (opt) => opt.variant === "behaviour-1"
    );
    expect(
      overlaid.source === "catalog" || overlaid.source === "library",
      `overlaid part is a library part, not ${overlaid.source}`
    );
    expect(
      added?.source === "overlay" &&
        added.ref === "sfab/nano-power-input-behaviour-1@1.0.0",
      `overlay variant ${JSON.stringify(added)}`
    );
    expect(
      axisOf(overlaid, "behaviour")?.options.find(
        (opt) => opt.source === "snapshot"
      ),
      "the library's own snapshot level stays a snapshot"
    );

    const own = join(dir, "parts/sfab/nano-power-input@1.0.0.json");
    cpSync(
      fileURLToPath(
        new URL(
          "../catalog/parts/sfab/nano-power-input@1.0.0.json",
          import.meta.url
        )
      ),
      own
    );
    rmSync(overlayFile);
    const mine = nodeAt(
      viewOf(openReport(dir, "parts/sfab/nano-vcc-usb@1.0.0.json").plan),
      "nano.power"
    );
    expect(mine.source === "project", `project part is ${mine.source}`);
    expect(
      axisOf(mine, "behaviour")?.options.some(
        (opt) => opt.source === "snapshot"
      ) && axisOf(mine, "behaviour")?.capture?.ready === true,
      `project part snapshot ${JSON.stringify(mine.levels)}`
    );
    // Delete is offered on a capture, never on a level the part defines, and
    // "capture" is decided by where the snapshot file lives, not by a name.
    const authored = axisOf(mine, "behaviour")?.options.find(
      (opt) => opt.source === "snapshot"
    );
    expect(
      authored?.ref && authored.deletable === undefined,
      `a part's own snapshot is not deletable: ${JSON.stringify(authored)}`
    );
    expect(added?.deletable === true, "an overlay variant is deletable");
    const snapshotRel = `snapshots/${authored?.ref}.json`;
    const catalogSnapshots = fileURLToPath(
      new URL("../catalog/", import.meta.url)
    );
    mkdirSync(dirname(join(dir, snapshotRel)), { recursive: true });
    cpSync(join(catalogSnapshots, snapshotRel), join(dir, snapshotRel));
    const captured = axisOf(
      nodeAt(
        viewOf(openReport(dir, "parts/sfab/nano-vcc-usb@1.0.0.json").plan),
        "nano.power"
      ),
      "behaviour"
    )?.options.find((opt) => opt.variant === authored?.variant);
    expect(
      captured?.deletable === true,
      "a project part's variant with a snapshot in the project's snapshots/ is deletable"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(
    "level source: part, snapshot, overlay; capture ready on nano-power-input, reasoned without a recipe"
  );
}

const gaugeView = viewOf(gauge.plan);
const sensorBox = gaugeView.boxes.find((box) => box.id === "sensor");
const servoBox = gaugeView.boxes.find((box) => box.id === "servo");
expect(
  sensorBox?.pick === "part" &&
    sensorBox.size[0] === 0.045 &&
    sensorBox.size[1] === 0.02 &&
    sensorBox.size[2] === 0.015 &&
    sensorBox.pose.position[0] === 0 &&
    sensorBox.pose.position[1] === 0.0448 &&
    sensorBox.pose.position[2] === 0.03724,
  `sensor box ${JSON.stringify(sensorBox)}`
);
expect(
  servoBox?.pick === "part" &&
    servoBox.size[0] === 0.0228 &&
    servoBox.size[1] === 0.0122 &&
    servoBox.size[2] === 0.0285 &&
    servoBox.pose.position[2] === 0.01715,
  `servo box ${JSON.stringify(servoBox)}`
);
expect(
  !gaugeView.boxes.some((box) => box.id === "gauge"),
  "the gauge URDF is not also a box"
);
const ids = gaugeView.boxes.map((box) => box.id);
expect(new Set(ids).size === ids.length, `duplicate boxes ${ids.join(",")}`);

const vcc = openReport(nanoDir, "parts/sfab/nano-vcc-usb@1.0.0.json");
const vccView = viewOf(vcc.plan);
expect(
  !vccView.boxes.some((box) => box.id === "flag"),
  "a URDF body with a visual box is not drawn twice"
);
const vccServo = vccView.boxes.find((box) => box.id === "servo");
const vccServoVisual = levelCard(vcc.report, "servo")?.axes.find(
  (row) => row.axis === "visual"
);
expect(
  vccServo?.size[0] === 0.023 &&
    vccServo.size[1] === 0.0122 &&
    vccServo.size[2] === 0.029 &&
    vccServoVisual?.reason === "placeholder mesh; drawn as the class-0 box",
  "an sg90 placeholder mesh is drawn as the class-0 box"
);
const robotIds = new Set(vccView.robots.map((robot) => robot.id));
expect(
  vccView.boxes.every((box) => !robotIds.has(box.id)),
  "no box shares an id with a URDF body"
);
const servoUsb = openReport(nanoDir, "parts/sfab/nano-servo-usb@1.0.0.json");
const servoUsbBox = viewOf(servoUsb.plan).boxes.find(
  (box) => box.id === "servo"
);
expect(
  servoUsbBox?.size[0] === 0.023 &&
    servoUsbBox.size[1] === 0.0122 &&
    servoUsbBox.size[2] === 0.029 &&
    servoUsbBox.pose.position[0] === 0 &&
    servoUsbBox.pose.position[1] === 0 &&
    servoUsbBox.pose.position[2] === 0.0145 &&
    servoUsbBox.pose.rotation[0] === 1 &&
    servoUsbBox.pose.rotation[1] === 0 &&
    servoUsbBox.pose.rotation[2] === 0 &&
    servoUsbBox.pose.rotation[3] === 0,
  `nano-servo-usb servo box ${JSON.stringify(servoUsbBox)}`
);
console.log(
  `servo box nano-servo-usb: size [${servoUsbBox?.size.join(", ")}] pose [${servoUsbBox?.pose.position.join(", ")}] rot [${servoUsbBox?.pose.rotation.join(", ")}]`
);
const usbPose = (
  world: string,
  position: readonly [number, number, number]
) => {
  const box = viewOf(openReport(nanoDir, world).plan).boxes.find(
    (item) => item.id === "usb"
  );
  expect(
    box?.pose.position[0] === position[0] &&
      box.pose.position[1] === position[1] &&
      box.pose.position[2] === position[2] &&
      box.pose.rotation[0] === 1 &&
      box.pose.rotation[1] === 0 &&
      box.pose.rotation[2] === 0 &&
      box.pose.rotation[3] === 0,
    `${world} usb ${JSON.stringify(box?.pose)}`
  );
  console.log(
    `usb ${world}: position [${box?.pose.position.join(", ")}] rotation [${box?.pose.rotation.join(", ")}]`
  );
};
usbPose("parts/sfab/nano-led@1.0.0.json", [-0.038, 0, 0.0025]);
usbPose("parts/sfab/nano-divider@1.0.0.json", [-0.038, 0, 0.0025]);
usbPose("parts/sfab/nano-servo-usb@1.0.0.json", [0.042, 0, 0.0025]);
usbPose("parts/sfab/nano-vcc-usb@1.0.0.json", [0.042, 0, 0.0025]);
console.log(
  `gauge boxes unchanged: sensor [${sensorBox?.size.join(", ")}] at [${sensorBox?.pose.position.join(", ")}], MG90S [${servoBox?.size.join(", ")}] at z ${servoBox?.pose.position[2]}`
);
console.log("boxes: HC-SR04, MG90S, no URDF duplicate");

const root = mkdtempSync(join(tmpdir(), "sfab-levels-ui-"));
cpSync(nanoDir, root, { recursive: true });
const worldFile = join(root, "parts/sfab/nano-vcc-usb@1.0.0.json");
const lockFile = join(root, "parts/sfab/nano-vcc-usb@1.0.0.lock.json");
const partFile = join(root, "parts/sfab/flag@1.0.0.json");
const before = readFileSync(worldFile, "utf8");
const events: WorldServerMessage[] = [];
const held: WorldHandle[] = [];

try {
  await runViewerContext(
    { root, file: "", snapshot: emptySnapshot(), show: () => {} },
    async () => {
      const partBefore = readFileSync(partFile, "utf8");
      const lockBefore = readFileSync(lockFile, "utf8");
      writeFileSync(
        partFile,
        partBefore.replace("a box vane", "a drifted vane")
      );
      const drifted = await call(worldTools.world_set_level, {
        world: "parts/sfab/nano-vcc-usb@1.0.0.json",
        scope: "path",
        key: "nano",
        class: 1,
      });
      expect(
        errorOf(drifted).includes("lockfile") &&
          errorOf(drifted).includes("sfab/flag@1.0.0"),
        `drifted part ${JSON.stringify(drifted)}`
      );
      expect(
        readFileSync(worldFile, "utf8") === before,
        "drift wrote the world"
      );
      expect(
        readFileSync(lockFile, "utf8") === lockBefore,
        "drift rewrote the lock"
      );
      writeFileSync(partFile, partBefore);

      const handle = await attachWorld(
        root,
        "parts/sfab/nano-vcc-usb@1.0.0.json",
        {
          sender: { kind: "loopback", label: "Mac" },
          onEvent(event) {
            events.push(event);
          },
        }
      );
      if ("error" in handle) throw new Error(handle.error);
      held.push(handle);

      const missing = await call(worldTools.world_set_level, {
        world: "parts/sfab/nano-vcc-usb@1.0.0.json",
        scope: "path",
        key: "no-such-part",
        class: 1,
      });
      expect(
        errorOf(missing).includes("no path"),
        `bad path ${JSON.stringify(missing)}`
      );
      expect(readFileSync(worldFile, "utf8") === before, "bad path wrote");
      const removedDefault = await call(worldTools.world_set_level, {
        world: "parts/sfab/nano-vcc-usb@1.0.0.json",
        scope: "default",
        class: null,
      });
      expect(
        errorOf(removedDefault).includes("cannot be removed"),
        `remove default ${JSON.stringify(removedDefault)}`
      );
      expect(
        readFileSync(worldFile, "utf8") === before,
        "removing default wrote"
      );

      const reloadsAt = events.filter(
        (event) => event.type === "reloaded"
      ).length;
      const set = await call(worldTools.world_set_level, {
        world: "parts/sfab/nano-vcc-usb@1.0.0.json",
        scope: "path",
        key: "nano",
        class: 1,
      });
      expect(!errorOf(set), `set level ${JSON.stringify(set)}`);
      const rows = isRecord(set) && Array.isArray(set.rows) ? set.rows : [];
      const behaviour = rows.find(
        (row) =>
          isRecord(row) && row.path === "nano" && row.axis === "behaviour"
      );
      expect(
        isRecord(behaviour) && behaviour.line === "behaviour 1 · avr8js",
        `set row ${JSON.stringify(behaviour)}`
      );
      const snap = isRecord(behaviour) ? behaviour.snapshot : null;
      expect(!isRecord(snap), `set snapshot ${JSON.stringify(snap)}`);
      const planned = planWorld(root, "parts/sfab/nano-vcc-usb@1.0.0.json");
      if (!planned.ok) {
        throw new Error(planned.errors.map((item) => item.message).join("; "));
      }
      const setCard = levelCard(planned.plan.report ?? null, "nano");
      const setPower = setCard?.nested.find((row) => row.path === "nano.power");
      expect(
        setPower?.ref === "sfab/nano-power-input@1.0.0" &&
          setPower.quality === "Q1",
        `set power snapshot ${setPower?.ref} ${setPower?.quality}`
      );
      const after = readFileSync(worldFile, "utf8");
      const originalDoc = JSON.parse(before) as {
        run?: { levels: never };
        play?: { levels: never };
      };
      const originalLevels = (originalDoc.play ?? originalDoc.run)?.levels;
      if (originalLevels === undefined) {
        throw new Error("document has no levels");
      }
      expect(
        replaceLevels(after, originalLevels) === before,
        "the edit changed more than run.levels"
      );
      // The host has no reload counter. Subscribers see `reloaded`. Wait for
      // the first one, then well past the watcher's 250 ms debounce, so a
      // slow runner cannot pass or fail on timing alone.
      const reloadCount = () =>
        events.filter((event) => event.type === "reloaded").length;
      for (let i = 0; i < 100 && reloadCount() === reloadsAt; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const reloads = reloadCount();
      expect(reloads - reloadsAt === 1, `reloads ${reloads - reloadsAt}`);

      const cleared = await call(worldTools.world_set_level, {
        world: "parts/sfab/nano-vcc-usb@1.0.0.json",
        scope: "path",
        key: "nano",
        class: null,
      });
      expect(!errorOf(cleared), `clear ${JSON.stringify(cleared)}`);
      const back =
        isRecord(cleared) && Array.isArray(cleared.rows) ? cleared.rows : [];
      const restored = back.find(
        (row) =>
          isRecord(row) && row.path === "nano" && row.axis === "behaviour"
      );
      expect(
        isRecord(restored) &&
          restored.line === "behaviour 2 · circuits" &&
          restored.reason === "type rule arduino-nano" &&
          restored.snapshot === undefined,
        `restored ${JSON.stringify(restored)}`
      );
      expect(
        readFileSync(worldFile, "utf8") === before,
        "removing the path rule did not restore the file"
      );
    }
  );
} finally {
  for (const handle of held) handle.detach();
  await stopWorld(root, "parts/sfab/nano-vcc-usb@1.0.0.json");
  closeRootWatches();
  rmSync(root, { recursive: true, force: true });
}

expect(worldWorkerCount() === 0, "a world worker was left behind");
console.log(
  "world_set_level: path rule, restore, bad path, default, drifted part, one restart"
);
console.log("levels-ui.selfcheck ok");
