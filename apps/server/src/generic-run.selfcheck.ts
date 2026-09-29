/**
 * The run dispatches leaves, at any depth. A composite is a shell.
 * A wire names the instance path, then the port.
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

import type { PartFile } from "@sfab-bench/contract";
import {
  AVR_PIN,
  CurrentLoad,
  Diode,
  Engine,
  LED_RED,
  Resistor,
  TheveninLimit,
} from "@sfab-bench/engine-circuit";
import {
  type BoardStamp,
  type boardStampOf,
  realize,
} from "./world/circuit-stamp";
import { catalogRoot, planWorld } from "./world/plan";
import { BOARD_LOAD_KNEE_V, NANO_BOARD_A } from "./world/power-path";
import { createRailCircuit, type RailCircuit } from "./world/rail-circuit";

const law = { k: 0.458, resistance: 7.1, quiescent: 0.01 };
const usb = { voltage: 5, rSeries: 0.5, currentLimit: 0.9 };
const SETTLE = 80;
const nanoExample = fileURLToPath(
  new URL("../../../examples/nano/", import.meta.url)
);

function writeJson(file: string, value: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function copyVcc(dir: string): void {
  mkdirSync(join(dir, "firmware", "vcc"), { recursive: true });
  cpSync(
    join(nanoExample, "firmware", "vcc", "vcc.hex"),
    join(dir, "firmware", "vcc", "vcc.hex")
  );
  cpSync(
    join(nanoExample, "firmware", "vcc", "vcc.ino"),
    join(dir, "firmware", "vcc", "vcc.ino")
  );
}

function sceneWorld(
  instances: Record<
    string,
    { part: string; params?: Record<string, string | number> }
  >,
  wires: [string, string][],
  levels: {
    default: number;
    paths?: Record<string, { behaviour: number }>;
  } = { default: 2 }
): unknown {
  return {
    version: 2,
    environment: { ground: { plane: true }, gravity: [0, 0, -9.81] },
    run: { seed: 1, levels },
    root: {
      id: "scene",
      part: {
        format: "sfab.part@1",
        id: "sfab/scene@1.0.0",
        type: "assembly",
        axes: {
          behaviour: {
            "2": {
              default: "netlist",
              variants: {
                netlist: {
                  kind: "composite",
                  omits: ["test scene"],
                  netlist: { instances, wires, expose: {} },
                },
              },
            },
          },
          body: noneAxis("none"),
          visual: noneAxis("none"),
        },
      },
    },
  };
}

const nanoParams = {
  firmware: "firmware/vcc/vcc.hex",
  source: "firmware/vcc/vcc.ino",
};

/** Tie both VBUS nodes to one terminal, the way the shared rail does. */
function tieUsb(stamp: BoardStamp): BoardStamp {
  const from = stamp.vbusNode;
  if (!from) throw new Error("class 1 nano has no VBUS");
  const map = (node: string) => (node === from ? "term" : node);
  return {
    ...stamp,
    boardNode: map(stamp.boardNode),
    vbusNode: "term",
    resetNode: stamp.resetNode ? map(stamp.resetNode) : null,
    portNodes: Object.fromEntries(
      Object.entries(stamp.portNodes).map(([name, node]) => [name, map(node)])
    ),
    parts: stamp.parts.map((part) => ({
      ...part,
      nodes: Object.fromEntries(
        Object.entries(part.nodes).map(([name, node]) => [name, map(node)])
      ),
    })),
    pins: stamp.pins.map((pin) => ({ ...pin, node: map(pin.node) })),
  };
}

function tiedPair(
  left: BoardStamp,
  right: BoardStamp,
  leftAmps: number,
  rightAmps: number
): { left: number; right: number } {
  const leftR = realize(tieUsb(left), "usb", AVR_PIN, {
    pinId: (port) => `pin.left.${port}`,
  });
  const rightR = realize(tieUsb(right), "usb", AVR_PIN, {
    pinId: (port) => `pin.right.${port}`,
  });
  const leftLoad = new CurrentLoad(
    "load.left",
    leftR.boardNode,
    "0",
    BOARD_LOAD_KNEE_V
  );
  const rightLoad = new CurrentLoad(
    "load.right",
    rightR.boardNode,
    "0",
    BOARD_LOAD_KNEE_V
  );
  leftLoad.amps = leftAmps;
  rightLoad.amps = rightAmps;
  const engine = new Engine(
    [
      new TheveninLimit(
        "src",
        "term",
        "0",
        usb.voltage,
        usb.rSeries,
        usb.currentLimit
      ),
      leftLoad,
      rightLoad,
      ...leftR.elements,
      ...rightR.elements,
    ],
    { method: "be", h: 0.001, atol: 1e-14, rtol: 1e-12 }
  );
  engine.operatingPoint();
  return {
    left: engine.voltage(leftR.boardNode),
    right: engine.voltage(rightR.boardNode),
  };
}

