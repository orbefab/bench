/**
 * A snapshot is resolved one way for every caller (layered-sim M1a): the
 * world load and the board or assembly stamp. Held here:
 *
 * - nonsense evidence lints to Q0 with a diagnostic: a negative error, an
 *   error on a quantity the part does not have, a reversed envelope, an
 *   input the part does not declare;
 * - a file that is not JSON, or not shaped like a snapshot, is a
 *   diagnostic, not a throw;
 * - a snapshot of another type does not run, and the
 *   instance that selected it carries the diagnostic;
 * - one broken child snapshot idles that child; its siblings still
 *   resolve;
 * - a fitted `diode@1` snapshot runs nested in an assembly with its
 *   `bind`, and reads what its source netlist reads within its stated
 *   error.
 */

import { ok as expect } from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PartFile, SnapshotFile } from "@sfab-bench/contract";
import {
  type LoadedType,
  lintSnapshot,
  loadSnapshot,
  loadWorldV2,
  parseSnapshot,
} from "@sfab-bench/parts";
import { branchDc } from "@sfab-bench/sim";
import { assemblyStampOf } from "./world/circuit-stamp";
import { nodeStore } from "./world/node-store";

const catalog = fileURLToPath(new URL("../catalog/", import.meta.url));
const armRoot = fileURLToPath(
  new URL("../../../examples/arm/", import.meta.url)
);
const armBench = join(armRoot, "parts/sfab/arm-bench@1.0.0.json");

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function snapshotFile(name: string): string {
  return join(catalog, "snapshots/sfab", `${name}@1.0.0.json`);
}

/** The store with some files' text replaced. */
function storeWith(texts: Record<string, string>) {
  return {
    ...nodeStore,
    exists: (file: string) => file in texts || nodeStore.exists(file),
    readText: (file: string) => texts[file] ?? nodeStore.readText(file),
  };
}

// 1. Nonsense evidence.
const servo = readJson<SnapshotFile>(snapshotFile("sg90-servo"));
const servoType = readJson<LoadedType["type"]>(
  join(catalog, "types/hobby-servo-3wire.json")
);
const lintCtx = {
  ports: servoType.ports,
  plausible: servoType.plausible,
  requiredOutputs: servoType.requiredOutputs,
};
expect(
  lintSnapshot(servo, lintCtx).quality !== "Q0",
  "the catalog servo snapshot lints above Q0"
);
const nonsense: [string, (snap: SnapshotFile) => void][] = [
  [
    "negative error",
    (snap) => {
      if (Array.isArray(snap.error)) snap.error[0].value = -1;
    },
  ],
  [
    "error on an undeclared quantity",
    (snap) => {
      if (Array.isArray(snap.error)) snap.error[0].quantity = "missing.angle";
    },
  ],
  [
    "reversed envelope",
    (snap) => {
      snap.envelope.bounds["V+.current"] = [0.5, 0];
    },
  ],
  [
    "undeclared input",
    (snap) => {
      snap.ports.inputs = ["missing.voltage"];
    },
  ],
];
for (const [label, change] of nonsense) {
  const snap = structuredClone(servo);
  change(snap);
  const linted = lintSnapshot(snap, lintCtx);
  expect(linted.quality === "Q0", `${label}: ${linted.quality}, not Q0`);
  expect(
    linted.diagnostics.some((diag) => diag.severity === "error"),
    `${label}: no error diagnostic`
  );
  console.log(`snapshot-boundary: ${label} → Q0`);
}

// 2. Not JSON, not a snapshot.
const parsed = parseSnapshot({ format: "sfab.snapshot@1", part: 3 }, "probe");
expect(parsed.file === null, "a shapeless snapshot parses");
expect(parsed.diagnostics.length > 0, "a shapeless snapshot has no diagnostic");
const probeFile = join(catalog, "snapshots/sfab/probe@1.0.0.json");
const notJson = loadSnapshot(
  "/probe",
  {
    store: storeWith({ [probeFile]: "{" }),
    catalogDir: catalog,
    assetRoot: catalog,
  },
  "sfab/probe@1.0.0",
  null
);
expect(notJson.loaded === null, "a file that is not JSON loads");
expect(
  notJson.diagnostics.length > 0,
  "a file that is not JSON has no diagnostic"
);
console.log("snapshot-boundary: not JSON, shapeless → diagnostics");

// 3. Of another type, selected in arm-bench at `uno.power`.
const unoFile = snapshotFile("uno-power-input");
const world = readJson<PartFile & { play: { levels: { paths: object } } }>(
  armBench
);
world.play.levels.paths = {
  ...world.play.levels.paths,
  "uno.power": { behaviour: 1 },
};
const worldText = JSON.stringify(world);
const loadArm = (texts: Record<string, string>) =>
  loadWorldV2(armBench, {
    store: storeWith({ [armBench]: worldText, ...texts }),
    catalogDir: catalog,
    assetRoot: armRoot,
  });
