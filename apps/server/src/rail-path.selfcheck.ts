/**
 * One rail path. A single board is that rail with N = 1, so its numbers
 * match the stamp constructor. Two boards split a pin edge. Two supplies
 * and two boards on one island are one circuit.
 */

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { arduinoPinBit, type RecordingRead } from "@sfab-bench/contract";
import { AVR_PIN } from "@sfab-bench/engine-circuit";
import { sha256Bytes } from "@sfab-bench/parts";
import { Sim } from "@sfab-bench/sim/sim";

import { boardStampOf } from "./world/circuit-stamp";
import { projectReal, readerFor, readInside } from "./world/files";
import { packageVersion } from "./world/package-version";
import { planWorld } from "./world/plan";
import { nodePlanEnv } from "./world/plan-host";
import { NANO_BOARD_A } from "./world/power-path";
import { createRailCircuit, type RailCircuit } from "./world/rail-circuit";
import { powerIslands } from "./world/wiring";

function expect(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(label);
}

const usb = { voltage: 5, rSeries: 0.5, currentLimit: 0.9 };
const bit = arduinoPinBit("D13");
if (bit === undefined) throw new Error("D13");

function stampOf(id: string) {
  return boardStampOf("sfab/nano-ch340@1.0.0", "circuits", { boardId: id });
}

function read(circuit: RailCircuit): string {
  return [
    circuit.voltage,
    circuit.current,
    circuit.boardVoltage,
    circuit.boardMinVoltage,
    circuit.ledCurrent,
    circuit.substeps,
    circuit.resetVoltage,
    circuit.lastPieceCount,
  ].join(",");
}

{
  const stamp = stampOf("nano");
  const viaStamp = createRailCircuit({
    vNom: usb.voltage,
    rSeries: usb.rSeries,
    iLimit: usb.currentLimit,
    motors: [],
    stamp,
    feed: "usb",
    pin: AVR_PIN,
    ledAlias: "nano.led",
  });
  const viaBoards = createRailCircuit({
    vNom: usb.voltage,
    rSeries: usb.rSeries,
    iLimit: usb.currentLimit,
    motors: [],
    pin: AVR_PIN,
    ledAlias: "nano.led",
    boards: [{ id: "nano", stamp, feed: "usb", pin: AVR_PIN }],
  });
  const step = (circuit: RailCircuit) => {
    circuit.setFixed(NANO_BOARD_A);
    circuit.setD13("low");
    circuit.solve();
    circuit.solve([
      { dt: 0.0005, drive: [{ bit, mode: "low" }] },
      { dt: 0.0005, drive: [{ bit, mode: "high" }] },
    ]);
  };
  step(viaStamp);
  step(viaBoards);
  const stampText = read(viaStamp);
  const boardText = read(viaBoards);
  expect(stampText === boardText, `N = 1 ${boardText} vs stamp ${stampText}`);
  expect(viaBoards.lastPieceCount === 2, `pieces ${viaBoards.lastPieceCount}`);
  expect(viaBoards.boardIds.length === 0, "N = 1 prefixed the board");
  console.log(
    `single-board general path: ${viaBoards.boardVoltage.toFixed(6)} V equals the stamp path, Δ 0, ${viaBoards.lastPieceCount} pieces`
  );
}

{
  const left = stampOf("left");
  const right = stampOf("right");
  const circuit = createRailCircuit({
    vNom: usb.voltage,
    rSeries: usb.rSeries,
    iLimit: usb.currentLimit,
    motors: [],
    boards: [
      { id: "left", stamp: left, feed: "usb", pin: AVR_PIN },
      { id: "right", stamp: right, feed: "usb", pin: AVR_PIN },
    ],
  });
  expect(circuit.boardIds.length === 2, "two boards are one rail");
  circuit.setBoardLoad("left", NANO_BOARD_A);
  circuit.setBoardLoad("right", NANO_BOARD_A);
  circuit.setBoardDrive("left", bit, "low");
  circuit.setBoardDrive("right", bit, "low");
  circuit.solve();
  circuit.solve([
    {
      dt: 0.0004,
      drive: [
        { boardId: "left", bit, mode: "low" },
        { boardId: "right", bit, mode: "low" },
      ],
    },
    {
      dt: 0.0006,
      drive: [
        { boardId: "left", bit, mode: "high" },
        { boardId: "right", bit, mode: "low" },
      ],
    },
  ]);
  const led = circuit.leds["left.led"] ?? 0;
  expect(circuit.lastPieceCount === 2, `pieces ${circuit.lastPieceCount}`);
  expect(led > 0.001, `left LED ${led}`);
  console.log(
    `two boards pin edge: ${circuit.lastPieceCount} pieces, left LED ${led.toFixed(6)} A`
  );
}