function noneAxis(kind: "none"): {
  "0": {
    default: "none";
    variants: { none: { kind: "none"; omits: string[] } };
  };
} {
  return {
    "0": {
      default: "none",
      variants: { none: { kind, omits: ["none"] } },
    },
  };
}

/** 5V node after the rail has settled. */
function nodeAt(
  stamp: NonNullable<ReturnType<typeof boardStampOf>>,
  fraction: number,
  connected: boolean
): number {
  const circuit: RailCircuit = createRailCircuit({
    vNom: usb.voltage,
    rSeries: usb.rSeries,
    iLimit: usb.currentLimit,
    motors: [{ resistance: law.resistance, k: law.k }],
    stamp,
    feed: "usb",
  });
  circuit.setFixed(NANO_BOARD_A + law.quiescent);
  circuit.setD13("input");
  circuit.setMotor(0, fraction, 0, connected);
  for (let i = 0; i < SETTLE; i++) circuit.solve();
  return circuit.boardVoltage;
}

/**
 * The catalog Nano, with s4 and c106 moved under a composite `power`
 * that exposes VBUS, 5V and GND. The rest of the board netlist is the
 * same children and the same connections.
 */
function nestedNano(dir: string): void {
  mkdirSync(join(dir, "firmware", "vcc"), { recursive: true });
  cpSync(
    join(nanoExample, "firmware", "vcc", "vcc.hex"),
    join(dir, "firmware", "vcc", "vcc.hex")
  );
  cpSync(
    join(nanoExample, "firmware", "vcc", "vcc.ino"),
    join(dir, "firmware", "vcc", "vcc.ino")
  );
  const nano = JSON.parse(
    readFileSync(
      join(catalogRoot(), "parts", "sfab", "nano-ch340@1.0.0.json"),
      "utf8"
    )
  ) as PartFile;
  const slot = nano.axes?.behaviour?.["2"];
  const circuits = slot?.variants.circuits;
  if (!circuits || circuits.kind !== "firmware" || !circuits.board) {
    throw new Error("catalog nano has no class-2 board");
  }
  const board = circuits.board;
  delete board.instances.s4;
  delete board.instances.c106;
  board.instances.power = { part: "sfab/nano-power@1.0.0" };
  board.wires = [
    ["power.5V", "cvcc.A"],
    ["power.5V", "cavcc.A"],
    ["power.5V", "rrst.A"],
    ["power.5V", "crst.A"],
    ["power.GND", "cvcc.B"],
    ["power.GND", "cavcc.B"],
    ["power.GND", "led.K"],
    ["rrst.B", "crst.B"],
    ["rled.B", "led.A"],
  ];
  board.expose = {
    VBUS: "power.VBUS",
    "5V": "power.5V",
    GND: "power.GND",
    RESET: "rrst.B",
    D13: "rled.A",
  };
  writeJson(join(dir, "parts", "sfab", "nano-ch340@1.0.0.json"), nano);
  writeJson(join(dir, "types", "nano-power.json"), {
    format: "sfab.part-type@1",
    id: "nano-power",
    ports: {
      VBUS: { domain: "electrical", role: "power", direction: "in" },
      "5V": { domain: "electrical", role: "power", direction: "in" },
      GND: { domain: "electrical", role: "ground", direction: "passive" },
    },
  });
  writeJson(join(dir, "parts", "sfab", "nano-power@1.0.0.json"), {
    format: "sfab.part@1",
    id: "sfab/nano-power@1.0.0",
    type: "nano-power",
    axes: {
      behaviour: {
        "2": {
          default: "netlist",
          variants: {
            netlist: {
              kind: "composite",
              omits: ["test shell"],
              netlist: {
                instances: {
                  s4: { part: "sfab/diode-ss14@1.0.0" },
                  c106: {
                    part: "sfab/capacitor@1.0.0",
                    params: { C: 0.00001, esr: 5 },
                  },
                },
                wires: [["s4.K", "c106.A"]],
                expose: {
                  VBUS: "s4.A",
                  "5V": "c106.A",
                  GND: "c106.B",
                },
              },
            },
          },
        },
      },
      body: noneAxis("none"),
      visual: noneAxis("none"),
    },
  });
  writeJson(join(dir, "nested.world.json"), {
    version: 2,
    environment: { ground: { plane: true }, gravity: [0, 0, -9.81] },
    run: {
      seed: 1,
      levels: { default: 1, types: { "arduino-nano": { behaviour: 2 } } },
    },
    root: {
      id: "scene",
      part: {
        format: "sfab.part@1",
        id: "sfab/nested-nano-scene@1.0.0",
        type: "assembly",
        axes: {
          behaviour: {
            "2": {
              default: "netlist",
              variants: {
                netlist: {
                  kind: "composite",
                  omits: ["test scene"],
                  netlist: {
                    instances: {
                      nano: {
                        part: "sfab/nano-ch340@1.0.0",
                        params: {
                          firmware: "firmware/vcc/vcc.hex",
                          source: "firmware/vcc/vcc.ino",
                        },
                      },
                      usb: { part: "sfab/usb-port-500ma@1.0.0" },
                    },
                    wires: [
                      ["usb.5V", "nano.5V"],
                      ["usb.GND", "nano.GND"],
                    ],
                    expose: {},
                  },
                },
              },
            },
          },
          body: noneAxis("none"),
          visual: noneAxis("none"),
        },
      },
    },
  });
}

