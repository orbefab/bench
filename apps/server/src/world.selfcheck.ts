import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  boardModels,
  chipModels,
  extractUrdfJointsAndMeshes,
  partModels,
  supplyPresets,
  type UrdfInfo,
  validateWorld,
  type WorldValidateCtx,
  type WorldValidation,
} from "@sfab-bench/contract";

/**
 * The arm fixture is the milestone-1 world: one URDF, one Uno, one SG90,
 * USB power, and explicit wires. Mutations of that document are how each
 * validator code is forced to fire.
 */

const armDir = fileURLToPath(
  new URL("../../../examples/arm/", import.meta.url)
);
/** Frozen v1 documents. The examples on disk are version 2. */
const v1Dir = fileURLToPath(new URL("../fixtures/v1/", import.meta.url));

type Pose = { position: number[]; rotation: number[] };

type WorldFile = {
  version: number;
  robots: { id: string; urdf: string; pose: Pose }[];
  environment: {
    ground: { plane: boolean };
    primitives?: unknown[];
    stepProps?: unknown[];
  };
  boards: {
    id: string;
    chip: string;
    board: string;
    firmware: string;
    source?: string;
    pose: Pose;
    size: number[];
  }[];
  supplies: {
    id: string;
    voltage: number;
    currentLimit: number;
    rSeries: number;
  }[];
  parts: {
    id: string;
    model: string;
    drives?: { robot: string; joint: string };
    reads?: unknown;
  }[];
  wires: [string, string][];
};

function expect(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(label);
}

function load(name: string): WorldFile {
  return JSON.parse(readFileSync(join(v1Dir, name), "utf8")) as WorldFile;
}

function clone(doc: WorldFile): WorldFile {
  return JSON.parse(JSON.stringify(doc)) as WorldFile;
}

function ctxFor(override?: UrdfInfo): WorldValidateCtx {
  return {
    fileExists(relativePath) {
      return existsSync(join(armDir, relativePath));
    },
    urdf(relativePath) {
      if (override && relativePath === "robot/arm.urdf") return override;
      const absolute = join(armDir, relativePath);
      if (!existsSync(absolute)) return undefined;
      return extractUrdfJointsAndMeshes(readFileSync(absolute, "utf8"));
    },
  };
}

function assertIssues(
  result: WorldValidation,
  label: string,
  errorCodes: string[],
  warningCodes: string[] = []
) {
  const errors = result.errors.map((issue) => issue.code).join(",") || "(none)";
  const warnings =
    result.warnings.map((issue) => issue.code).join(",") || "(none)";
  expect(
    result.ok === (errorCodes.length === 0),
    `${label}: ok=${result.ok} errors=${errors}`
  );
  expect(
    errors === (errorCodes.join(",") || "(none)"),
    `${label}: errors ${errors}`
  );
  expect(
    warnings === (warningCodes.join(",") || "(none)"),
    `${label}: warnings ${warnings}`
  );
  for (const issue of [...result.errors, ...result.warnings]) {
    expect(issue.message.includes("Hint:"), `${label}: ${issue.code} hint`);
    expect(typeof issue.path === "string", `${label}: path`);
  }
}

function assertOk(result: WorldValidation, label: string) {
  assertIssues(result, label, []);
}

const urdfText = readFileSync(join(armDir, "robot/arm.urdf"), "utf8");
expect(urdfText.includes('<robot name="arm">'), "robot renamed to arm");
expect(!urdfText.includes("probe"), "urdf no longer names the probe");
expect(
  urdfText.includes('<compiler fusestatic="false" discardvisual="false"/>'),
  "mujoco compiler flags kept"
);

const urdfInfo = extractUrdfJointsAndMeshes(urdfText);
expect(urdfInfo.links.join(",") === "base,upper_arm", "link names");
expect(urdfInfo.joints.join(",") === "shoulder", "shoulder joint");
expect(
  urdfInfo.meshes.join(",") === "meshes/base.stl,meshes/upper_arm.stl",
  "stl meshes"
);