{
  const nanoExample = fileURLToPath(
    new URL("../../../examples/nano/", import.meta.url)
  );
  const dir = mkdtempSync(join(tmpdir(), "sfab-island-"));
  try {
    cpSync(join(nanoExample, "firmware"), join(dir, "firmware"), {
      recursive: true,
    });
    mkdirSync(join(dir, "parts", "sfab"), { recursive: true });
    const hex = "firmware/hold/hold.hex";
    const ino = "firmware/hold/hold.ino";
    writeFileSync(
      join(dir, "parts", "sfab", "island-scene@1.0.0.json"),
      JSON.stringify({
        format: "sfab.part@1",
        id: "sfab/island-scene@1.0.0",
        type: "assembly",
        foreign: false,
        axes: {
          behaviour: {
            "2": {
              default: "netlist",
              variants: {
                netlist: {
                  kind: "composite",
                  omits: ["island"],
                  netlist: {
                    instances: {
                      "a-usb": { part: "sfab/usb-port-500ma@1.0.0" },
                      "b-usb": { part: "sfab/usb-port-500ma@1.0.0" },
                      "a-board": {
                        part: "sfab/nano-ch340@1.0.0",
                        params: { firmware: hex, source: ino },
                      },
                      "b-board": {
                        part: "sfab/nano-ch340@1.0.0",
                        params: { firmware: hex, source: ino },
                      },
                    },
                    wires: [
                      ["a-usb.5V", "a-board.5V"],
                      ["b-usb.5V", "b-board.5V"],
                      ["a-board.5V", "b-board.5V"],
                      ["a-usb.GND", "a-board.GND"],
                      ["b-usb.GND", "b-board.GND"],
                      ["a-board.GND", "b-board.GND"],
                    ],
                    expose: {},
                  },
                },
              },
            },
          },
          body: {
            "0": {
              default: "none",
              variants: { none: { kind: "none", omits: ["none"] } },
            },
          },
          visual: {
            "0": {
              default: "none",
              variants: { none: { kind: "none", omits: ["none"] } },
            },
          },
        },
      })
    );
    writeFileSync(
      join(dir, "island.world.json"),
      JSON.stringify({
        version: 2,
        environment: { ground: { plane: true }, gravity: [0, 0, -9.81] },
        run: { seed: 1, levels: { default: 2 } },
        root: { id: "scene", part: "sfab/island-scene@1.0.0" },
      })
    );
    const planned = planWorld(dir, "island.world.json");
    expect(planned.ok, "two-supply island did not plan");
    if (!planned.ok) throw new Error("unreachable");
    const islands = powerIslands(planned.plan).filter(
      (island) => island.supplyIds.length > 1
    );
    expect(islands.length === 1, `islands ${islands.length}`);
    expect(
      islands[0]?.supplyIds.join("+") === "a-usb+b-usb",
      islands[0]?.supplyIds.join("+") ?? ""
    );
    const sim = new Sim({
      post() {},
      now: () => performance.now(),
      schedule: (fn, delay) => setTimeout(fn, delay),
      clear(handle) {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      },
      ledTrace: false,
      sha256: sha256Bytes,
      versions: {
        mujoco: packageVersion("@mujoco/mujoco", import.meta.url),
        avr8js: packageVersion("avr8js", import.meta.url),
      },
      projectReal,
      readInside,
      readerFor,
      plan: nodePlanEnv,
      keepSerial: false,
    });
    try {
      const loaded = await sim.load({
        project: dir,
        world: "island.world.json",
        generation: 1,
      });
      expect(loaded.ok, "two-supply island did not run");
      await sim.step(30);
      const settled = sim.state();
      if (!settled) throw new Error("no state");
      const body = sim.record({ op: "read", from: 0, to: settled.simTime });
      if (body.op !== "read") throw new Error("no recording");
      const read = body.read as RecordingRead;
      const frame = read.frames.at(-1);
      if (!frame) throw new Error("no frame");
      const a = frame.supplies["a-usb"];
      const b = frame.supplies["b-usb"];
      const left = frame.boards["a-board"];
      const right = frame.boards["b-board"];
      expect(a && b && left && right, "island frame is missing a rail");
      if (!a || !b || !left || !right) throw new Error("unreachable");
      expect(
        a.current > 0.01 && b.current > 0.01,
        `currents ${a.current} ${b.current}`
      );
      expect(
        Math.abs(left.voltage - right.voltage) < 1e-6,
        `5V ${left.voltage} ${right.voltage}`
      );
      console.log(
        `two supplies, two boards: one circuit, a-usb ${a.current.toFixed(6)} A, b-usb ${b.current.toFixed(6)} A, a-board 5V ${left.voltage.toFixed(6)} V, b-board 5V ${right.voltage.toFixed(6)} V`
      );
    } finally {
      sim.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
