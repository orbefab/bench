/**
 * Clone Nano at class 2 (ADR 0010, D-020, D-022). The USB diode, the
 * +5V capacitors, the D13 LED and the reset network are the rail. The
 * ATmega328P stays in avr8js.
 */

import { ok as expect } from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  pinBitSet,
  type RecordingRead,
  type WorldState,
} from "@sfab-bench/contract";
import { SS14, thermalVoltage } from "@sfab-bench/engine-circuit";
import { closeRootWatches } from "./projects";
import { boardStampOf } from "./world/circuit-stamp";
import {
  type AttachWorldOptions,
  attachWorld,
  readRecording,
  stopWorld,
} from "./world/host";
import { maxBoardDelta } from "./world/nano-reference";
import { planWorld } from "./world/plan";
import { BOD_ASSERT_V, BOD_RELEASE_V, RESET_HOLD_MS } from "./world/power";
import { NANO_BOARD_A } from "./world/power-path";
import { createRailCircuit, type RailCircuit } from "./world/rail-circuit";

/** Frozen with the SG90 catalog fit the arm self-checks use. */
const law = {
  k: 0.458,
  resistance: 7.1,
  quiescent: 0.01,
};
const usb = { voltage: 5, rSeries: 0.5, currentLimit: 0.9 };
/**
 * Raised cable resistance. The saturated SG90 pulls the board node
 * through 2.675 V; the idle draw, while the CPU is held, lets it rise
 * past 2.725 V so the 66 ms hold can finish.
 */
const BROWN_RS = 8;
/** Bridge ratio used as the holding point M1 can measure. */
const HOLD_S = 0.2;
const SETTLE = 80;
const MARGIN_V = -1e-3;
const nanoDir = fileURLToPath(
  new URL("../../../examples/nano/", import.meta.url)
);
const armDir = fileURLToPath(
  new URL("../../../examples/arm/", import.meta.url)
);
/** D13 is GPIO index 13 on the Nano expose order (D0–D13, A0–A5). */
const D13 = 13;

function driveSamples(
  read: RecordingRead
): { fraction: number; d13: "high" | "low" | "input" }[] {
  return read.frames.map((frame) => {
    const pulse = frame.parts.servo?.pulseUs ?? 0;
    const pins = frame.boards.nano?.pins;
    const driving = pins ? pinBitSet(pins.ddr, D13) : false;
    const high = pins ? pinBitSet(pins.level, D13) : false;
    const fraction =
      pulse > 0 ? Math.min(1, Math.max(0, (pulse - 1000) / 1000)) : 0;
    return {
      fraction,
      d13: !driving ? "input" : high ? "high" : "low",
    };
  });
}

/** SS14 terminal drop at `amps`, from the same Shockley fit the rail stamps. */
function ss14Drop(amps: number): number {
  const vt = thermalVoltage(SS14.tempC ?? 25) * SS14.N;
  const gmin = 1e-12;
  let vj = 0.35;
  for (let n = 0; n < 40; n++) {
    const e = Math.exp(vj / vt);
    const id = SS14.Is * (e - 1) + gmin * vj;
    const gd = (SS14.Is * e) / vt + gmin;
    const err = id - amps;
    if (Math.abs(err) < 1e-15) break;
    vj -= err / gd;
  }
  return vj + amps * SS14.Rs;
}

const NANO_STAMP = boardStampOf("sfab/nano-ch340@1.0.0", "circuits", {
  boardId: "nano",
});
const NANO_CLASS1 = boardStampOf("sfab/nano-ch340@1.0.0", "avr8js", {
  boardId: "nano",
});

function rail(
  path: "none" | "usb" | "header" | "class1" | "class1-header",
  rSeries: number,
  iLimit = usb.currentLimit
): RailCircuit {
  const stamp =
    path === "class1" || path === "class1-header" ? NANO_CLASS1 : NANO_STAMP;
  const feed = path === "header" || path === "class1-header" ? "header" : "usb";
  return createRailCircuit({
    vNom: usb.voltage,
    rSeries,
    iLimit,
    motors: [{ resistance: law.resistance, k: law.k }],
    ...(path === "none" ? {} : { stamp, feed }),
  });
}