const commented = extractUrdfJointsAndMeshes(
  `<!-- <link name="ghost"/> <joint name="fake"></joint> <mesh filename="hidden.3mf"/> -->
   <link name="base"/>
   <joint name="shoulder" type="revolute"></joint>
   <mesh filename="meshes/base.stl"/>`
);
expect(commented.links.join(",") === "base", "commented link ignored");
expect(commented.joints.join(",") === "shoulder", "commented joint ignored");
expect(
  commented.meshes.join(",") === "meshes/base.stl",
  "commented mesh ignored"
);

const uno = boardModels.uno;
const chip = chipModels[uno.chip];
expect(uno.operatingVoltage === 5, "uno voltage");
expect(uno.supply.min === 5 && uno.supply.max === 5, "uno 5V range");
expect(uno.current === 0.05, "uno 50 mA");
expect(chip.brownoutVoltage === 2.7, "brownout");
expect(chip.brownoutAssertVoltage === 2.675, "brownout assert");
expect(chip.brownoutReleaseVoltage === 2.725, "brownout release");
expect(chip.resetHoldMs === 66, "reset hold");
expect(chip.extendedFuse === "0xFD", "extended fuse");
expect(uno.pwmPins.join(",") === "D3,D5,D6,D9,D10,D11", "pwm pins");
expect(uno.servoConflictPins.join(",") === "D9,D10", "timer1 pins");
expect(uno.powerInputs.join(",") === "5V", "VIN is not a power input");
expect(uno.pins["3V3"]?.output === true, "3V3 is the regulator output");
expect(uno.pins.VIN?.output === false, "VIN does not drive a net");
expect(Object.keys(uno.pins).length === 24, "uno pin count");

const sg90 = partModels.sg90;
expect(
  sg90.drive.kind === "servo" && sg90.drive.pin === "signal",
  "servo drive"
);
expect(sg90.supply?.nominal === 5, "sg90 nominal");
expect(sg90.supply?.min === 4.8 && sg90.supply?.max === 6, "sg90 range");
expect(sg90.motor?.k === 0.458, "sg90 K");
expect(sg90.motor?.resistance === 7.1, "sg90 R");
expect(sg90.motor?.efficiency === 0.57, "sg90 efficiency");
expect(sg90.motor?.quiescent === 0.01, "sg90 quiescent");
expect(sg90.torqueNm === 0.176, "sg90 torque");
expect(partModels["led-pwm"].drive.kind === "analogWrite", "led-pwm drive");

const usb = supplyPresets.usb;
expect(
  usb.voltage === 5 && usb.currentLimit === 0.9 && usb.rSeries === 0.5,
  "usb preset"
);
const bench = supplyPresets.bench;
expect(bench.rSeries === 0.05, "bench series resistance");

const notice = readFileSync(join(armDir, "NOTICE"), "utf8");
expect(notice.includes("arduino-cli 1.5.1"), "notice cli");
expect(notice.includes("arduino:avr core 1.8.8"), "notice core");
expect(notice.includes("Servo library 1.3.0"), "notice servo lib");
expect(notice.includes("LGPL-2.1"), "notice licence");
expect(
  notice.includes("arduino-cli compile --fqbn arduino:avr:uno"),
  "notice build command"
);
expect(
  readFileSync(join(armDir, "firmware/hold/hold.hex")).length === 9026,
  "hold hex is the plain image"
);
expect(
  readFileSync(join(armDir, "firmware/stall/stall.hex")).length === 7021,
  "stall hex is the plain image"
);
expect(
  readFileSync(join(armDir, "robot/cad/arm.py"), "utf8").includes(
    "lib.dimensions"
  ),
  "cad sources import lib"
);

