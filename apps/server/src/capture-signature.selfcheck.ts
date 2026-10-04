/**
 * A capture is stale exactly when its source changed (layered-sim M1b).
 * The capture runners and freshness share one signature
 * (`capture-signature.ts`), so:
 *
 * - every catalog snapshot recomputes to its recorded `from.hash`;
 * - a law param of a part inside the source dirties it: the Uno power
 *   input's PTC fuse `rCold` and PMOS `rds`/`vth`, the SG90 control's
 *   `eSat`, the SG90 gear train;
 * - an edit that cannot change the run leaves it fresh: a child's visual
 *   axis or citations, the root's visual axis;
 * - a provenance that does not name its variant is unchecked, with why;
 * - in a world, a project shadow of the fuse with another `rCold` marks
 *   the Uno capture stale; the unedited world marks it fresh.
 */

import { ok as expect } from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PartFile, SnapshotFile } from "@sfab-bench/contract";
import { provenanceHash } from "@sfab-bench/sim/freshness";
import { planWorld } from "./world/plan";
import { nodeStampEnv } from "./world/plan-host";

const catalog = fileURLToPath(new URL("../catalog/", import.meta.url));
const armExample = fileURLToPath(
  new URL("../../../examples/arm/", import.meta.url)
);

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function snapshot(name: string): SnapshotFile {
  return readJson(join(catalog, "snapshots/sfab", `${name}@1.0.0.json`));
}

function catalogPart(id: string): PartFile {
  return readJson(join(catalog, "parts", `${id}.json`));
}

type Edit = (part: PartFile) => void;

