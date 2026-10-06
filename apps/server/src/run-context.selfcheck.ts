/**
 * The frozen run context (run 7 unit 4, `@sfab-bench/sim/run-context`), on
 * a copy of the arm example and its assembly check:
 *
 * - a side at the record's snapshot levels is the run the record measured
 *   (`context`), and the record applies to it;
 * - after the context opened, a firmware image, a URDF mass, a mesh byte
 *   and a project file that would shadow a catalog part change on disk.
 *   The side still plans, builds and runs from the copies: the same
 *   context and the same observations as before the edits. A context
 *   opened afterwards sees every change;
 * - a missing file stays missing: the catalog part keeps answering;
 * - the context writes nothing;
 * - the authored lock is validated once, on opening; a side hides it;
 * - selections named on opening leave nothing to read late; a side at
 *   levels not named reads its snapshot files late, and says so;
 * - the manifest names each file the run read, by project or catalog
 *   path, with the hash of its bytes;
 * - a supply reads its own output on its positive port, negative.
 */

import { ok as expect } from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Bytes } from "@sfab-bench/parts";
import { describe, descriptorId } from "@sfab-bench/sim/observe";
import {
  openContext,
  planSide,
  runSide,
  type Selection,
} from "@sfab-bench/sim/run-context";
import { nodeRunClock, nodeRunFiles } from "./world/run-host";

const example = fileURLToPath(
  new URL("../../../examples/arm/", import.meta.url)
);
const catalog = fileURLToPath(new URL("../catalog/", import.meta.url));
const WORLD = "parts/sfab/arm-bench@1.0.0.json";
const RECORD = "checks/sfab/arm-bench@1.0.0.json";
const FIRMWARE = "firmware/hold/hold.hex";
const URDF = "robot/arm.urdf";
const MESH = "robot/meshes/base.stl";
const SHADOW = "parts/sfab/sg90@1.0.0.json";
const GONE = "robot/meshes/upper_arm.stl";
const ALIAS = "robot/alias.urdf";

const reads = (fn: () => unknown) => {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
};

const record = JSON.parse(readFileSync(join(example, RECORD), "utf8")) as {
  context: string;
  snapshot: Selection;
  detailed: Selection;
};
const shaft = describe("servo.shaft.angle", "frame");
const draw = describe("usb.5V.current", "frame");