const hold = load("arm.world.json");
const stall = load("arm-stall.world.json");
expect(hold.version === 1, "version");
expect(hold.robots.length === 1 && hold.robots[0]?.id === "arm", "one robot");
expect(hold.environment.ground.plane === true, "ground plane");
expect(hold.parts[0]?.model === "sg90", "sg90");
expect(hold.parts[0]?.drives?.joint === "shoulder", "shoulder drive");
expect(hold.supplies[0]?.voltage === usb.voltage, "fixture copies usb voltage");
expect(
  hold.supplies[0]?.currentLimit === usb.currentLimit &&
    hold.supplies[0]?.rSeries === usb.rSeries,
  "fixture copies usb limit and series resistance"
);
expect(
  stall.supplies[0]?.id === "bench" &&
    stall.supplies[0]?.voltage === 5 &&
    stall.supplies[0]?.currentLimit === 0.3 &&
    stall.supplies[0]?.rSeries === bench.rSeries,
  "stall fixture is a 5 V / 0.3 A bench supply"
);
expect(hold.wires.length === 5, "five wires");

const holdCtx = ctxFor();
assertOk(validateWorld(hold, holdCtx), "hold world");
assertOk(validateWorld(stall, ctxFor()), "stall world");
const droopDoc = clone(hold);
const droopSupply = droopDoc.supplies[0] as {
  rSeries?: number;
  rDroop?: number;
};
delete droopSupply.rSeries;
droopSupply.rDroop = 10;
const droopResult = validateWorld(droopDoc, holdCtx);
expect(
  droopResult.errors.some((issue) =>
    issue.message.includes("rDroop was removed")
  ),
  `rDroop error ${droopResult.errors.map((issue) => issue.message).join(" | ")}`
);

const holdAside = clone(hold);
const stallAside = clone(stall);
holdAside.boards[0]!.firmware = "";
holdAside.boards[0]!.source = "";
stallAside.boards[0]!.firmware = "";
stallAside.boards[0]!.source = "";
holdAside.supplies = [];
stallAside.supplies = [];
holdAside.wires = holdAside.wires.filter(
  (wire) => !wire[0].startsWith("usb.") && !wire[1].startsWith("usb.")
);
stallAside.wires = stallAside.wires.filter(
  (wire) => !wire[0].startsWith("bench.") && !wire[1].startsWith("bench.")
);
expect(
  JSON.stringify(holdAside) === JSON.stringify(stallAside),
  "stall world matches hold except firmware and supply"
);
expect(
  hold.boards[0]?.firmware === "firmware/hold/hold.hex" &&
    stall.boards[0]?.firmware === "firmware/stall/stall.hex",
  "each world names its hex"
);

const pose: Pose = { position: [0, 0, 0], rotation: [1, 0, 0, 0] };
const decorated = clone(hold);
decorated.environment.primitives = [
  { id: "crate", shape: "box", pose, size: [0.1, 0.2, 0.3] },
  { id: "ball", shape: "sphere", pose, size: 0.05 },
  {
    id: "peg",
    shape: "cylinder",
    pose,
    size: { radius: 0.01, length: 0.04 },
  },
];
decorated.environment.stepProps = [
  { id: "bracket", step: "not-loaded.step", pose },
];
assertOk(validateWorld(decorated, holdCtx), "primitives and step prop");

const noSource = clone(hold);
delete noSource.boards[0]?.source;
assertOk(validateWorld(noSource, holdCtx), "source is optional");

const missingGround = clone(hold);
missingGround.wires = missingGround.wires.filter(
  (wire) => !(wire[0] === "usb.GND" && wire[1] === "uno.GND")
);
const missingGroundResult = validateWorld(missingGround, holdCtx);
assertIssues(missingGroundResult, "missing ground", [
  "missing-ground",
  "missing-ground",
]);
expect(
  missingGroundResult.errors[0]?.path === "boards[0]" &&
    missingGroundResult.errors[1]?.path === "parts[0]",
  "missing ground paths"
);

const twelve = clone(hold);
twelve.supplies[0]!.voltage = 12;
assertIssues(validateWorld(twelve, holdCtx), "12 V", [
  "voltage-mismatch",
  "voltage-mismatch",
]);