/** Settle, then return the rail. `mode` is the D13 pin. */
function settle(
  circuit: RailCircuit,
  fraction: number,
  connected: boolean,
  mode: "high" | "low" | "input"
): { margin: number } {
  circuit.setFixed(NANO_BOARD_A + law.quiescent);
  circuit.setD13(mode);
  circuit.setMotor(0, fraction, 0, connected);
  let margin = Number.POSITIVE_INFINITY;
  for (let i = 0; i < SETTLE; i++) {
    circuit.solve();
    if (circuit.resetMarginMin < margin) margin = circuit.resetMarginMin;
  }
  return { margin };
}

function point(
  path: "none" | "usb" | "header" | "class1" | "class1-header",
  rSeries: number,
  fraction: number,
  connected: boolean,
  iLimit = usb.currentLimit
): RailCircuit {
  const circuit = rail(path, rSeries, iLimit);
  settle(circuit, fraction, connected, "input");
  return circuit;
}

{
  const stall = point("usb", usb.rSeries, 1, true);
  const board = stall.boardVoltage;
  const terminal = stall.voltage;
  const amps = stall.current;
  const drop = terminal - board;
  const model = ss14Drop(amps);
  expect(
    Math.abs(drop - model) <= 0.001,
    `diode drop ${drop} V vs SS14 ${model} V at ${amps} A`
  );
  const held = settle(stall, 1, true, "input");
  expect(
    held.margin >= MARGIN_V,
    `RESET margin ${held.margin} V during the stall`
  );
  stall.setMotor(0, 0, 0, false);
  const recovered = settle(stall, 0, false, "input");
  expect(
    recovered.margin >= MARGIN_V,
    `RESET margin ${recovered.margin} V during recovery`
  );
  console.log(
    `stall on USB at class 2: board ${board.toFixed(4)} V, ` +
      `terminal ${terminal.toFixed(4)} V, ` +
      `supply ${amps.toFixed(4)} A, ` +
      `diode drop ${drop.toFixed(4)} V`
  );
}

{
  const header = rail("header", usb.rSeries);
  settle(header, 0, false, "high");
  expect(
    Math.abs(header.voltage - header.boardVoltage) <= 0.001,
    `header board ${header.boardVoltage} V is not the terminal ${header.voltage} V`
  );
  expect(header.ledCurrent > 0.001, `header D13 drew ${header.ledCurrent} A`);
  console.log(
    `bench on 5V at class 2: board ${header.boardVoltage.toFixed(4)} V ` +
      `equals the terminal, D13 ${(header.ledCurrent * 1000).toFixed(2)} mA, no diode`
  );
}

{
  const rows = [
    ["rest", 0, false],
    ["holding", HOLD_S, true],
    ["stalled", 1, true],
  ] as const;
  const lines: string[] = [];
  for (const [level, path] of [
    ["ideal terminal", "none"],
    ["snapshot", "class1"],
    ["class 2", "usb"],
  ] as const) {
    const bits: string[] = [];
    for (const [name, fraction, connected] of rows) {
      const solved = point(path, usb.rSeries, fraction, connected);
      bits.push(`${name} ${solved.boardVoltage.toFixed(4)} V`);
    }
    lines.push(`${level}: ${bits.join(", ")}`);
  }
  console.log(lines.join("\n"));
}

{
  const sag = point("usb", BROWN_RS, 1, true);
  const idle = point("usb", BROWN_RS, 0, false);
  expect(
    sag.boardVoltage < BOD_ASSERT_V,
    `brownout stall ${sag.boardVoltage} V stayed above ${BOD_ASSERT_V} V`
  );
  expect(
    idle.boardVoltage > BOD_RELEASE_V,
    `brownout idle ${idle.boardVoltage} V stayed under ${BOD_RELEASE_V} V`
  );
  console.log(
    `brownout circuit: stall ${sag.boardVoltage.toFixed(3)} V, ` +
      `idle ${idle.boardVoltage.toFixed(3)} V, Rs ${BROWN_RS} ohm`
  );
}