const root = mkdtempSync(join(tmpdir(), "sfab-run-context-"));
try {
  cpSync(example, root, { recursive: true });
  const at = (rel: string) => join(root, rel);

  // The snapshot side is the record's run, and the record applies.
  const context = openContext(nodeRunFiles, root, WORLD, {
    selections: [record.snapshot],
  });
  expect(context.authored.ok, "the arm bench plans as authored");
  const before = planSide(context, record.snapshot).context;
  expect(
    before === record.context,
    `the snapshot side is the record's context: ${before} vs ${record.context}`
  );
  const manifest = context.manifest();
  const held = (file: string) =>
    manifest.find((row) => row.file === file)?.sha256;
  for (const file of [WORLD, `${WORLD.slice(0, -5)}.lock.json`, RECORD]) {
    expect(
      held(file) === sha256Bytes(readFileSync(at(file))),
      `the manifest holds ${file}: ${held(file)}`
    );
  }
  for (const file of [FIRMWARE, URDF, MESH]) {
    expect(
      held(file) === sha256Bytes(readFileSync(at(file))),
      `the manifest holds the run's input ${file}: ${held(file)}`
    );
  }
  expect(
    held("catalog/parts/sfab/sg90@1.0.0.json") ===
      sha256Bytes(readFileSync(join(catalog, "parts/sfab/sg90@1.0.0.json"))),
    "the manifest holds the catalog part the project does not shadow"
  );
  expect(
    held(SHADOW) === "missing",
    `the project's miss is held as a miss: ${held(SHADOW)}`
  );

  const observe = () =>
    runSide(context, record.snapshot, [shaft, draw], {
      ms: 200,
      host: nodeRunClock,
    });
  const first = await observe();

  // Every input changes on disk after the context opened.
  writeFileSync(at(FIRMWARE), ":00000001FF\nnot intel hex\n");
  const urdf = readFileSync(at(URDF), "utf8");
  const heavier = urdf.replace(
    /<mass value="([0-9.eE+-]+)"/,
    (_, mass: string) => `<mass value="${Number(mass) * 2}"`
  );
  expect(heavier !== urdf, "the URDF has a mass to edit");
  writeFileSync(at(URDF), heavier);
  const mesh = readFileSync(at(MESH));
  mesh[100] = (mesh[100] ?? 0) ^ 0xff;
  writeFileSync(at(MESH), mesh);
  const servo = JSON.parse(
    readFileSync(join(catalog, "parts/sfab/sg90@1.0.0.json"), "utf8")
  ) as { sources?: { title: string; ref: string }[] };
  servo.sources = [...(servo.sources ?? []), { title: "shadow", ref: "copy" }];
  writeFileSync(at(SHADOW), JSON.stringify(servo));

  const side = await observe();
  expect(
    JSON.stringify([...side.series]) === JSON.stringify([...first.series]),
    "the side runs the frozen firmware, URDF and meshes: its series are the ones before the edits"
  );
  expect(
    side.context === before && side.report.accuracy?.applies === true,
    `the side runs from the copies: ${side.context}, applies ${String(side.report.accuracy?.applies)}`
  );
  expect(
    (side.series.get(descriptorId(shaft)) ?? []).length === 21,
    "the side observed every frame"
  );
  const amps = (side.series.get(descriptorId(draw)) ?? []).map(
    (row) => row.value
  );
  expect(
    amps.length === 21 && amps.every((value) => value < -0.01),
    `the supply sources its draw: ${amps.slice(0, 3).join(", ")}`
  );
  const servoPin = (lock: { parts: { id: string; sha256: string }[] }) =>
    lock.parts.find((row) => row.id === "sfab/sg90@1.0.0")?.sha256;
  const pinned = servoPin(planSide(context, record.snapshot).report.lock);
  expect(
    pinned !== undefined && servoPin(side.report.lock) === pinned,
    "the catalog part still answers on the side"
  );
  expect(context.late().length === 0, `late reads ${context.late()}`);

  const after = openContext(nodeRunFiles, root, WORLD);
  const fresh = planSide(after, record.snapshot).context;
  expect(fresh !== before, "a context opened after the edits sees them");
  for (const file of [FIRMWARE, URDF, MESH, SHADOW]) {
    const was = held(file);
    const now = after.manifest().find((row) => row.file === file)?.sha256;
    expect(was !== now, `${file} moved on disk: ${was} vs ${now}`);
  }
  expect(
    servoPin(planSide(after, record.snapshot).report.lock) !== pinned,
    "the project's copy shadows the catalog part in a new context"
  );

  // The copies answer whatever the disk does: a held file that is
  // deleted, a miss that appears, and a second spelling of a held file.
  const files = context.files();
  const asHeld = (rel: string) => join(context.root, rel);
  const gone = readFileSync(at(GONE));
  rmSync(at(GONE));
  expect(
    files.readInside(context.root, GONE)?.length === gone.length &&
      files.plan.readBytes?.(asHeld(GONE)).length === gone.length,
    "a deleted file is still its copy, to the engines and the planner"
  );
  expect(
    !files.plan.exists(asHeld(SHADOW)) &&
      files.readInside(context.root, SHADOW) === null &&
      !reads(() => files.plan.readText(asHeld(SHADOW))),
    "a miss that appeared on disk stays a miss on every surface"
  );
  symlinkSync(at(URDF), at(ALIAS));
  expect(
    new TextDecoder().decode(
      files.readInside(context.root, ALIAS) ?? new Uint8Array()
    ) === urdf,
    "a second spelling of a held file reads its copy"
  );
  expect(
    context.late().includes(ALIAS),
    `a new spelling is a late read, by its project path: ${context.late()}`
  );

  // The context writes nothing.
  let refused = "";
  try {
    context.files().plan.store.writeText(at("parts/sfab/x@1.0.0.json"), "{}");
  } catch (err) {
    refused = String(err);
  }
  expect(refused.includes("does not write"), `a write: ${refused}`);

  // The lock is validated on opening; a side does not read it.
  cpSync(example, root, { recursive: true });
  rmSync(at(SHADOW));
  const lockFile = at(`${WORLD.slice(0, -5)}.lock.json`);
  const lock = JSON.parse(readFileSync(lockFile, "utf8")) as {
    parts: { id: string; sha256: string }[];
  };
  const scene = lock.parts.find((row) => row.id === "sfab/arm-scene@1.0.0");
  if (!scene) throw new Error("the lock pins the scene");
  scene.sha256 = "0".repeat(64);
  writeFileSync(lockFile, JSON.stringify(lock));
  const locked = openContext(nodeRunFiles, root, WORLD);
  const said = locked.authored.ok
    ? [
        ...(locked.authored.plan.degraded ?? []),
        ...(locked.authored.plan.report?.errors ?? []),
      ]
    : locked.authored.errors;
  expect(
    said.some((row) => /lock/i.test(row.message)),
    `the authored lock is checked: ${JSON.stringify(said.map((row) => row.message))}`
  );
  const unlocked = planSide(locked, record.snapshot);
  expect(
    unlocked.context === before && (unlocked.plan.degraded ?? []).length === 0,
    `a side hides the authored lock: ${unlocked.context}`
  );

  // Levels not named on opening read their snapshot files late.
  const late = openContext(nodeRunFiles, root, WORLD);
  planSide(late, record.snapshot);
  expect(
    late.late().some((file) => file.includes("snapshots")),
    `late reads are listed: ${late.late().join(", ")}`
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("run-context.selfcheck ok");