const fivePointFive = clone(hold);
fivePointFive.supplies[0]!.voltage = 5.5;
const fivePointFiveResult = validateWorld(fivePointFive, holdCtx);
assertIssues(fivePointFiveResult, "5.5 V", ["voltage-mismatch"]);
expect(
  fivePointFiveResult.errors[0]?.path === "boards[0]",
  "5.5 V is the board"
);

const gpioOutputs = clone(hold);
gpioOutputs.wires.push(["uno.D2", "uno.D4"]);
assertIssues(validateWorld(gpioOutputs, holdCtx), "gpio two-outputs", [
  "two-outputs",
]);

const supplyOutputs = clone(hold);
supplyOutputs.supplies.push({
  id: "aux",
  voltage: 5,
  currentLimit: 0.9,
  rSeries: 0.5,
});
supplyOutputs.wires.push(["usb.5V", "aux.5V"], ["usb.GND", "aux.GND"]);
assertIssues(validateWorld(supplyOutputs, holdCtx), "supply two-outputs", [
  "two-outputs",
]);

const auxSupply = {
  id: "aux",
  voltage: 5,
  currentLimit: 0.9,
  rSeries: 0.5,
};

function worldWith(
  wires: [string, string][],
  supplies?: WorldFile["supplies"]
): WorldFile {
  const doc = clone(hold);
  doc.wires = wires;
  if (supplies) doc.supplies = supplies;
  return doc;
}

assertIssues(
  validateWorld(
    worldWith([
      ["uno.D9", "servo.signal"],
      ["uno.D10", "servo.signal"],
    ]),
    holdCtx
  ),
  "outputs joined through servo.signal",
  ["two-outputs"],
  ["no-supply"]
);

assertIssues(
  validateWorld(
    worldWith(
      [
        ["usb.5V", "uno.5V"],
        ["aux.5V", "uno.5V"],
        ["usb.GND", "uno.GND"],
        ["aux.GND", "uno.GND"],
      ],
      [...hold.supplies, auxSupply]
    ),
    holdCtx
  ),
  "supplies joined through uno.5V",
  ["two-outputs"]
);

assertIssues(
  validateWorld(
    worldWith(
      [
        ["usb.5V", "servo.V+"],
        ["aux.5V", "servo.V+"],
      ],
      [...hold.supplies, auxSupply]
    ),
    holdCtx
  ),
  "supplies joined through servo.V+",
  ["two-outputs", "missing-ground", "missing-ground"],
  ["no-supply"]
);

function signalOn(pin: string): WorldFile {
  const doc = clone(hold);
  doc.wires = doc.wires.map((wire) =>
    wire[0] === "uno.D9" && wire[1] === "servo.signal"
      ? [`uno.${pin}`, "servo.signal"]
      : wire
  );
  return doc;
}

for (const pin of ["5V", "3V3", "VIN", "GND"]) {
  const result = validateWorld(signalOn(pin), holdCtx);
  const codes = result.errors.map((issue) => issue.code);
  expect(!result.ok, `servo signal on ${pin} passed`);
  expect(
    codes.includes("signal-pin"),
    `servo signal on ${pin}: ${codes.join(",") || "(none)"}`
  );
}
assertOk(validateWorld(signalOn("D2"), holdCtx), "servo on D2 via signalOn");
assertOk(validateWorld(signalOn("D9"), holdCtx), "servo on D9");
assertOk(validateWorld(signalOn("A0"), holdCtx), "servo on A0");

const hoppedSignal = clone(hold);
// A second servo is the hop, so the only new issue is the direct-pair
// warning. `servo.signal → hop.signal → uno.D9` still reaches a GPIO.
hoppedSignal.parts.push({
  id: "hop",
  model: "sg90",
  drives: { robot: "arm", joint: "shoulder" },
});
hoppedSignal.wires = hoppedSignal.wires.map((wire) =>
  wire[0] === "uno.D9" && wire[1] === "servo.signal"
    ? (["servo.signal", "hop.signal"] as [string, string])
    : wire
);
hoppedSignal.wires.push(["hop.signal", "uno.D9"]);
const hoppedSignalResult = validateWorld(hoppedSignal, holdCtx);
assertIssues(
  hoppedSignalResult,
  "servo signal hop",
  [],
  ["servo-signal-direct"]
);
expect(
  hoppedSignalResult.warnings.some((issue) =>
    issue.message.startsWith(
      "servo servo: signal must be wired directly to a board pin"
    )
  ),
  `hop warning ${hoppedSignalResult.warnings.map((issue) => issue.message).join(" | ")}`
);