{
  const cost = rail("usb", usb.rSeries);
  settle(cost, 1, true, "high");
  const n = 200;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) cost.solve();
  const us = ((performance.now() - t0) * 1000) / n;
  if (process.env.BENCH_TIMINGS === "1")
    console.log(
      `INFO nano usb path, one SG90: ${us.toFixed(1)} µs per 1 ms step`
    );
}

function class1Of(dir: string, stem: string): string {
  const world = JSON.parse(
    readFileSync(join(dir, "parts", "sfab", `${stem}@1.0.0.json`), "utf8")
  ) as {
    play?: { levels: unknown };
    run?: { levels: unknown };
  };
  if (world.play) world.play.levels = { default: 1 };
  else if (world.run) world.run.levels = { default: 1 };
  else throw new Error(`${stem} has no levels`);
  const name = `${stem}-c1.world.json`;
  writeFileSync(join(dir, name), `${JSON.stringify(world, null, 2)}\n`);
  return name;
}

function boardGap(
  low: RecordingRead,
  high: RecordingRead
): { maxAbs: number; rms: number } {
  const n = Math.min(low.frames.length, high.frames.length);
  let maxAbs = 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const a = low.frames[i]?.boards.nano?.voltage;
    const b = high.frames[i]?.boards.nano?.voltage;
    if (a === undefined || b === undefined) continue;
    const d = Math.abs(a - b);
    if (d > maxAbs) maxAbs = d;
    sum += (a - b) ** 2;
    count += 1;
  }
  return { maxAbs, rms: count > 0 ? Math.sqrt(sum / count) : 0 };
}

async function plannedBoard(
  dir: string,
  name: string,
  behaviour: 1 | 2,
  rs: number,
  iLimit: number,
  supply: "usb" | "bench" = "usb"
): Promise<{
  voltage: number;
  terminal: number;
  warnings: string[];
  table: boolean;
}> {
  const part =
    supply === "usb" ? "sfab/usb-port-500ma@1.0.0" : "sfab/bench-supply@1.0.0";
  writeFileSync(
    join(dir, "parts", "sfab", `${name}-scene@1.0.0.json`),
    `{
  "format": "sfab.part@1",
  "id": "sfab/${name}-scene@1.0.0",
  "type": "assembly",
  "foreign": false,
  "axes": {
    "behaviour": { "2": { "default": "netlist", "variants": { "netlist": {
      "kind": "composite", "omits": ["proof scene"],
      "netlist": {
        "instances": {
          "nano": { "part": "sfab/nano-ch340@1.0.0", "params": { "firmware": "firmware/hold/hold.hex", "source": "firmware/hold/hold.ino" } },
          "supply": { "part": "${part}", "params": { "Rs": ${rs}, "Ilimit": ${iLimit} } }
        },
        "wires": [["supply.5V", "nano.5V"], ["supply.GND", "nano.GND"]],
        "expose": {}
      }
    } } } },
    "body": { "0": { "default": "none", "variants": { "none": { "kind": "none", "omits": ["none"] } } } },
    "visual": { "0": { "default": "none", "variants": { "none": { "kind": "none", "omits": ["none"] } } } }
  }
}
`
  );
  const levels =
    behaviour === 2
      ? `"default": 1, "types": { "arduino-nano": { "behaviour": 2 } }`
      : `"default": 1`;
  writeFileSync(
    join(dir, `${name}.world.json`),
    `{
  "version": 2,
  "environment": { "ground": { "plane": true }, "gravity": [0, 0, -9.81] },
  "run": { "seed": 1, "levels": { ${levels} } },
  "root": { "id": "scene", "part": "sfab/${name}-scene@1.0.0" }
}
`
  );
  const planned = planWorld(dir, `${name}.world.json`);
  if (!planned.ok) {
    throw new Error(planned.errors.map((item) => item.message).join("; "));
  }
  const board = planned.plan.boards.find((item) => item.id === "nano");
  const fed = planned.plan.supplies[0];
  if (!board?.stamp || !fed) throw new Error(`${name} has no board`);
  const feed = supply === "usb" ? "usb" : "header";
  const circuit = createRailCircuit({
    vNom: fed.voltage,
    rSeries: fed.rSeries,
    iLimit: fed.currentLimit,
    motors: [],
    stamp: board.stamp,
    feed,
    pin: board.pin,
  });
  circuit.setFixed(board.current);
  for (let i = 0; i < 200; i++) circuit.solve();
  return {
    voltage: circuit.boardVoltage,
    terminal: circuit.voltage,
    warnings: planned.plan.report?.warnings.map((item) => item.message) ?? [],
    table: board.stamp.parts.some((part) => part.form === "table@1"),
  };
}