function sameNet(wires: [string, string][], a: string, b: string): boolean {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const p = parent.get(id);
    if (!p || p === id) {
      parent.set(id, id);
      return id;
    }
    const root = find(p);
    parent.set(id, root);
    return root;
  };
  const union = (left: string, right: string) => {
    const pa = find(left);
    const pb = find(right);
    if (pa !== pb) parent.set(pb, pa);
  };
  for (const [left, right] of wires) union(left, right);
  return find(a) === find(b);
}

{
  const dir = mkdtempSync(join(tmpdir(), "sfab-nested-power-"));
  try {
    nestedNano(dir);
    const planned = planWorld(dir, "nested.world.json");
    if (!planned.ok) {
      throw new Error(planned.errors.map((item) => item.message).join("; "));
    }
    const stamp = planned.plan.boards.find(
      (board) => board.id === "nano"
    )?.stamp;
    expect(stamp, "nested nano has no stamp");
    expect(
      stamp.parts.some((part) => part.path === "nano.power.s4"),
      "s4 was not stamped under power"
    );
    const flatRest = 4.7132641361241063;
    const flatStall = 4.2645668254013147;
    const rest = Math.abs(nodeAt(stamp, 0, false) - flatRest);
    const stall = Math.abs(nodeAt(stamp, 1, true) - flatStall);
    expect(rest <= 1e-12, `nested power rest Δ ${rest} V`);
    expect(stall <= 1e-12, `nested power stall Δ ${stall} V`);
    console.log(
      `nested power vs nano: rest Δ ${rest.toExponential(2)} V, stall Δ ${stall.toExponential(2)} V`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = mkdtempSync(join(tmpdir(), "sfab-sg90-class2-"));
  try {
    writeJson(join(dir, "sg90.world.json"), {
      version: 2,
      environment: { ground: { plane: true }, gravity: [0, 0, -9.81] },
      run: {
        seed: 1,
        levels: { default: 1, paths: { servo: { behaviour: 2 } } },
      },
      root: {
        id: "scene",
        part: {
          format: "sfab.part@1",
          id: "sfab/sg90-scene@1.0.0",
          type: "assembly",
          axes: {
            behaviour: {
              "2": {
                default: "netlist",
                variants: {
                  netlist: {
                    kind: "composite",
                    omits: ["test scene"],
                    netlist: {
                      instances: { servo: { part: "sfab/sg90@1.0.0" } },
                      wires: [],
                      expose: {},
                    },
                  },
                },
              },
            },
            body: noneAxis("none"),
            visual: noneAxis("none"),
          },
        },
      },
    });
    const planned = planWorld(dir, "sg90.world.json");
    expect(planned.ok, "sg90 class 2 did not run");
    if (!planned.ok) throw new Error("unreachable");
    const rows = planned.plan.degraded ?? [];
    const motor = rows.find((item) => item.path === "servo.motor");
    expect(
      motor,
      `no servo.motor diagnostic: ${rows.map((item) => item.message).join("; ")}`
    );
    expect(
      motor.message.includes("no runtime for a declared-only part"),
      motor.message
    );
    expect(
      rows.every((item) => !item.message.includes("nested instance")),
      rows.map((item) => item.message).join("; ")
    );
    console.log(`degraded ${motor.path}: ${motor.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = mkdtempSync(join(tmpdir(), "sfab-nested-wire-"));
  try {
    writeJson(join(dir, "types", "shell.json"), {
      format: "sfab.part-type@1",
      id: "shell",
      ports: {},
    });
    writeJson(join(dir, "types", "inner-box.json"), {
      format: "sfab.part-type@1",
      id: "inner-box",
      ports: {
        "5V": {
          domain: "electrical",
          role: "power",
          direction: "in",
        },
      },
    });
    writeJson(join(dir, "parts", "sfab", "inner@1.0.0.json"), {
      format: "sfab.part@1",
      id: "sfab/inner@1.0.0",
      type: "inner-box",
      axes: {
        behaviour: {
          "2": {
            default: "netlist",
            variants: {
              netlist: {
                kind: "composite",
                omits: ["test shell"],
                netlist: {
                  instances: {
                    r: {
                      part: "sfab/resistor@1.0.0",
                      params: { R: 1000 },
                    },
                  },
                  wires: [],
                  expose: { "5V": "r.A" },
                },
              },
            },
          },
        },
        body: noneAxis("none"),
        visual: noneAxis("none"),
      },
    });
    writeJson(join(dir, "parts", "sfab", "shell@1.0.0.json"), {
      format: "sfab.part@1",
      id: "sfab/shell@1.0.0",
      type: "shell",
      axes: {
        behaviour: {
          "2": {
            default: "netlist",
            variants: {
              netlist: {
                kind: "composite",
                omits: ["test shell"],
                netlist: {
                  instances: { inner: { part: "sfab/inner@1.0.0" } },
                  wires: [],
                  expose: {},
                },
              },
            },
          },
        },
        body: noneAxis("none"),
        visual: noneAxis("none"),
      },
    });
    writeJson(join(dir, "nested-wire.world.json"), {
      version: 2,
      environment: { ground: { plane: true }, gravity: [0, 0, -9.81] },
      run: { seed: 1, levels: { default: 2 } },
      root: {
        id: "scene",
        part: {
          format: "sfab.part@1",
          id: "sfab/wire-scene@1.0.0",
          type: "assembly",
          axes: {
            behaviour: {
              "2": {
                default: "netlist",
                variants: {
                  netlist: {
                    kind: "composite",
                    omits: ["test scene"],
                    netlist: {
                      instances: {
                        asm: { part: "sfab/shell@1.0.0" },
                        bench: { part: "sfab/bench-supply@1.0.0" },
                      },
                      wires: [["asm.inner.5V", "bench.5V"]],
                      expose: {},
                    },
                  },
                },
              },
            },
            body: noneAxis("none"),
            visual: noneAxis("none"),
          },
        },
      },
    });
    const planned = planWorld(dir, "nested-wire.world.json");
    if (!planned.ok) {
      throw new Error(planned.errors.map((item) => item.message).join("; "));
    }
    expect(
      sameNet(planned.plan.wires, "asm.inner.5V", "bench.5V"),
      `asm.inner.5V is not on bench.5V: ${planned.plan.wires
        .map((wire) => wire.join(" "))
        .join("; ")}`
    );
    console.log("nested wire: asm.inner.5V reaches bench.5V");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = mkdtempSync(join(tmpdir(), "sfab-unknown-chip-"));
  try {
    writeJson(join(dir, "chip.world.json"), {
      version: 2,
      environment: { ground: { plane: true }, gravity: [0, 0, -9.81] },
      run: { seed: 1, levels: { default: 1 } },
      root: {
        id: "scene",
        part: {
          format: "sfab.part@1",
          id: "sfab/chip-scene@1.0.0",
          type: "assembly",
          axes: {
            behaviour: {
              "2": {
                default: "netlist",
                variants: {
                  netlist: {
                    kind: "composite",
                    omits: ["test scene"],
                    netlist: {
                      instances: {
                        board: {
                          part: "sfab/odd-chip@1.0.0",
                          params: { firmware: "missing.hex" },
                        },
                      },
                      wires: [],
                      expose: {},
                    },
                  },
                },
              },
            },
            body: noneAxis("none"),
            visual: noneAxis("none"),
          },
        },
      },
    });
    writeJson(join(dir, "parts", "sfab", "odd-chip@1.0.0.json"), {
      format: "sfab.part@1",
      id: "sfab/odd-chip@1.0.0",
      type: "arduino-nano",
      axes: {
        behaviour: {
          "1": {
            default: "avr",
            variants: {
              avr: {
                kind: "firmware",
                chip: "no-such",
                imageParam: "firmware",
                resetPort: "RESET",
                omits: ["test"],
                params: { quiescent: 0.01 },
              },
            },
          },
        },
        body: noneAxis("none"),
        visual: noneAxis("none"),
      },
    });
    writeFileSync(join(dir, "missing.hex"), ":00000001FF\n");
    const planned = planWorld(dir, "chip.world.json");
    expect(planned.ok, "unknown chip did not run");
    if (!planned.ok) throw new Error("unreachable");
    const chip = (planned.plan.degraded ?? []).find((item) =>
      item.message.includes('unknown chip "no-such"')
    );
    expect(chip, "no unknown-chip diagnostic");
    console.log(`degraded ${chip.path}: ${chip.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = mkdtempSync(join(tmpdir(), "sfab-boardless-"));
  try {
    writeJson(join(dir, "led.world.json"), {
      version: 2,
      environment: { ground: { plane: true }, gravity: [0, 0, -9.81] },
      run: { seed: 1, levels: { default: 2 } },
      root: {
        id: "scene",
        part: {
          format: "sfab.part@1",
          id: "sfab/led-scene@1.0.0",
          type: "assembly",
          axes: {
            behaviour: {
              "2": {
                default: "netlist",
                variants: {
                  netlist: {
                    kind: "composite",
                    omits: ["test scene"],
                    netlist: {
                      instances: {
                        bench: {
                          part: "sfab/bench-supply@1.0.0",
                          params: { V: 5, Rs: 0.05, Ilimit: 1 },
                        },
                        r: {
                          part: "sfab/resistor@1.0.0",
                          params: { R: 220 },
                        },
                        led: { part: "sfab/led-red@1.0.0" },
                      },
                      wires: [
                        ["bench.5V", "r.A"],
                        ["r.B", "led.A"],
                        ["led.K", "bench.GND"],
                      ],
                      expose: {},
                    },
                  },
                },
              },
            },
            body: noneAxis("none"),
            visual: noneAxis("none"),
          },
        },
      },
    });
    const planned = planWorld(dir, "led.world.json");
    if (!planned.ok) {
      throw new Error(planned.errors.map((item) => item.message).join("; "));
    }
    expect(planned.plan.boards.length === 0, "a board was planned");
    const stamp = planned.plan.supplies.find(
      (item) => item.id === "bench"
    )?.stamp;
    expect(stamp, "bench has no stamp");
    const anode = stamp.parts.find((part) => part.path === "led")?.nodes.A;
    expect(anode, "led anode has no node");
    const opts = {
      method: "be" as const,
      h: 0.001,
      atol: 1e-14,
      rtol: 1e-12,
    };
    const realized = realize(stamp, "header", AVR_PIN, { pins: false });
    const plannedEngine = new Engine(
      [
        new TheveninLimit("src", realized.feedNode, "0", 5, 0.05, 1),
        new CurrentLoad("load", realized.boardNode, "0", 0),
        ...realized.elements,
      ],
      opts
    );
    const hand = new Engine(
      [
        new TheveninLimit("src", "vp", "0", 5, 0.05, 1),
        new CurrentLoad("load", "vp", "0", 0),
        new Resistor("r", "vp", "mid", 220),
        new Diode("led", "mid", "0", LED_RED),
      ],
      opts
    );
    plannedEngine.operatingPoint();
    hand.operatingPoint();
    const iPlan = -plannedEngine.branchCurrent("src");
    const iHand = -hand.branchCurrent("src");
    const vPlan = plannedEngine.voltage(anode);
    const vHand = hand.voltage("mid");
    const dI = Math.abs(iPlan - iHand);
    const dV = Math.abs(vPlan - vHand);
    expect(dI <= 1e-12, `board-less current Δ ${dI} A`);
    expect(dV <= 1e-12, `board-less anode Δ ${dV} V`);
    console.log(
      `board-less rail: ${(iPlan * 1000).toFixed(4)} mA, anode ${vPlan.toFixed(6)} V, ΔI ${dI.toExponential(2)} A, ΔV ${dV.toExponential(2)} V`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = mkdtempSync(join(tmpdir(), "sfab-open-r-"));
  try {
    writeJson(join(dir, "open.world.json"), {
      version: 2,
      environment: { ground: { plane: true }, gravity: [0, 0, -9.81] },
      run: { seed: 1, levels: { default: 2 } },
      root: {
        id: "scene",
        part: {
          format: "sfab.part@1",
          id: "sfab/open-scene@1.0.0",
          type: "assembly",
          axes: {
            behaviour: {
              "2": {
                default: "netlist",
                variants: {
                  netlist: {
                    kind: "composite",
                    omits: ["test scene"],
                    netlist: {
                      instances: {
                        r: {
                          part: "sfab/resistor@1.0.0",
                          params: { R: 1000 },
                        },
                      },
                      wires: [],
                      expose: {},
                    },
                  },
                },
              },
            },
            body: noneAxis("none"),
            visual: noneAxis("none"),
          },
        },
      },
    });
    const planned = planWorld(dir, "open.world.json");
    expect(planned.ok, "an unwired resistor did not run");
    if (!planned.ok) throw new Error("unreachable");
    const named = (planned.plan.degraded ?? []).find((item) =>
      item.message.includes("r reaches no supply")
    );
    expect(named, "no open-resistor diagnostic");
    console.log(`degraded ${named.path}: ${named.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = mkdtempSync(join(tmpdir(), "sfab-two-nano-"));
  try {
    copyVcc(dir);
    writeJson(
      join(dir, "pair.world.json"),
      sceneWorld(
        {
          bench: { part: "sfab/bench-supply@1.0.0" },
          left: { part: "sfab/nano-ch340@1.0.0", params: nanoParams },
          right: { part: "sfab/nano-ch340@1.0.0", params: nanoParams },
        },
        [
          ["bench.5V", "left.5V"],
          ["bench.GND", "left.GND"],
          ["bench.5V", "right.5V"],
          ["bench.GND", "right.GND"],
        ]
      )
    );
    const planned = planWorld(dir, "pair.world.json");
    expect(planned.ok, "two class-2 boards planned");
    if (!planned.ok) throw new Error("unreachable");
    const left = planned.plan.boards.find((board) => board.id === "left");
    const right = planned.plan.boards.find((board) => board.id === "right");
    expect(left?.stamp && right?.stamp, "both class-2 boards stamped");
    console.log("two class-2 boards: left and right share bench");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = mkdtempSync(join(tmpdir(), "sfab-nano-uno-"));
  try {
    copyVcc(dir);
    writeJson(
      join(dir, "pair.world.json"),
      sceneWorld(
        {
          bench: { part: "sfab/bench-supply@1.0.0" },
          nano: { part: "sfab/nano-ch340@1.0.0", params: nanoParams },
          uno: { part: "sfab/uno-r3@1.0.0", params: nanoParams },
        },
        [
          ["bench.5V", "nano.5V"],
          ["bench.GND", "nano.GND"],
          ["bench.5V", "uno.5V"],
          ["bench.GND", "uno.GND"],
        ],
        { default: 2, paths: { uno: { behaviour: 1 } } }
      )
    );
    const planned = planWorld(dir, "pair.world.json");
    expect(planned.ok, "nano and uno planned");
    if (!planned.ok) throw new Error("unreachable");
    const nano = planned.plan.boards.find((board) => board.id === "nano");
    const uno = planned.plan.boards.find((board) => board.id === "uno");
    const bench = planned.plan.supplies.find((item) => item.id === "bench");
    expect(nano?.stamp && uno?.stamp && bench, "nano and uno stamps");
    if (!nano?.stamp || !uno?.stamp || !bench) throw new Error("unreachable");
    const rail = createRailCircuit({
      vNom: bench.voltage,
      rSeries: bench.rSeries,
      iLimit: bench.currentLimit,
      motors: [],
      boards: [
        { id: "nano", stamp: nano.stamp, feed: "header", pin: nano.pin },
        { id: "uno", stamp: uno.stamp, feed: "header", pin: uno.pin },
      ],
    });
    rail.setBoardLoad("nano", nano.current);
    rail.setBoardLoad("uno", uno.current);
    rail.solve();
    const nanoV = rail.boardReading("nano").voltage;
    const unoV = rail.boardReading("uno").voltage;
    console.log(
      `nano class 2 and uno: nano ${nanoV.toFixed(4)} V, uno ${unoV.toFixed(4)} V, supply ${rail.current.toFixed(4)} A`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = mkdtempSync(join(tmpdir(), "sfab-two-class1-"));
  try {
    copyVcc(dir);
    writeJson(
      join(dir, "pair.world.json"),
      sceneWorld(
        {
          usb: { part: "sfab/usb-port-500ma@1.0.0" },
          left: { part: "sfab/nano-ch340@1.0.0", params: nanoParams },
          right: { part: "sfab/nano-ch340@1.0.0", params: nanoParams },
        },
        [
          ["usb.5V", "left.5V"],
          ["usb.GND", "left.GND"],
          ["usb.5V", "right.5V"],
          ["usb.GND", "right.GND"],
        ],
        { default: 1 }
      )
    );
    const planned = planWorld(dir, "pair.world.json");
    expect(planned.ok, "two class-1 boards planned");
    if (!planned.ok) throw new Error("unreachable");
    const left = planned.plan.boards.find((board) => board.id === "left");
    const right = planned.plan.boards.find((board) => board.id === "right");
    const supply = planned.plan.supplies.find((item) => item.id === "usb");
    expect(left?.stamp && right?.stamp && supply, "both class-1 stamps");
    if (!left?.stamp || !right?.stamp || !supply)
      throw new Error("unreachable");
    const rail = createRailCircuit({
      vNom: supply.voltage,
      rSeries: supply.rSeries,
      iLimit: supply.currentLimit,
      motors: [],
      boards: [
        { id: "left", stamp: left.stamp, feed: "usb", pin: left.pin },
        { id: "right", stamp: right.stamp, feed: "usb", pin: right.pin },
      ],
    });
    rail.setBoardLoad("left", left.current);
    rail.setBoardLoad("right", right.current);
    rail.solve();
    const hand = tiedPair(left.stamp, right.stamp, left.current, right.current);
    const dLeft = Math.abs(rail.boardReading("left").voltage - hand.left);
    const dRight = Math.abs(rail.boardReading("right").voltage - hand.right);
    expect(dLeft <= 1e-12, `left ${dLeft} V`);
    expect(dRight <= 1e-12, `right ${dRight} V`);
    console.log(
      `two class-1 nanos: shared rail vs one circuit |Δ| ${Math.max(dLeft, dRight).toExponential(2)} V`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = mkdtempSync(join(tmpdir(), "sfab-loose-"));
  try {
    copyVcc(dir);
    writeJson(
      join(dir, "loose.world.json"),
      sceneWorld(
        {
          bench: { part: "sfab/bench-supply@1.0.0" },
          nano: { part: "sfab/nano-ch340@1.0.0", params: nanoParams },
          r: { part: "sfab/resistor@1.0.0", params: { R: 1000 } },
        },
        [
          ["bench.5V", "nano.5V"],
          ["bench.GND", "r.A"],
        ]
      )
    );
    const planned = planWorld(dir, "loose.world.json");
    if (!planned.ok) {
      throw new Error(planned.errors.map((item) => item.message).join("; "));
    }
    const stamp = planned.plan.boards.find(
      (board) => board.id === "nano"
    )?.stamp;
    expect(stamp, "nano has no stamp");
    expect(
      stamp.parts.some((part) => part.path === "r"),
      "r was not stamped on nano"
    );
    expect(
      planned.plan.supplies.every((supply) => !supply.stamp),
      "the loose part was stamped on the supply"
    );
    console.log("loose part: r is on nano");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
