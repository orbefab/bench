/** Ported from layered-sim E7 (318b899). */

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
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Diagnostic, PartFile, PartTypeFile } from "@sfab-bench/contract";
import {
  canonicalJson,
  expandPartType,
  type LoadOptions,
  loadWorldV2,
  lockPathFor,
  writeLock,
} from "@sfab-bench/parts";
import { nodeStore } from "./world/node-store";

const serverDir = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const catalogDir = path.join(serverDir, "catalog");
const fixtures = path.join(serverDir, "fixtures/layered");
const opts: LoadOptions = {
  store: nodeStore,
  catalogDir,
  assetRoot: repoRoot,
};

function expect(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(label);
}

function line(ok: boolean, text: string): void {
  if (!ok) throw new Error(text);
  process.stdout.write(`PASS ${text}\n`);
}

function worldFile(name: string): string {
  return path.join(fixtures, name, "world.json");
}

function load(name: string, extra?: Partial<LoadOptions>) {
  return loadWorldV2(worldFile(name), { ...opts, ...extra });
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function names(diag: Diagnostic | undefined): boolean {
  if (!diag) return false;
  return (
    diag.message.includes(diag.path) &&
    diag.message.includes(diag.port) &&
    diag.message.includes(diag.quantity) &&
    diag.message.includes(diag.left) &&
    diag.message.includes(diag.right)
  );
}

function clean(name: string): void {
  const a = load(name);
  const b = load(name);
  const report = a.report;
  const errors = a.diagnostics.filter((d) => d.severity === "error");
  const warnings = a.diagnostics.filter((d) => d.severity === "warning");
  const instances = report
    ? new Set(report.levels.map((level) => level.path)).size
    : 0;
  const ok =
    errors.length === 0 &&
    warnings.length === 0 &&
    report !== null &&
    canonicalJson(a.report) === canonicalJson(b.report);
  const detail = a.diagnostics.map((diag) => diag.message).join(" | ");
  line(
    ok,
    `${name} loads, resolves, checks clean (instances=${instances}, nets=${a.nets.length}, errors=${errors.length}, warnings=${warnings.length}${detail ? `; ${detail}` : ""})`
  );
}

clean("hold");
clean("stall");
clean("fleet");
clean("shorthand");

const hold = load("hold");
const signal = hold.nets.find((net) =>
  net.ports.some((p) => p.full === "servo.signal")
);
const rail = hold.nets.find((net) =>
  net.ports.some((p) => p.full === "servo.V+")
);
const shaft = hold.nets.find((net) =>
  net.ports.some((p) => p.full === "servo.shaft")
);
const omits = hold.report?.notSimulated.find(
  (row) => row.path === "servo" && row.axis === "behaviour"
);
const unoBuses = hold.report?.buses.filter((bus) => bus.path === "uno") ?? [];
line(
  signal?.level === "digital" &&
    rail?.level === "analog" &&
    shaft?.level === "rotational" &&
    omits?.effects.includes("gear backlash") === true &&
    omits.effects.includes("motor inductance") === true &&
    omits.effects.includes("winding heat") === true &&
    unoBuses.length === 3 &&
    hold.lock?.parts.some((part) => part.id === "sfab/sg90-motor@1.0.0") ===
      true,
  `hold nets and omissions (signal=${signal?.level}, rail=${rail?.level}, shaft=${shaft?.level}, buses=${unoBuses.length})`
);

function broken(
  name: string,
  severity: "error" | "warning",
  match: (diag: Diagnostic) => boolean
): Diagnostic {
  const outcome = load(`broken/${name}`);
  const diag = outcome.diagnostics.find(
    (item) => item.severity === severity && match(item)
  );
  const twice = load(`broken/${name}`);
  const stable =
    canonicalJson(outcome.diagnostics) === canonicalJson(twice.diagnostics);
  line(
    Boolean(diag && names(diag) && stable),
    `broken ${name} ${severity}: ${diag?.message ?? (outcome.diagnostics.map((d) => d.message).join(" | ") || "not caught")}`
  );
  return diag as Diagnostic;
}

broken(
  "logic33",
  "error",
  (diag) =>
    diag.path === "sensor" &&
    diag.port === "IN" &&
    diag.quantity === "Voltage" &&
    diag.left === "4.2 V" &&
    diag.right === "3.6 V"
);
broken(
  "motor12",
  "warning",
  (diag) =>
    diag.path === "motor" &&
    diag.port === "V+" &&
    diag.quantity === "Voltage" &&
    diag.left === "5 V" &&
    diag.right.includes("10.8")
);
const motor12 = load("broken/motor12");
line(
  motor12.diagnostics.every((d) => d.severity !== "error") &&
    motor12.diagnostics.filter((d) => d.severity === "warning").length === 1,
  `broken motor12 is a warning only (errors=${motor12.diagnostics.filter((d) => d.severity === "error").length})`
);
broken(
  "unit-swap",
  "error",
  (diag) =>
    diag.path === "motor" &&
    diag.port === "V+" &&
    diag.quantity === "Current" &&
    diag.left.includes("Voltage") &&
    diag.right.includes("Current")
);
broken(
  "shaft-pin",
  "error",
  (diag) =>
    diag.path === "servo" &&
    diag.port === "shaft" &&
    diag.quantity === "Angle" &&
    diag.left.includes("Angle") &&
    diag.right.includes("Voltage")
);
broken(
  "missing-port",
  "warning",
  (diag) =>
    diag.code === "broken-port" &&
    diag.port === "servo.missing" &&
    diag.quantity === "Port" &&
    diag.left === "uno.D9—servo.missing"
);
broken(
  "ma-as-a",
  "error",
  (diag) =>
    diag.path === "servo" &&
    diag.port === "V+" &&
    diag.quantity === "Current" &&
    diag.message.includes("field current") &&
    diag.message.includes("700") &&
    diag.message.includes("[-2, 2] A")
);
broken(
  "lock-mismatch",
  "error",
  (diag) => diag.quantity === "sha256" && diag.message.includes("hash mismatch")
);
broken(
  "unknown-type",
  "error",
  (diag) => diag.port === "no-such-type" && diag.quantity === "PartType"
);

const fleet = load("fleet").report;
const reasons = {
  default: 0,
  type: 0,
  path: 0,
  parent: 0,
  fallback: 0,
  none: 0,
};
for (const level of fleet?.levels ?? []) {
  if (level.reason === "default") reasons.default += 1;
  else if (level.reason.startsWith("type rule")) reasons.type += 1;
  else if (level.reason.startsWith("path rule")) reasons.path += 1;
  else if (level.reason.startsWith("parent class")) reasons.parent += 1;
  else if (level.reason.startsWith("fallback")) reasons.fallback += 1;
  else reasons.none += 1;
}
const rig1 = fleet?.levels.find(
  (level) => level.path === "fleet.rig1.servo" && level.axis === "behaviour"
);
const rig2 = fleet?.levels.find(
  (level) => level.path === "fleet.rig2.servo" && level.axis === "behaviour"
);
const rig1Body = fleet?.levels.find(
  (level) => level.path === "fleet.rig1.servo" && level.axis === "body"
);
const rig2Visual = fleet?.levels.find(
  (level) => level.path === "fleet.rig2.servo" && level.axis === "visual"
);
const rootBeh = fleet?.levels.find(
  (level) => level.path === "$root" && level.axis === "behaviour"
);
line(
  reasons.default === 10 &&
    reasons.type === 2 &&
    reasons.path === 2 &&
    // Each rig's Uno power group stays class 2, and its leaves fall back.
    // The VIN path (two regulators, the comparator, the divider, PC1) is in that count.
    reasons.parent === 2 &&
    reasons.fallback === 104 &&
    reasons.none === 12 &&
    rig1?.class === 0 &&
    rig1.reason === "type rule hobby-servo-3wire" &&
    rig2?.class === 2 &&
    rig2.reason === "path rule fleet.rig2.servo" &&
    rig1Body?.reason ===
      "fallback from 0 to 1 (only deeper; capture suggested)" &&
    rig2Visual?.reason === "fallback from 2 to 1 (cheaper)" &&
    rootBeh?.reason ===
      "fallback from 1 to 2 (only deeper; capture suggested)" &&
    fleet?.levels.some((level) => level.path === "fleet.rig2.servo.motor") ===
      true &&
    fleet?.levels.some((level) => level.path === "fleet.rig1.servo.motor") ===
      false &&
    fleet?.foreign.some((part) => part.path === "fleet.rig2.servo.control") ===
      true,
  `fleet resolver (default=${reasons.default}, type=${reasons.type}, path=${reasons.path}, fallback=${reasons.fallback}, no-level=${reasons.none})`
);

const lockDir = mkdtempSync(path.join(tmpdir(), "sfab-lock-"));
try {
  cpSync(path.join(fixtures, "hold"), lockDir, { recursive: true });
  const file = path.join(lockDir, "world.json");
  const first = loadWorldV2(file, opts);
  expect(first.lock, "hold lock");
  writeLock(nodeStore, lockPathFor(file), first.lock);
  const second = loadWorldV2(file, opts);
  const roundTrip = second.diagnostics.filter((d) => d.quantity === "sha256");
  line(roundTrip.length === 0, "lockfile round trip verifies");
  const tampered = structuredClone(first.lock);
  const row = tampered.parts[0];
  expect(row, "lock part");
  row.sha256 =
    "0000000000000000000000000000000000000000000000000000000000000000";
  writeLock(nodeStore, lockPathFor(file), tampered);
  const third = loadWorldV2(file, opts);
  const caught = third.diagnostics.find(
    (d) =>
      d.quantity === "sha256" &&
      d.message.includes("hash mismatch") &&
      d.path === row.id
  );
  line(
    Boolean(caught && names(caught)),
    `tampered hash is caught (${caught?.message ?? "not caught"})`
  );
} finally {
  rmSync(lockDir, { recursive: true, force: true });
}

const reportA = canonicalJson(load("hold").report);
const reportB = canonicalJson(load("hold").report);
const fleetA = canonicalJson(load("fleet").report);
const fleetB = canonicalJson(load("fleet").report);
line(
  reportA === reportB && fleetA === fleetB && reportA.length > 0,
  `reports byte-identical across two loads (hold=${reportA.length}, fleet=${fleetA.length})`
);

const libDir = mkdtempSync(path.join(tmpdir(), "sfab-lib-"));
try {
  const id = "local/only-here@1.0.0";
  const part: PartFile = {
    format: "sfab.part@1",
    id,
    type: {
      format: "sfab.part-type@1",
      id: "resistor",
      ports: {
        A: { domain: "electrical", role: "analog", direction: "passive" },
        B: { domain: "electrical", role: "analog", direction: "passive" },
      },
    },
    axes: {
      behaviour: {
        "0": {
          default: "r",
          variants: {
            r: {
              kind: "form",
              form: "resistor@1",
              params: { R: 1000 },
              omits: ["temperature coefficient"],
            },
          },
        },
      },
    },
  };
  const partPath = path.join(libDir, "parts/local/only-here@1.0.0.json");
  mkdirSync(path.dirname(partPath), { recursive: true });
  writeFileSync(partPath, `${JSON.stringify(part)}\n`);
  const worldDir = mkdtempSync(path.join(tmpdir(), "sfab-world-"));
  writeFileSync(
    path.join(worldDir, "world.json"),
    `${JSON.stringify({
      version: 2,
      environment: { ground: { plane: true }, gravity: [0, 0, -9.80665] },
      run: { seed: 1, levels: { default: 0 } },
      root: { id: "r", part: id },
    })}\n`
  );
  const missing = loadWorldV2(path.join(worldDir, "world.json"), opts);
  const found = loadWorldV2(path.join(worldDir, "world.json"), {
    ...opts,
    libraryDir: libDir,
  });
  line(
    missing.diagnostics.some((d) => d.message.includes("not found")) &&
      found.lock?.parts.some(
        (row) => row.id === id && row.source === "library"
      ) === true &&
      found.diagnostics.every((d) => d.severity !== "error"),
    "personal library path is injectable and is not the home directory"
  );
  rmSync(worldDir, { recursive: true, force: true });
} finally {
  rmSync(libDir, { recursive: true, force: true });
}

const partsSrc = readdirSync(path.join(serverDir, "../../packages/parts/src"))
  .map((name) =>
    readFileSync(path.join(serverDir, "../../packages/parts/src", name), "utf8")
  )
  .join("\n");
line(
  !partsSrc.includes("homedir") && !partsSrc.includes("/Users/"),
  "loader source has no home path"
);

const uno = expandPartType(
  readJson<PartTypeFile>(path.join(catalogDir, "types/arduino-uno-r3.json"))
);
const pwm = new Set(["D3", "D5", "D6", "D9", "D10", "D11"]);
line(
  uno.templates === undefined &&
    Object.keys(uno.ports).filter((id) => id.startsWith("D")).length === 14 &&
    uno.ports.D9?.pwm === true &&
    uno.ports.D0?.pwm === false &&
    uno.ports.A0?.adc === true &&
    pwm.has("D9") &&
    !pwm.has("D0"),
  "Uno port template expands D0–D13 and A0–A5"
);

const sg90 = readJson<PartFile>(
  path.join(catalogDir, "parts/sfab/sg90@1.0.0.json")
);
const law = sg90.axes?.behaviour?.["1"]?.variants.datasheet;
const joint =
  sg90.axes?.body?.["1"]?.variants.lumped?.kind === "lumped"
    ? sg90.axes.body["1"].variants.lumped.joint
    : undefined;
/** Frozen at abccd10, the numbers the run used before the catalog tables left. */
const motor = {
  k: 0.458,
  resistance: 7.1,
  efficiency: 0.57,
  eSat: 0.3,
  quiescent: 0.01,
  armature: 0.00005,
  frictionloss: 0.002,
  damping: 0.0025,
};
const supply = { min: 4.8, max: 6 };
const torqueNm = 0.176;
expect(law?.kind === "form", "sg90 law");
if (law?.kind === "form") {
  line(
    law.params.K === motor.k &&
      law.params.R === motor.resistance &&
      law.params.efficiency === motor.efficiency &&
      law.params.eSat === motor.eSat &&
      law.params.quiescent === motor.quiescent &&
      law.params.armature === undefined &&
      joint?.armature === motor.armature &&
      joint?.frictionloss === motor.frictionloss &&
      joint?.damping === motor.damping &&
      sg90.ratings?.["V+"]?.voltage?.[0] === supply.min &&
      sg90.ratings?.["V+"]?.voltage?.[1] === supply.max &&
      sg90.ratings?.shaft?.torque?.[1] === torqueNm,
    "sg90 catalog numbers match the frozen run"
  );
}

const usb = readJson<PartFile>(
  path.join(catalogDir, "parts/sfab/usb-port-500ma@1.0.0.json")
);
const usbLaw = usb.axes?.behaviour?.["1"]?.variants.thevenin;
const bench = readJson<PartFile>(
  path.join(catalogDir, "parts/sfab/bench-supply@1.0.0.json")
);
const benchLaw = bench.axes?.behaviour?.["1"]?.variants.thevenin;
expect(usbLaw?.kind === "form" && benchLaw?.kind === "form", "supply laws");
if (usbLaw?.kind === "form" && benchLaw?.kind === "form") {
  line(
    usbLaw.params.V === 5 &&
      usbLaw.params.Rs === 0.5 &&
      usbLaw.params.Ilimit === 0.9 &&
      benchLaw.params.V === 5 &&
      benchLaw.params.Rs === 0.05 &&
      benchLaw.params.Ilimit === 1,
    "supply catalog numbers match the frozen run (V is the setpoint)"
  );
}

const unoPart = readJson<PartFile>(
  path.join(catalogDir, "parts/sfab/uno-r3@1.0.0.json")
);
const fw = unoPart.axes?.behaviour?.["1"]?.variants.avr8js;
expect(fw?.kind === "firmware" && fw.params, "uno firmware");
if (fw?.kind === "firmware" && fw.params) {
  line(
    fw.chip === "atmega328p" &&
      fw.params.brownoutVoltage === 2.7 &&
      fw.params.brownoutAssertVoltage === 2.675 &&
      fw.params.brownoutReleaseVoltage === 2.725 &&
      fw.params.quiescent === 0.05 &&
      fw.fuses?.extended === "0xFD" &&
      Math.abs((fw.params.resetHoldS ?? 0) - 0.066) < 1e-9 &&
      uno.ports["5V"]?.ratings?.voltage?.[0] === 3.78 &&
      uno.ports["5V"]?.ratings?.voltage?.[1] === 5.5,
    "uno catalog numbers match the frozen run"
  );
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".json")) out.push(full);
  }
}
const jsonFiles: string[] = [];
walk(catalogDir, jsonFiles);
walk(fixtures, jsonFiles);
let displayHits = 0;
for (const file of jsonFiles) {
  const text = readFileSync(file, "utf8");
  if (text.includes("mA") || text.includes("°") || text.includes("deg"))
    displayHits += 1;
}
line(
  displayHits === 0,
  `catalog and fixtures store SI only (${jsonFiles.length} json files)`
);

const runtimeFiles: string[] = [];
function walkTs(dir: string): void {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walkTs(full);
    else if (name.endsWith(".ts")) runtimeFiles.push(full);
  }
}
walkTs(path.join(serverDir, "src/world"));
const draftImport = runtimeFiles.find(
  (file) =>
    !file.endsWith(`${path.sep}selfcheck-draft.ts`) &&
    readFileSync(file, "utf8").includes("selfcheck-draft")
);
line(draftImport === undefined, "runtime modules do not import the test draft");