function expectRecorded(read: RecordingRead, label: string): void {
  expect(read.frames.length > 0, `${label} recorded no frames`);
  for (const frame of read.frames) {
    const board = frame.boards.nano;
    expect(board, `${label} missing the Nano at ${frame.t} s`);
    expect(
      (board?.voltage ?? -1) >= -1e-9,
      `${label} node ${frame.t} s at ${board?.voltage} V`
    );
  }
}

async function runWorld(
  project: string,
  world: string,
  ms: number,
  options?: AttachWorldOptions
): Promise<{ state: WorldState; read: RecordingRead }> {
  const planned = planWorld(project, world);
  if (!planned.ok) {
    throw new Error(planned.errors.map((item) => item.message).join("; "));
  }
  const seen: { state: WorldState | null; failed: string | null } = {
    state: null,
    failed: null,
  };
  const attached = await attachWorld(
    project,
    world,
    {
      sender: { kind: "loopback", label: "Mac" },
      onEvent(event) {
        if (event.type === "error") {
          seen.failed =
            event.message ??
            event.errors.map((item) => item.message).join("; ");
        }
        if (event.type === "state") seen.state = event.state;
      },
    },
    options
  );
  if ("error" in attached) throw new Error(attached.error);
  try {
    attached.step(ms);
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (seen.failed) throw new Error(seen.failed);
      const simTime = seen.state?.simTime ?? -1;
      if (simTime >= ms / 1000 - 1e-3) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const state = seen.state;
    if (!state || state.simTime < ms / 1000 - 1e-3) {
      throw new Error(
        `${world} timed out at ${state ? state.simTime : "no state"} s`
      );
    }
    const read = await readRecording(project, world, {
      from: 0,
      to: ms / 1000,
    });
    if ("error" in read) throw new Error(read.error);
    expectRecorded(read, world);
    return { state, read };
  } finally {
    attached.detach();
    await stopWorld(project, world);
    closeRootWatches();
  }
}

function writeStop(dir: string): void {
  writeFileSync(
    join(dir, "robot", "flag-stop.urdf"),
    `<?xml version="1.0"?>
<robot name="flag-stop">
  <mujoco><compiler fusestatic="false" discardvisual="false"/></mujoco>
  <link name="base">
    <inertial><origin xyz="0 0 0.01" rpy="0 0 0"/><mass value="0.02"/>
      <inertia ixx="0.000003" ixy="0" ixz="0" iyy="0.000003" iyz="0" izz="0.000005"/>
    </inertial>
    <visual><origin xyz="0 0 0.01" rpy="0 0 0"/><geometry><box size="0.04 0.04 0.02"/></geometry></visual>
  </link>
  <link name="vane">
    <inertial><origin xyz="0.04 0 0" rpy="0 0 0"/><mass value="0.01"/>
      <inertia ixx="0.0000004" ixy="0" ixz="0" iyy="0.0000054" iyz="0" izz="0.0000055"/>
    </inertial>
    <visual><origin xyz="0.04 0 0" rpy="0 0 0"/><geometry><box size="0.08 0.02 0.005"/></geometry></visual>
  </link>
  <joint name="hinge" type="revolute">
    <parent link="base"/><child link="vane"/>
    <origin xyz="0 0 0.0125" rpy="0 0 0"/><axis xyz="0 0 1"/>
    <limit lower="0" upper="0.05" effort="0.18" velocity="10.472"/>
    <dynamics damping="0.001" friction="0"/>
  </joint>
</robot>
`
  );
  writeFileSync(
    join(dir, "parts", "sfab", "flag-stop@1.0.0.json"),
    `{
  "format": "sfab.part@1",
  "id": "sfab/flag-stop@1.0.0",
  "type": "flag-hinge",
  "foreign": false,
  "sources": [{ "title": "stall stop", "ref": "upper limit 0.05 rad, so a pi rad command stays saturated at rest" }],
  "axes": {
    "behaviour": { "1": { "default": "rigid", "variants": { "rigid": { "kind": "form", "form": "multibody@1", "params": {}, "omits": ["joint flexibility"] } } } },
    "body": { "1": { "default": "urdf", "variants": { "urdf": { "kind": "urdf", "file": "robot/flag-stop.urdf", "omits": ["link flex"] } } } },
    "visual": { "0": { "default": "box", "variants": { "box": { "kind": "box", "size": [0.08, 0.04, 0.02], "omits": ["link meshes"] } } } }
  }
}
`
  );
}