const toRegulator = clone(hold);
toRegulator.wires.push(["usb.5V", "uno.3V3"]);
assertIssues(validateWorld(toRegulator, holdCtx), "supply on 3V3", [
  "two-outputs",
]);

function barrelOnVin(voltage: number): WorldFile {
  const doc = clone(hold);
  doc.supplies = [{ id: "barrel", voltage, currentLimit: 1, rSeries: 0.05 }];
  doc.wires = [
    ["barrel.5V", "uno.VIN"],
    ["barrel.GND", "uno.GND"],
    ["uno.D9", "servo.signal"],
    ["uno.5V", "servo.V+"],
    ["uno.GND", "servo.GND"],
  ];
  return doc;
}

for (const voltage of [9, 12]) {
  const result = validateWorld(barrelOnVin(voltage), holdCtx);
  const codes = result.errors.map((issue) => issue.code);
  expect(!result.ok, `${voltage} V barrel on VIN passed`);
  expect(
    codes.includes("power-input") && !codes.includes("voltage-mismatch"),
    `${voltage} V barrel on VIN: ${codes.join(",") || "(none)"}`
  );
}

assertIssues(
  validateWorld(
    worldWith([
      ["uno.GND", "servo.V+"],
      ["uno.5V", "servo.GND"],
    ]),
    holdCtx
  ),
  "power and ground swapped",
  ["pin-kind", "pin-kind"],
  ["no-supply"]
);

assertIssues(
  validateWorld(worldWith([["usb.5V", "usb.GND"]]), holdCtx),
  "supply short",
  ["pin-kind"],
  ["no-supply"]
);

function withLed(doc: WorldFile, pin: string): WorldFile {
  doc.parts.push({ id: "led", model: "led-pwm" });
  doc.wires.push([`uno.${pin}`, "led.signal"]);
  return doc;
}

assertIssues(validateWorld(withLed(clone(hold), "D8"), holdCtx), "pwm pin", [
  "pwm-pin",
]);

const onD2 = clone(hold);
onD2.wires = onD2.wires.map((wire) =>
  wire[0] === "uno.D9" ? ["uno.D2", wire[1]] : wire
);
assertOk(validateWorld(onD2, holdCtx), "servo on D2");

assertIssues(
  validateWorld(withLed(clone(hold), "D10"), holdCtx),
  "servo pwm conflict",
  [],
  ["servo-pwm-conflict"]
);

const ledWithoutServo = clone(hold);
ledWithoutServo.wires = ledWithoutServo.wires.filter(
  (wire) => !wire.includes("servo.signal")
);
assertOk(
  validateWorld(withLed(ledWithoutServo, "D10"), holdCtx),
  "analogWrite on D10 with no servo signal"
);

const elbow = clone(hold);
elbow.parts[0]!.drives!.joint = "elbow";
const elbowResult = validateWorld(elbow, holdCtx);
assertIssues(elbowResult, "unknown joint", ["unknown-joint"]);
expect(elbowResult.errors[0]?.path === "parts[0].drives.joint", "joint path");

assertIssues(
  validateWorld(
    (() => {
      const doc = clone(hold);
      doc.wires.push(["uno.D99", "servo.signal"]);
      return doc;
    })(),
    holdCtx
  ),
  "unknown pin",
  ["unknown-pin"]
);

assertIssues(
  validateWorld(
    (() => {
      const doc = clone(hold);
      doc.wires.push(["ghost.GND", "uno.GND"]);
      return doc;
    })(),
    holdCtx
  ),
  "unknown instance",
  ["unknown-pin"]
);

