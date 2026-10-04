/**
 * Every capture runner reads its source the way the world does: the
 * project, then the catalog (layered-sim M1c). So:
 *
 * - a group capture of a project shadow with an edited child (the SG90
 *   control's `eSat`) reduces the edited value, and is fresh in that
 *   project and stale against the catalog alone;
 * - a project-only group (its own id, inline type, its own control) runs
 *   in the scene in place of the scene's instance of the same type; one
 *   of another type is refused;
 * - a hinge capture of a project shadow with an edited gear train fits
 *   that train (output friction ×1.1: a heavier rotor no longer reaches
 *   the shaft's rated speed on the fixture, and the runner refuses it); a project-only part's hinge capture works;
 * - the card's readiness and the run refuse a source with the same reason;
 * - the catalog's bytes do not change.
 */

import { ok as expect } from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
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

import type {
  PartFile,
  PartTypeFile,
  SnapshotFile,
  WorldViewNode,
} from "@sfab-bench/contract";
import type { AnyCaptureEntry, CaptureFile } from "@sfab-bench/sim/capture";
import { provenanceHash } from "@sfab-bench/sim/freshness";
import { viewOf } from "@sfab-bench/sim/view";
import { captureFromConfig } from "./capture";
import { planWorld } from "./world/plan";
import { nodeStampEnv } from "./world/plan-host";

const catalog = fileURLToPath(new URL("../catalog/", import.meta.url));
const armExample = fileURLToPath(
  new URL("../../../examples/arm/", import.meta.url)
);
const SG90 = "sfab/sg90@1.0.0";
const CONTROL = "sfab/sg90-control@1.0.0";

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}

function partFile(dir: string, id: string): string {
  const slash = id.indexOf("/");
  return join(dir, "parts", id.slice(0, slash), `${id.slice(slash + 1)}.json`);
}

function catalogPart(id: string): PartFile {
  return readJson(partFile(catalog, id));
}

function treeHash(dir: string): string {
  const hash = createHash("sha256");
  const walk = (at: string) => {
    for (const name of readdirSync(at).sort()) {
      const file = join(at, name);
      if (statSync(file).isDirectory()) walk(file);
      else hash.update(file).update(readFileSync(file));
    }
  };
  walk(dir);
  return hash.digest("hex");
}

const config = readJson<CaptureFile<AnyCaptureEntry>>(
  join(catalog, "fixtures", "capture.config.json")
);
function entry(id: string): AnyCaptureEntry {
  const found = config.entries.find((row) => row.id === id);
  if (!found) throw new Error(`no capture entry ${id}`);
  return structuredClone(found);
}
/** The SG90 group recipe on a shorter scene, so the check stays quick. */
function groupEntry(part: string, id: string): AnyCaptureEntry {
  const row = entry("sfab/sg90-servo@1.0.0");
  if (!("scene" in row)) throw new Error("the SG90 entry is not a group");
  return { ...row, part, id, scene: { ...row.scene, ms: 500 } };
}
function hingeEntry(part: string, id: string): AnyCaptureEntry {
  return { ...entry("sfab/sg90-hinge@1.0.0"), part, id };
}

async function capture(
  project: string,
  row: AnyCaptureEntry
): Promise<SnapshotFile> {
  const out = join(project, "out.json");
  await captureFromConfig({
    config: { created: config.created, tool: config.tool, entries: [row] },
    catalogDir: catalog,
    projectDir: project,
    outFile: out,
  });
  const snap = readJson<SnapshotFile>(out);
  rmSync(out);
  return snap;
}