function writeVariant(
  dir: string,
  name: string,
  firmware: string,
  source: string,
  behaviour: 1 | 2,
  rs?: number,
  flag = "sfab/flag@1.0.0"
): void {
  const usbParams =
    rs === undefined ? "" : `,\n                  "params": { "Rs": ${rs} }`;
  const levels =
    behaviour === 2
      ? `"default": 1,
      "types": { "arduino-nano": { "behaviour": 2 } }`
      : `"default": 1`;
  writeFileSync(
    join(dir, "parts", "sfab", `${name}-scene@1.0.0.json`),
    `{
  "format": "sfab.part@1",
  "id": "sfab/${name}-scene@1.0.0",
  "type": "assembly",
  "foreign": false,
  "axes": {
    "behaviour": {
      "2": {
        "default": "netlist",
        "variants": {
          "netlist": {
            "kind": "composite",
            "omits": ["no snapshot of this assembly"],
            "netlist": {
              "instances": {
                "flag": { "part": "${flag}" },
                "nano": {
                  "part": "sfab/nano-ch340@1.0.0",
                  "params": {
                    "firmware": "${firmware}",
                    "source": "${source}"
                  }
                },
                "usb": { "part": "sfab/usb-port-500ma@1.0.0"${usbParams} },
                "servo": { "part": "sfab/sg90@1.0.0" }
              },
              "wires": [
                ["usb.5V", "nano.5V"],
                ["usb.GND", "nano.GND"],
                ["nano.D9", "servo.signal"],
                ["nano.5V", "servo.V+"],
                ["nano.GND", "servo.GND"],
                ["servo.shaft", "flag.hinge"],
                ["servo.mount", "flag.base"]
              ],
              "expose": {}
            }
          }
        }
      }
    },
    "body": { "0": { "default": "none", "variants": { "none": { "kind": "none", "omits": ["assembly adds no body"] } } } },
    "visual": { "0": { "default": "none", "variants": { "none": { "kind": "none", "omits": ["assembly adds no visual"] } } } }
  }
}
`
  );
  writeFileSync(
    join(dir, `${name}.world.json`),
    `{
  "version": 2,
  "environment": { "ground": { "plane": true }, "gravity": [0, 0, -9.81] },
  "run": { "seed": 1, "levels": { ${levels} } },
  "root": { "id": "scene", "part": "sfab/${name}-scene@1.0.0" }
}
`
  );
}

