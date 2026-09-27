/**
 * Level cards, world_set_level, and part visual boxes.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { emptySnapshot } from "@sfab-bench/contract";

import { levelCard, reasonWords } from "../../web/src/lib/level-card";
import { closeRootWatches } from "./projects";
import { runViewerContext } from "./viewer-context";
import { stopWorld, worldWorkerCount } from "./world/host";
import { replaceLevels } from "./world/level-edit";
import { planWorld } from "./world/plan";
import { viewOf } from "./world/view";
import { worldTools } from "./world-tools";

function expect(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(label);
}

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

const gauge = openReport(gaugeDir, "gauge-usb.world.json");
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

const class1 = openReport(nanoDir, "nano-vcc-class1.world.json");
const class1Nano = levelCard(class1.report, "nano");
expect(class1Nano?.snapshot !== null, "class 1 nano has a snapshot");
expect(
  class1Nano?.snapshot?.ref === "sfab/nano-usb-5v@1.0.0" &&
    class1Nano.snapshot.quality === "Q2a",
  `snapshot ${class1Nano?.snapshot?.ref} ${class1Nano?.snapshot?.quality}`
);
expect(
  class1Nano?.snapshot?.errors.some((line) =>
    line.startsWith("+5V free-run max ") &&
    line.includes("rms ") &&
    line.includes(" vs class 2")
  ) === true,
  `error ${class1Nano?.snapshot?.errors.join(" | ")}`
);
expect(
  class1Nano?.snapshot?.provenance ===
    "captured, from sfab/nano-ch340@1.0.0 class 2, fixture sfab/nano-usb-5v, tool sfab-bench-capture 1",
  `provenance ${class1Nano?.snapshot?.provenance}`
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

const vcc = openReport(nanoDir, "nano-vcc-usb.world.json");
const vccView = viewOf(vcc.plan);
expect(
  !vccView.boxes.some((box) => box.id === "flag"),
  "a URDF body with a visual box is not drawn twice"
);
expect(
  !vccView.boxes.some((box) => box.id === "servo"),
  "an sg90 whose visual resolved to a mesh is not a box"
);
const robotIds = new Set(vccView.robots.map((robot) => robot.id));
expect(
  vccView.boxes.every((box) => !robotIds.has(box.id)),
  "no box shares an id with a URDF body"
);
console.log("boxes: HC-SR04, MG90S, no URDF duplicate");

const root = mkdtempSync(join(tmpdir(), "sfab-levels-ui-"));
cpSync(nanoDir, root, { recursive: true });
const worldFile = join(root, "nano-vcc-usb.world.json");
const before = readFileSync(worldFile, "utf8");

try {
  await runViewerContext(
    { root, file: "", snapshot: emptySnapshot(), show: () => {} },
    async () => {
      const missing = await call(worldTools.world_set_level, {
        world: "nano-vcc-usb.world.json",
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
        world: "nano-vcc-usb.world.json",
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

      const set = await call(worldTools.world_set_level, {
        world: "nano-vcc-usb.world.json",
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
      expect(
        isRecord(snap) && snap.ref === "sfab/nano-usb-5v@1.0.0",
        `set snapshot ${JSON.stringify(snap)}`
      );
      const after = readFileSync(worldFile, "utf8");
      const originalLevels = (
        JSON.parse(before) as { run: { levels: never } }
      ).run.levels;
      expect(
        replaceLevels(after, originalLevels) === before,
        "the edit changed more than run.levels"
      );

      const cleared = await call(worldTools.world_set_level, {
        world: "nano-vcc-usb.world.json",
        scope: "path",
        key: "nano",
        class: null,
      });
      expect(!errorOf(cleared), `clear ${JSON.stringify(cleared)}`);
      const back = isRecord(cleared) && Array.isArray(cleared.rows) ? cleared.rows : [];
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
  await stopWorld(root, "nano-vcc-usb.world.json");
  closeRootWatches();
  rmSync(root, { recursive: true, force: true });
}

expect(worldWorkerCount() === 0, "a world worker was left behind");
console.log("world_set_level: path rule, restore, bad path, default");
console.log("levels-ui.selfcheck ok");
