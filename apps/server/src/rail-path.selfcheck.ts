/**
 * One rail path. A single board is that rail with N = 1, so its numbers
 * match the stamp constructor. Two boards split a pin edge. Two supplies
 * and two boards on one island are one circuit. A supply stamps on the
 * board its positive wire reaches, not on the board with the nearest id.
 * A shared ground is not an owner. A part on one board's 5V stays there,
 * a part between two boards is one branch, and an open node is a degraded row.
 */

import { ok as expect } from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import type { RecordingRead } from "@sfab-bench/contract";
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

function benchSim(): Sim {
  return new Sim({
    post() {},
    now: () => performance.now(),
    schedule: (fn, delay) => setTimeout(fn, delay),
    clear(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
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
}

const emptyAxes = {
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
};

const usb = { voltage: 5, rSeries: 0.5, currentLimit: 0.9 };
const bit = stampOf("d13").pins.find((pin) => pin.port === "D13")?.bit;
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
    writeFileSync(
      join(dir, "parts", "sfab", "cross-scene@1.0.0.json"),
      JSON.stringify({
        format: "sfab.part@1",
        id: "sfab/cross-scene@1.0.0",
        type: "assembly",
        foreign: false,
        axes: {
          behaviour: {
            "2": {
              default: "netlist",
              variants: {
                netlist: {
                  kind: "composite",
                  omits: ["cross"],
                  netlist: {
                    instances: {
                      "a-usb": { part: "sfab/usb-port-500ma@1.0.0" },
                      "z-usb": { part: "sfab/usb-port-500ma@1.0.0" },
                      "a-board": {
                        part: "sfab/nano-ch340@1.0.0",
                        params: { firmware: hex, source: ino },
                      },
                      "z-board": {
                        part: "sfab/nano-ch340@1.0.0",
                        params: { firmware: hex, source: ino },
                      },
                      // Nested on z-board. A sibling would also touch a-board
                      // through the shared ground and be pruned there.
                      "z-board.load": {
                        part: "sfab/resistor@1.0.0",
                        params: { R: 100 },
                      },
                    },
                    wires: [
                      ["a-usb.5V", "z-board.5V"],
                      ["z-usb.5V", "a-board.5V"],
                      ["a-usb.GND", "a-board.GND"],
                      ["z-usb.GND", "z-board.GND"],
                      ["a-board.GND", "z-board.GND"],
                      ["z-board.load.A", "z-board.5V"],
                      ["z-board.load.B", "z-board.GND"],
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
      join(dir, "cross.world.json"),
      JSON.stringify({
        version: 2,
        environment: { ground: { plane: true }, gravity: [0, 0, -9.81] },
        run: { seed: 1, levels: { default: 2 } },
        root: { id: "scene", part: "sfab/cross-scene@1.0.0" },
      })
    );
    const crossed = planWorld(dir, "cross.world.json");
    expect(crossed.ok, "crossed cables did not plan");
    if (!crossed.ok) throw new Error("unreachable");
    const crossIslands = powerIslands(crossed.plan).filter(
      (island) => island.supplyIds.length > 1
    );
    expect(crossIslands.length === 1, `crossed islands ${crossIslands.length}`);
    expect(
      crossIslands[0]?.supplyIds.join("+") === "a-usb+z-usb",
      crossIslands[0]?.supplyIds.join("+") ?? ""
    );
    const cross = new Sim({
      post() {},
      now: () => performance.now(),
      schedule: (fn, delay) => setTimeout(fn, delay),
      clear(handle) {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      },
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
      const loaded = await cross.load({
        project: dir,
        world: "cross.world.json",
        generation: 1,
      });
      expect(loaded.ok, "crossed cables did not run");
      await cross.step(80);
      const settled = cross.state();
      if (!settled) throw new Error("no state");
      const body = cross.record({ op: "read", from: 0, to: settled.simTime });
      if (body.op !== "read") throw new Error("no recording");
      const read = body.read as RecordingRead;
      const frame = read.frames.at(-1);
      if (!frame) throw new Error("no frame");
      const a = frame.supplies["a-usb"];
      const z = frame.supplies["z-usb"];
      const light = frame.boards["a-board"];
      const heavy = frame.boards["z-board"];
      expect(a && z && light && heavy, "crossed frame is missing a rail");
      if (!a || !z || !light || !heavy) throw new Error("unreachable");
      expect(
        a.current > z.current + 0.02,
        `a-usb ${a.current} A landed on a-board; z-usb ${z.current} A`
      );
      console.log(
        `crossed cables: a-usb ${a.current.toFixed(6)} A feeds z-board, z-usb ${z.current.toFixed(6)} A feeds a-board`
      );
    } finally {
      cross.dispose();
    }

    cpSync(
      join(nanoExample, "parts", "sfab", "flag@1.0.0.json"),
      join(dir, "parts", "sfab", "flag@1.0.0.json")
    );
    cpSync(join(nanoExample, "types"), join(dir, "types"), { recursive: true });
    cpSync(join(nanoExample, "robot"), join(dir, "robot"), { recursive: true });
    const pose = (position: [number, number, number]) => ({
      pose: { position, rotation: [1, 0, 0, 0] },
    });
    writeFileSync(
      join(dir, "parts", "sfab", "servo-scene@1.0.0.json"),
      JSON.stringify({
        format: "sfab.part@1",
        id: "sfab/servo-scene@1.0.0",
        type: "assembly",
        foreign: false,
        axes: {
          behaviour: {
            "2": {
              default: "netlist",
              variants: {
                netlist: {
                  kind: "composite",
                  omits: ["servo island"],
                  netlist: {
                    instances: {
                      "a-usb": {
                        part: "sfab/usb-port-500ma@1.0.0",
                        ...pose([0.04, 0.08, 0]),
                      },
                      "z-usb": {
                        part: "sfab/usb-port-500ma@1.0.0",
                        ...pose([0.04, -0.08, 0]),
                      },
                      "a-board": {
                        part: "sfab/nano-ch340@1.0.0",
                        ...pose([0.08, 0.08, 0.004]),
                        params: { firmware: hex, source: ino },
                      },
                      "z-board": {
                        part: "sfab/nano-ch340@1.0.0",
                        ...pose([0.08, -0.08, 0.004]),
                        params: { firmware: hex, source: ino },
                      },
                      servo: {
                        part: "sfab/sg90@1.0.0",
                        ...pose([0, -0.04, 0.0145]),
                      },
                      flag: {
                        part: "sfab/flag@1.0.0",
                        ...pose([0, -0.04, 0.029]),
                      },
                    },
                    wires: [
                      ["a-usb.5V", "a-board.5V"],
                      ["a-usb.GND", "a-board.GND"],
                      ["z-usb.5V", "z-board.5V"],
                      ["z-usb.GND", "z-board.GND"],
                      ["a-board.GND", "z-board.GND"],
                      ["servo.V+", "z-board.5V"],
                      ["servo.GND", "z-board.GND"],
                      ["servo.signal", "z-board.D9"],
                      ["servo.shaft", "flag.hinge"],
                      ["servo.mount", "flag.base"],
                    ],
                    expose: {},
                  },
                },
              },
            },
          },
          ...emptyAxes,
        },
      })
    );
    writeFileSync(
      join(dir, "servo.world.json"),
      JSON.stringify({
        version: 2,
        environment: { ground: { plane: true }, gravity: [0, 0, -9.81] },
        run: {
          seed: 1,
          levels: {
            default: 2,
            paths: {
              servo: { behaviour: 1, body: 1 },
              flag: { behaviour: 1, body: 1 },
            },
          },
        },
        root: { id: "scene", part: "sfab/servo-scene@1.0.0" },
      })
    );
    const servoSim = benchSim();
    try {
      const loaded = await servoSim.load({
        project: dir,
        world: "servo.world.json",
        generation: 1,
      });
      expect(loaded.ok, "z-board servo did not run");
      await servoSim.step(40);
      const settled = servoSim.state();
      if (!settled) throw new Error("no state");
      const body = servoSim.record({
        op: "read",
        from: 0,
        to: settled.simTime,
      });
      if (body.op !== "read") throw new Error("no recording");
      const frame = (body.read as RecordingRead).frames.at(-1);
      if (!frame) throw new Error("no frame");
      const a = frame.supplies["a-usb"];
      const z = frame.supplies["z-usb"];
      const motor = frame.parts.servo;
      expect(a && z && motor, "servo frame is missing a rail");
      if (!a || !z || !motor) throw new Error("unreachable");
      expect(
        z.current > a.current + 0.005,
        `servo current landed on a-usb ${a.current} z-usb ${z.current}`
      );
      expect(
        Math.abs(z.current - a.current - motor.current) < 1e-6,
        `z-usb ${z.current} a-usb ${a.current} servo ${motor.current}`
      );
      console.log(
        `servo on z-board: a-usb ${a.current.toFixed(6)} A, z-usb ${z.current.toFixed(6)} A, servo ${motor.current.toFixed(6)} A`
      );
    } finally {
      servoSim.dispose();
    }

    mkdirSync(join(dir, "firmware", "d13-low"), { recursive: true });
    writeFileSync(
      join(dir, "firmware", "d13-low", "d13-low.hex"),
      ":04000000259AFFCF6F\n:00000001FF\n"
    );
    writeFileSync(
      join(dir, "firmware", "d13-low", "d13-low.ino"),
      "void setup() { DDRB |= 1 << 5; }\nvoid loop() {}\n"
    );
    writeFileSync(
      join(dir, "parts", "sfab", "link-scene@1.0.0.json"),
      JSON.stringify({
        format: "sfab.part@1",
        id: "sfab/link-scene@1.0.0",
        type: "assembly",
        foreign: false,
        axes: {
          behaviour: {
            "2": {
              default: "netlist",
              variants: {
                netlist: {
                  kind: "composite",
                  omits: ["link"],
                  netlist: {
                    instances: {
                      "a-usb": { part: "sfab/usb-port-500ma@1.0.0" },
                      "z-usb": { part: "sfab/usb-port-500ma@1.0.0" },
                      "a-board": {
                        part: "sfab/nano-ch340@1.0.0",
                        params: { firmware: hex, source: ino },
                      },
                      "z-board": {
                        part: "sfab/nano-ch340@1.0.0",
                        params: {
                          firmware: "firmware/d13-low/d13-low.hex",
                          source: "firmware/d13-low/d13-low.ino",
                        },
                      },
                      link: {
                        part: "sfab/resistor@1.0.0",
                        params: { R: 1000 },
                      },
                    },
                    wires: [
                      ["a-usb.5V", "a-board.5V"],
                      ["a-usb.GND", "a-board.GND"],
                      ["z-usb.5V", "z-board.5V"],
                      ["z-usb.GND", "z-board.GND"],
                      ["a-board.GND", "z-board.GND"],
                      ["link.A", "a-board.5V"],
                      ["link.B", "z-board.D13"],
                    ],
                    expose: {},
                  },
                },
              },
            },
          },
          ...emptyAxes,
        },
      })
    );
    writeFileSync(
      join(dir, "link.world.json"),
      JSON.stringify({
        version: 2,
        environment: { ground: { plane: true }, gravity: [0, 0, -9.81] },
        run: { seed: 1, levels: { default: 2 } },
        root: { id: "scene", part: "sfab/link-scene@1.0.0" },
      })
    );
    const linkSim = benchSim();
    try {
      const loaded = await linkSim.load({
        project: dir,
        world: "link.world.json",
        generation: 1,
      });
      expect(loaded.ok, "cross-board resistor did not run");
      await linkSim.step(30);
      const reading = linkSim.branchReading("link");
      expect(reading, "link was pruned");
      if (!reading) throw new Error("unreachable");
      const [va, vb] = reading.voltages;
      expect(va !== undefined && vb !== undefined, "link has two nodes");
      const closed = Math.abs((va ?? 0) - (vb ?? 0)) / 1000;
      expect(reading.current > 0.001, `D13 did not sink, ${reading.current} A`);
      expect(
        Math.abs(reading.current - closed) < 1e-9,
        `link ${reading.current} closed ${closed}`
      );
      console.log(
        `resistor across boards: ${reading.current.toFixed(9)} A from ${va?.toFixed(6)} V and ${vb?.toFixed(6)} V`
      );
    } finally {
      linkSim.dispose();
    }

    writeFileSync(
      join(dir, "parts", "sfab", "open-scene@1.0.0.json"),
      JSON.stringify({
        format: "sfab.part@1",
        id: "sfab/open-scene@1.0.0",
        type: "assembly",
        foreign: false,
        axes: {
          behaviour: {
            "2": {
              default: "netlist",
              variants: {
                netlist: {
                  kind: "composite",
                  omits: ["open"],
                  netlist: {
                    instances: {
                      usb: { part: "sfab/usb-port-500ma@1.0.0" },
                      board: {
                        part: "sfab/nano-ch340@1.0.0",
                        params: { firmware: hex, source: ino },
                      },
                      open: {
                        part: "sfab/resistor@1.0.0",
                        params: { R: 1000 },
                      },
                    },
                    wires: [
                      ["usb.5V", "board.5V"],
                      ["usb.GND", "board.GND"],
                      ["open.A", "board.5V"],
                    ],
                    expose: {},
                  },
                },
              },
            },
          },
          ...emptyAxes,
        },
      })
    );
    writeFileSync(
      join(dir, "open.world.json"),
      JSON.stringify({
        version: 2,
        environment: { ground: { plane: true }, gravity: [0, 0, -9.81] },
        run: { seed: 1, levels: { default: 2 } },
        root: { id: "scene", part: "sfab/open-scene@1.0.0" },
      })
    );
    const openSim = benchSim();
    try {
      const loaded = await openSim.load({
        project: dir,
        world: "open.world.json",
        generation: 1,
      });
      expect(loaded.ok, "dangling part did not run");
      const settled = openSim.state();
      const row = settled?.diagnostics?.find((item) => item.path === "open");
      expect(
        row?.message === "not connected in this circuit",
        row?.message ?? "no degraded row for open"
      );
      console.log(`degraded open: ${row?.message}`);
    } finally {
      openSim.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