const root = mkdtempSync(join(tmpdir(), "sfab-nano-"));
try {
  cpSync(nanoDir, root, { recursive: true });
  mkdirSync(join(root, "firmware", "stall"), { recursive: true });
  cpSync(
    join(armDir, "firmware", "stall", "stall.hex"),
    join(root, "firmware", "stall", "stall.hex")
  );
  cpSync(
    join(armDir, "firmware", "stall", "stall.ino"),
    join(root, "firmware", "stall", "stall.ino")
  );
  writeStop(root);
  writeVariant(
    root,
    "nano-stall",
    "firmware/stall/stall.hex",
    "firmware/stall/stall.ino",
    2,
    undefined,
    "sfab/flag-stop@1.0.0"
  );
  writeVariant(
    root,
    "nano-stall-c1",
    "firmware/stall/stall.hex",
    "firmware/stall/stall.ino",
    1,
    undefined,
    "sfab/flag-stop@1.0.0"
  );
  writeVariant(
    root,
    "nano-brown",
    "firmware/stall/stall.hex",
    "firmware/stall/stall.ino",
    2,
    BROWN_RS,
    "sfab/flag-stop@1.0.0"
  );
  writeVariant(
    root,
    "nano-blink",
    "firmware/blink/blink.hex",
    "firmware/blink/blink.ino",
    2
  );

  const stalled2 = await runWorld(root, "nano-stall.world.json", 1000);
  const stalled1 = await runWorld(root, "nano-stall-c1.world.json", 1000);
  const tail2 = stalled2.read.frames[stalled2.read.frames.length - 1];
  const tail1 = stalled1.read.frames[stalled1.read.frames.length - 1];
  const live2 = tail2?.boards.nano?.voltage ?? Number.NaN;
  const live1 = tail1?.boards.nano?.voltage ?? Number.NaN;
  const circuit2 = point("usb", usb.rSeries, 1, true).boardVoltage;
  const circuit1 = point("class1", usb.rSeries, 1, true).boardVoltage;
  expect(
    Math.abs(live2 - circuit2) <= 0.001,
    `class 2 world stall ${live2} V vs circuit ${circuit2} V`
  );
  expect(
    Math.abs(live1 - circuit1) <= 0.001,
    `class 1 world stall ${live1} V vs circuit ${circuit1} V`
  );
  expect(
    stalled2.read.frames.every(
      (frame) => frame.boards.nano?.ledCurrent !== undefined
    ),
    "class 2 recording omitted ledCurrent"
  );
  expect(
    stalled1.read.frames.every(
      (frame) => frame.boards.nano?.ledCurrent === undefined
    ),
    "class 1 recording carried ledCurrent"
  );
  console.log(
    `world stall: class 1 ${live1.toFixed(4)} V, class 2 ${live2.toFixed(4)} V`
  );

  const browned = await runWorld(root, "nano-brown.world.json", 400);
  const reset = browned.read.events.find((event) => event.kind === "reset");
  const reboot = browned.read.events.find((event) => event.kind === "reboot");
  expect(reset, "brownout did not reset");
  expect(reboot, "brownout did not reboot");
  expect(
    reboot.t - reset.t >= RESET_HOLD_MS / 1000 - 1e-9,
    `reboot ${reboot.t - reset.t} s after reset, hold is ${RESET_HOLD_MS} ms`
  );
  const dipped = browned.read.frames.some(
    (frame) => (frame.boards.nano?.minVoltage ?? 5) < BOD_ASSERT_V
  );
  expect(dipped, "board node never crossed 2.675 V");
  expect(
    (browned.state.boards.nano?.resets ?? 0) >= 1,
    "live state recorded no reset"
  );
  console.log(
    `brownout: reset at ${reset.t.toFixed(3)} s, ` +
      `reboot at ${reboot.t.toFixed(3)} s ` +
      `(${((reboot.t - reset.t) * 1000).toFixed(0)} ms)`
  );

  const blink = await runWorld(root, "nano-blink.world.json", 1000);
  let on = 0;
  let off = 0;
  let onCurrent = 0;
  for (const frame of blink.read.frames) {
    const board = frame.boards.nano;
    const pins = board?.pins;
    const led = board?.ledCurrent;
    if (!pins || led === undefined) continue;
    const driving = pinBitSet(pins.ddr, D13);
    const high = pinBitSet(pins.level, D13);
    if (!driving) continue;
    if (high) {
      on += 1;
      if (led > onCurrent) onCurrent = led;
      expect(led > 0.001, `D13 high drew ${led} A at ${frame.t} s`);
    } else {
      off += 1;
      expect(led < 0.0002, `D13 low drew ${led} A at ${frame.t} s`);
    }
  }
  expect(on >= 5 && off >= 5, `D13 samples on ${on}, off ${off}`);
  console.log(`D13 on current ${(onCurrent * 1000).toFixed(2)} mA`);

  const first = await runWorld(
    root,
    "parts/sfab/nano-servo-usb@1.0.0.json",
    3000
  );
  const second = await runWorld(
    root,
    "parts/sfab/nano-servo-usb@1.0.0.json",
    3000
  );
  expect(
    JSON.stringify(first.read) === JSON.stringify(second.read),
    "class 2 Nano runs are not byte-identical"
  );
  expect(
    first.read.frames.some((frame) => frame.parts.servo !== undefined),
    "the SG90 did not record"
  );
  console.log(`nano on USB, SG90 on D9, class 2, 3 s, two runs byte-identical`);

  const vcc = await runWorld(root, "parts/sfab/nano-vcc-usb@1.0.0.json", 1000);
  const match = {
    vNom: usb.voltage,
    rSeries: usb.rSeries,
    iLimit: usb.currentLimit,
    fixed: NANO_BOARD_A + law.quiescent,
    motors: [{ resistance: law.resistance, k: law.k }],
  };
  const servoDelta = maxBoardDelta(driveSamples(first.read), match);
  const vccDelta = maxBoardDelta(driveSamples(vcc.read), match);
  expect(servoDelta <= 1e-6, `nano-servo-usb board delta ${servoDelta} V`);
  expect(vccDelta <= 1e-6, `nano-vcc-usb board delta ${vccDelta} V`);
  console.log(
    `nano netlist vs reference: nano-vcc-usb ${vccDelta.toExponential(2)} V, ` +
      `nano-servo-usb ${servoDelta.toExponential(2)} V`
  );

  const vcc1 = await runWorld(root, class1Of(root, "nano-vcc-usb"), 1000);
  const servo1 = await runWorld(root, class1Of(root, "nano-servo-usb"), 3000);
  const vccGap = boardGap(vcc1.read, vcc.read);
  const servoGap = boardGap(servo1.read, first.read);
  expect(
    vccGap.maxAbs <= 0.005,
    `nano-vcc-usb class 1 vs class 2 ${vccGap.maxAbs} V`
  );
  expect(
    servoGap.maxAbs <= 0.005,
    `nano-servo-usb class 1 vs class 2 ${servoGap.maxAbs} V`
  );
  console.log(
    `nano-vcc-usb class 1 vs class 2: max-abs ${(vccGap.maxAbs * 1000).toFixed(3)} mV, rms ${(vccGap.rms * 1000).toFixed(3)} mV`
  );
  console.log(
    `nano-servo-usb class 1 vs class 2: max-abs ${(servoGap.maxAbs * 1000).toFixed(3)} mV, rms ${(servoGap.rms * 1000).toFixed(3)} mV`
  );

  const wide1 = await plannedBoard(root, "wide-c1", 1, 1.5, 0.5);
  const wide2 = await plannedBoard(root, "wide-c2", 2, 1.5, 0.5);
  const wideDv = Math.abs(wide1.voltage - wide2.voltage);
  expect(
    wide1.warnings.every((line) => !line.includes("ideal terminal")),
    `wide usb warned: ${wide1.warnings.join("; ")}`
  );
  expect(wide1.table, "wide usb class 1 did not stamp the power group");
  expect(wideDv <= 0.005, `wide usb class 1 vs class 2 ${wideDv} V`);
  console.log(
    `class 1 outside feed bounds: Rs 1.5 ohm, Ilimit 0.5 A, no ideal-terminal warning, |Δ| ${(wideDv * 1000).toFixed(3)} mV vs class 2`
  );

  const head1 = await plannedBoard(root, "head-c1", 1, 0.05, 1, "bench");
  const head2 = await plannedBoard(root, "head-c2", 2, 0.05, 1, "bench");
  expect(
    head1.warnings.every((line) => !line.includes("ideal terminal")),
    `header warned: ${head1.warnings.join("; ")}`
  );
  expect(
    Math.abs(head1.voltage - head1.terminal) <= 0.001,
    `header class 1 board ${head1.voltage} V is not the terminal ${head1.terminal} V`
  );
  console.log(
    `class 1 header: board ${head1.voltage.toFixed(4)} V, class 2 ${head2.voltage.toFixed(4)} V, no ideal-terminal warning`
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