const duplicateId = clone(hold);
duplicateId.parts[0]!.id = "uno";
assertIssues(validateWorld(duplicateId, holdCtx), "duplicate id", ["schema"]);

const unknownModel = clone(hold);
unknownModel.parts[0]!.model = "hobby";
assertIssues(validateWorld(unknownModel, holdCtx), "unknown model", ["schema"]);

const reads = clone(hold);
reads.parts[0]!.reads = { robot: "arm", site: "tip" };
assertIssues(validateWorld(reads, holdCtx), "reads is later", ["schema"]);

const missingFile = clone(hold);
missingFile.boards[0]!.firmware = "firmware/hold/missing.hex";
assertIssues(validateWorld(missingFile, holdCtx), "missing file", [
  "missing-file",
]);

function urdfWith(xml: string): UrdfInfo {
  return extractUrdfJointsAndMeshes(xml);
}

const meshFormat = validateWorld(
  hold,
  ctxFor(urdfWith(urdfText.replaceAll("meshes/base.stl", "meshes/base.3mf")))
);
assertIssues(meshFormat, "3mf mesh", ["mesh-format"]);
expect(meshFormat.errors[0]?.message.includes("cadgen stl build"), "mesh hint");

const missingMesh = validateWorld(
  hold,
  ctxFor(
    urdfWith(
      urdfText.replace(
        'filename="meshes/upper_arm.stl"',
        'filename="meshes/missing.stl"'
      )
    )
  )
);
assertIssues(missingMesh, "missing mesh", ["missing-file"]);
expect(
  missingMesh.errors[0]?.message.includes("meshes/missing.stl"),
  "missing mesh names the file"
);

const packageMesh = validateWorld(
  hold,
  ctxFor(
    urdfWith(
      urdfText.replace(
        'filename="meshes/base.stl"',
        'filename="package://arm/meshes/base.stl"'
      )
    )
  )
);
assertIssues(packageMesh, "package mesh", ["mesh-format"]);
expect(
  packageMesh.errors[0]?.message.includes("package://"),
  "package message"
);

const parentMesh = validateWorld(
  hold,
  ctxFor(
    urdfWith(
      urdfText.replace('filename="meshes/base.stl"', 'filename="../secret.stl"')
    )
  )
);
assertIssues(parentMesh, "parent mesh", ["mesh-format"]);

const packageCase = validateWorld(
  hold,
  ctxFor(
    urdfWith(
      urdfText.replace(
        'filename="meshes/base.stl"',
        'filename="Package://arm/base.stl"'
      )
    )
  )
);
assertIssues(packageCase, "Package:// mesh", ["mesh-format"]);

const absoluteMesh = validateWorld(
  hold,
  ctxFor(
    urdfWith(
      urdfText.replace('filename="meshes/base.stl"', 'filename="/tmp/base.stl"')
    )
  )
);
assertIssues(absoluteMesh, "absolute mesh", ["mesh-format"]);

const duplicateMesh = validateWorld(
  hold,
  ctxFor(
    urdfWith(
      urdfText.replace(
        'filename="meshes/upper_arm.stl"',
        'filename="meshes/base.stl"'
      )
    )
  )
);
assertIssues(
  duplicateMesh,
  "duplicate basename",
  [],
  ["duplicate-mesh-basename"]
);

const unpoweredBoard = clone(hold);
unpoweredBoard.wires = unpoweredBoard.wires.filter(
  (wire) =>
    !(wire[0] === "usb.5V" && wire[1] === "uno.5V") &&
    !(wire[0] === "uno.5V" && wire[1] === "usb.5V")
);
const unpoweredResult = validateWorld(unpoweredBoard, holdCtx);
assertIssues(unpoweredResult, "board with no supply", [], ["no-supply"]);
expect(
  unpoweredResult.warnings[0]?.message.includes(
    "board uno: no supply reaches its 5V pin"
  ) === true,
  `unpowered warning ${unpoweredResult.warnings[0]?.message ?? ""}`
);

console.log("world.selfcheck ok");