/** The snapshot's signature with project shadows of some parts, edited. */
function signatureWith(
  snap: SnapshotFile,
  edits: Record<string, Edit>
): ReturnType<typeof provenanceHash> {
  const project = mkdtempSync(join(tmpdir(), "capture-signature-"));
  try {
    for (const [id, edit] of Object.entries(edits)) {
      const part = catalogPart(id);
      edit(part);
      const file = join(project, "parts", `${id}.json`);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, JSON.stringify(part));
    }
    return provenanceHash(
      snap,
      { catalogDir: catalog, worldDir: project, assetRoot: project },
      nodeStampEnv
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

function formParams(
  part: PartFile,
  level: string,
  variant: string
): Record<string, unknown> {
  const impl = part.axes?.behaviour?.[level as "1"]?.variants[variant];
  if (impl?.kind !== "form")
    throw new Error(`${part.id} ${variant} is no form`);
  return impl.params as Record<string, unknown>;
}

function gearTrain(part: PartFile): { shafts: { inertia: number }[] } {
  const impl = part.axes?.body?.["2"]?.variants["gear-train"];
  if (impl?.kind !== "gear-train") throw new Error("no gear train");
  return impl as unknown as { shafts: { inertia: number }[] };
}

const dropVisual: Edit = (part) => {
  if (part.axes) part.axes.visual = undefined;
};
const cite: Edit = (part) => {
  part.sources = [
    ...(part.sources ?? []),
    { title: "An added citation", ref: "https://example.com" },
  ];
};

// 1. Every catalog snapshot recomputes to what it records.
for (const name of readdirSync(join(catalog, "snapshots/sfab")).sort()) {
  const snap = readJson<SnapshotFile>(join(catalog, "snapshots/sfab", name));
  const fresh = signatureWith(snap, {});
  expect(
    fresh.checked && fresh.hash === snap.provenance.from?.hash,
    `${name}: ${fresh.checked ? fresh.hash : fresh.reason} vs ${snap.provenance.from?.hash}`
  );
}
console.log("capture-signature: every catalog snapshot is fresh");

// 2. Source edits dirty it; edits that cannot change the run do not.
const FUSE = "sfab/mf-msmf050@1.0.0";
const PMOS = "sfab/fdn340p@1.0.0";
const CONTROL = "sfab/sg90-control@1.0.0";
const SG90 = "sfab/sg90@1.0.0";
const UNO = "sfab/uno-power-input@1.0.0";
const cases: [string, SnapshotFile, Record<string, Edit>, boolean][] = [
  [
    "uno fuse rCold 0.15 → 0.30 Ω",
    snapshot("uno-power-input"),
    { [FUSE]: (part) => (formParams(part, "1", "thermal").rCold = 0.3) },
    true,
  ],
  [
    "uno PMOS rds 0.06 → 0.12 Ω",
    snapshot("uno-power-input"),
    { [PMOS]: (part) => (formParams(part, "1", "switch").rds = 0.12) },
    true,
  ],
  [
    "uno PMOS vth −0.8 → −1.0 V",
    snapshot("uno-power-input"),
    { [PMOS]: (part) => (formParams(part, "1", "switch").vth = -1) },
    true,
  ],
  [
    "uno fuse visual axis",
    snapshot("uno-power-input"),
    { [FUSE]: dropVisual },
    false,
  ],
  ["uno fuse citations", snapshot("uno-power-input"), { [FUSE]: cite }, false],
  [
    "uno root visual axis",
    snapshot("uno-power-input"),
    { [UNO]: dropVisual },
    false,
  ],
  [
    "sg90 control eSat 0.3 → 0.4 rad",
    snapshot("sg90-servo"),
    { [CONTROL]: (part) => (formParams(part, "1", "model").eSat = 0.4) },
    true,
  ],
  [
    "sg90 gear-train inertia ×2",
    snapshot("sg90-servo"),
    { [SG90]: (part) => (gearTrain(part).shafts[0].inertia *= 2) },
    true,
  ],
  [
    "sg90 control visual axis",
    snapshot("sg90-servo"),
    { [CONTROL]: dropVisual },
    false,
  ],
  ["sg90 root citations", snapshot("sg90-servo"), { [SG90]: cite }, false],
  [
    "hinge gear-train inertia ×2",
    snapshot("sg90-hinge"),
    { [SG90]: (part) => (gearTrain(part).shafts[0].inertia *= 2) },
    true,
  ],
  [
    "hinge root visual axis",
    snapshot("sg90-hinge"),
    { [SG90]: dropVisual },
    false,
  ],
];
for (const [label, snap, edits, dirty] of cases) {
  const got = signatureWith(snap, edits);
  expect(got.checked, `${label}: unchecked (${got.checked ? "" : got.reason})`);
  const changed = got.hash !== snap.provenance.from?.hash;
  expect(
    changed === dirty,
    `${label}: ${changed ? "dirty" : "fresh"}, want ${dirty ? "dirty" : "fresh"}`
  );
  console.log(`capture-signature: ${label} → ${dirty ? "stale" : "fresh"}`);
}

// 3. A provenance that does not name its variant is not guessed.
const bare = snapshot("sg90-servo");
bare.provenance.variant = undefined;
const unnamed = signatureWith(bare, {});
expect(
  !unnamed.checked && unnamed.reason.includes("variant"),
  "a capture with no variant is checked"
);
console.log(`capture-signature: no variant → unchecked (${unnamed.reason})`);

// 4. In a world: the Uno capture's report row.
const root = mkdtempSync(join(tmpdir(), "capture-signature-arm-"));
try {
  cpSync(armExample, root, { recursive: true });
  const worldRel = "parts/sfab/arm-bench@1.0.0.json";
  const worldFile = join(root, worldRel);
  const world = readJson<PartFile & { play: { levels: { paths: object } } }>(
    worldFile
  );
  world.play.levels.paths = {
    ...world.play.levels.paths,
    "uno.power": { behaviour: 1 },
  };
  writeFileSync(worldFile, JSON.stringify(world));
  const unoRow = () => {
    const planned = planWorld(root, worldRel);
    if (!planned.ok) {
      throw new Error(planned.errors.map((row) => row.message).join("; "));
    }
    const row = planned.plan.report?.snapshots.find(
      (item) => item.path === "uno.power"
    );
    if (!row) throw new Error("arm-bench does not run the Uno snapshot");
    return row;
  };
  const before = unoRow();
  expect(
    !before.stale && !before.unchecked,
    `the unedited Uno capture is not fresh: ${JSON.stringify(before)}`
  );
  const fuse = catalogPart(FUSE);
  formParams(fuse, "1", "thermal").rCold = 0.3;
  const shadow = join(root, "parts", `${FUSE}.json`);
  writeFileSync(shadow, JSON.stringify(fuse));
  const after = unoRow();
  expect(after.stale === true, "the fuse edit leaves the Uno capture fresh");
  rmSync(shadow);
  expect(!unoRow().stale, "removing the shadow leaves the capture stale");
  console.log(
    "capture-signature: arm-bench uno.power fresh, stale with a fuse rCold shadow, fresh again without it"
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("capture-signature.selfcheck ok");