async function refusal(project: string, row: AnyCaptureEntry): Promise<string> {
  try {
    await capture(project, row);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error(`${row.part} captured where it should be refused`);
}

/** Fresh in the project it was taken from; stale against the catalog alone. */
function freshIn(project: string, snap: SnapshotFile, label: string): void {
  const here = provenanceHash(
    snap,
    { catalogDir: catalog, worldDir: project },
    nodeStampEnv
  );
  expect(
    here.checked && here.hash === snap.provenance.from?.hash,
    `${label}: not fresh in its project (${JSON.stringify(here)})`
  );
}

type Shaft = { name: string; frictionloss: number };
function outputShaft(part: PartFile): Shaft {
  const impl = part.axes?.body?.["2"]?.variants["gear-train"];
  if (impl?.kind !== "gear-train") throw new Error("no gear train");
  const train = impl as unknown as { output: string; shafts: Shaft[] };
  const shaft = train.shafts.find((row) => row.name === train.output);
  if (!shaft) throw new Error("the gear train has no output shaft");
  return shaft;
}

function controlParams(part: PartFile): Record<string, number> {
  const impl = part.axes?.behaviour?.["1"]?.variants.model;
  if (impl?.kind !== "form") throw new Error(`${part.id} has no model form`);
  return impl.params as Record<string, number>;
}

const catalogBefore = treeHash(catalog);
const catalogServo = readJson<SnapshotFile>(
  join(catalog, "snapshots/sfab/sg90-servo@1.0.0.json")
);
const catalogHinge = readJson<SnapshotFile>(
  join(catalog, "snapshots/sfab/sg90-hinge@1.0.0.json")
);

const project = mkdtempSync(join(tmpdir(), "capture-source-"));
try {
  // 1. A project shadow of the control with another eSat.
  const control = catalogPart(CONTROL);
  controlParams(control).eSat = 0.4;
  writeJson(partFile(project, CONTROL), control);
  const shadowed = await capture(
    project,
    groupEntry(SG90, "sfab/sg90-servo@1.0.0")
  );
  expect(
    shadowed.params.eSat === 0.4,
    `the shadow capture reduced eSat ${shadowed.params.eSat}`
  );
  freshIn(project, shadowed, "control shadow");
  const againstCatalog = provenanceHash(
    shadowed,
    { catalogDir: catalog, worldDir: catalog },
    nodeStampEnv
  );
  expect(
    againstCatalog.checked &&
      againstCatalog.hash !== shadowed.provenance.from?.hash &&
      catalogServo.provenance.from?.hash !== shadowed.provenance.from?.hash,
    "the shadow capture signs the catalog's source"
  );
  console.log(
    `capture-source: group of an eSat 0.4 control shadow reduces eSat ${shadowed.params.eSat}, fresh in the project, stale against the catalog`
  );
  rmSync(partFile(project, CONTROL));

  // 2. A project-only group: its own id, an inline type, its own control.
  const LOCAL = "local/servo@1.0.0";
  const LOCAL_CONTROL = "local/servo-control@1.0.0";
  const servoType = readJson<PartTypeFile>(
    join(catalog, "types", "hobby-servo-3wire.json")
  );
  const local = catalogPart(SG90);
  local.id = LOCAL;
  local.type = servoType;
  const levels = local.axes?.behaviour;
  const group = levels?.["1"]?.variants.group;
  const netlist = levels?.["2"]?.variants.netlist;
  if (group?.kind !== "snapshot" || netlist?.kind !== "composite") {
    throw new Error("the SG90 copy has no group snapshot or netlist");
  }
  group.ref = "local/servo-group@1.0.0";
  const controlSlot = netlist.netlist.instances.control;
  if (!controlSlot) throw new Error("the SG90 netlist has no control");
  controlSlot.part = LOCAL_CONTROL;
  writeJson(partFile(project, LOCAL), local);
  const localControl = catalogPart(CONTROL);
  localControl.id = LOCAL_CONTROL;
  controlParams(localControl).eSat = 0.5;
  writeJson(partFile(project, LOCAL_CONTROL), localControl);
  const own = await capture(
    project,
    groupEntry(LOCAL, "local/servo-group@1.0.0")
  );
  expect(
    own.part === LOCAL &&
      own.provenance.from?.part === LOCAL &&
      own.params.eSat === 0.5,
    `the project-only group capture ran ${own.part} with eSat ${own.params.eSat}`
  );
  freshIn(project, own, "project-only group");
  console.log(
    `capture-source: project-only ${LOCAL} (inline type, own control) runs in the scene's servo slot, eSat ${own.params.eSat}, fresh`
  );

  // Another type does not take the scene instance's place.
  const other = structuredClone(local);
  other.id = "local/other@1.0.0";
  other.type = { ...servoType, id: "hobby-servo-other" };
  writeJson(partFile(project, other.id), other);
  const wrongType = await refusal(
    project,
    groupEntry(other.id, "local/other-group@1.0.0")
  );
  expect(
    wrongType.includes("is a hobby-servo-3wire") &&
      wrongType.includes("hobby-servo-other"),
    `another type's refusal: ${wrongType}`
  );
  console.log(`capture-source: another type is refused (${wrongType})`);

  // 3. Hinge: an edited project shadow, and the project-only part.
  const heavy = catalogPart(SG90);
  outputShaft(heavy).frictionloss *= 1.1;
  writeJson(partFile(project, SG90), heavy);
  const heavyHinge = await capture(
    project,
    hingeEntry(SG90, "sfab/sg90-hinge@1.0.0")
  );
  expect(
    heavyHinge.params.frictionloss !== catalogHinge.params.frictionloss,
    "the hinge capture fitted the catalog's gear train"
  );
  freshIn(project, heavyHinge, "gear-train shadow");
  rmSync(partFile(project, SG90));
  const localHinge = await capture(
    project,
    hingeEntry(LOCAL, "local/servo-hinge@1.0.0")
  );
  expect(
    localHinge.provenance.from?.part === LOCAL &&
      localHinge.params.frictionloss === catalogHinge.params.frictionloss,
    `project-only hinge frictionloss ${localHinge.params.frictionloss}`
  );
  freshIn(project, localHinge, "project-only hinge");
  console.log(
    `capture-source: hinge frictionloss ${catalogHinge.params.frictionloss} → ${heavyHinge.params.frictionloss} with the output friction ×1.1 shadow; project-only hinge ${localHinge.params.frictionloss}`
  );
} finally {
  rmSync(project, { recursive: true, force: true });
}

// 4. Readiness and the run agree: a shadow with no class 2 composite.
const arm = mkdtempSync(join(tmpdir(), "capture-source-arm-"));
try {
  cpSync(armExample, arm, { recursive: true });
  const flat = (nodes: WorldViewNode[]): WorldViewNode[] =>
    nodes.flatMap((node) => [node, ...flat(node.children)]);
  const servoCapture = () => {
    const planned = planWorld(arm, "parts/sfab/arm-bench@1.0.0.json");
    if (!planned.ok) {
      throw new Error(planned.errors.map((row) => row.message).join("; "));
    }
    const node = flat(viewOf(planned.plan).tree.nodes).find(
      (item) => item.id === "servo"
    );
    return node?.levels.find((row) => row.axis === "behaviour")?.capture;
  };
  const ready = servoCapture();
  expect(
    ready?.ready === true,
    `the arm servo is not ready: ${JSON.stringify(ready)}`
  );
  const flatServo = catalogPart(SG90);
  if (flatServo.axes?.behaviour) delete flatServo.axes.behaviour["2"];
  writeJson(partFile(arm, SG90), flatServo);
  const notReady = servoCapture();
  const reason = notReady && !notReady.ready ? notReady.reason : "";
  expect(
    reason.length > 0,
    `a servo with no netlist is ready: ${JSON.stringify(notReady)}`
  );
  const refused = await refusal(arm, groupEntry(SG90, "sfab/sg90-servo@1.0.0"));
  expect(
    refused === reason,
    `readiness says "${reason}", the run "${refused}"`
  );
  console.log(`capture-source: readiness and the run both refuse: ${reason}`);
} finally {
  rmSync(arm, { recursive: true, force: true });
}

expect(treeHash(catalog) === catalogBefore, "a capture changed the catalog");
console.log("capture-source: catalog bytes unchanged");
console.log("capture-source.selfcheck ok");