const valid = loadArm({});
expect(
  valid.snapshotRuns.some((row) => row.path === "uno.power"),
  "arm-bench does not run the Uno power input snapshot"
);
const foreign = readJson<SnapshotFile>(unoFile);
foreign.partType = "hobby-servo-3wire";
for (const [label, text] of [
  ["of another type", JSON.stringify(foreign)],
  ["not JSON", "{"],
] as const) {
  const broken = loadArm({ [unoFile]: text });
  expect(
    !broken.snapshotRuns.some((row) => row.path === "uno.power"),
    `${label}: uno.power still runs it`
  );
  expect(
    broken.diagnostics.some(
      (diag) => diag.severity === "error" && diag.path === "uno.power"
    ),
    `${label}: no error diagnostic on uno.power`
  );
  expect(broken.run !== null, `${label}: the world did not load`);
  expect(
    broken.resolved.length === valid.resolved.length,
    `${label}: ${broken.resolved.length} instances, not ${valid.resolved.length}`
  );
  const others = (rows: typeof valid.snapshotRuns) =>
    rows
      .filter((row) => row.path !== "uno.power")
      .map((row) => `${row.path}:${row.axis}:${row.ref}`)
      .sort()
      .join(",");
  expect(
    others(broken.snapshotRuns) === others(valid.snapshotRuns),
    `${label}: the other snapshots did not all run`
  );
  console.log(`snapshot-boundary: ${label} → uno.power idles, siblings run`);
}

// 4. The fitted LED module nested in an assembly, run as its snapshot.
const led = readJson<SnapshotFile>(snapshotFile("led-module-red"));
const ledType = readJson<LoadedType["type"]>(
  join(catalog, "types/led-module.json")
);
const none = {
  "0": { default: "none", variants: { none: { kind: "none", omits: [] } } },
};
const wrapper = {
  format: "sfab.part@1",
  id: "sfab/boundary-wrapper@1.0.0",
  type: {
    format: "sfab.part-type@1",
    id: "boundary-wrapper",
    ports: ledType.ports,
  },
  axes: {
    behaviour: {
      "2": {
        default: "netlist",
        variants: {
          netlist: {
            kind: "composite",
            omits: [],
            netlist: {
              instances: {
                child: {
                  part: led.part,
                  level: { behaviour: 1 },
                },
              },
              wires: [],
              expose: { IN: "child.IN", GND: "child.GND" },
            },
          },
        },
      },
    },
    body: none,
    visual: none,
  },
};
const project = mkdtempSync(join(tmpdir(), "snapshot-boundary-"));
try {
  mkdirSync(join(project, "parts/sfab"), { recursive: true });
  writeFileSync(
    join(project, "parts/sfab/boundary-wrapper@1.0.0.json"),
    JSON.stringify(wrapper)
  );
  const across = {
    catalogDir: catalog,
    across: ["IN", "GND"] as [string, string],
  };
  const nested = assemblyStampOf(wrapper.id, "netlist", {
    ...across,
    worldDir: project,
    boardId: "wrapper",
  });
  const diode = nested.parts.find((part) => part.path === "wrapper.child");
  expect(diode?.form === "diode@1", "the nested snapshot is not diode@1");
  expect(
    diode?.watch?.ref === led.part && diode.watch.ports.A === "IN",
    "the nested snapshot does not watch its bound ports"
  );
  const source = assemblyStampOf(led.part, "netlist", {
    ...across,
    boardId: "module",
  });
  const stated = Array.isArray(led.error)
    ? led.error.find((row) => row.quantity === "IN.voltage")?.value
    : undefined;
  expect(
    typeof stated === "number",
    "the LED snapshot states no IN.voltage error"
  );
  const [lo, hi] = led.envelope.bounds["IN.current"] as [number, number];
  let worst = 0;
  for (let i = 0; i <= 20; i += 1) {
    const amps = lo + ((hi - lo) * i) / 20;
    const gap = Math.abs(
      branchDc(nested, "IN", "GND", amps) - branchDc(source, "IN", "GND", amps)
    );
    worst = Math.max(worst, gap);
  }
  // The stated row is the sweep's max-abs, over the same envelope.
  expect(worst <= stated, `nested LED gap ${worst} V over stated ${stated} V`);
  console.log(
    `snapshot-boundary: nested ${led.part} runs diode@1 bound to IN/GND, gap ${worst.toExponential(2)} V (stated ${stated})`
  );
} finally {
  rmSync(project, { recursive: true, force: true });
}

console.log("snapshot-boundary.selfcheck ok");
