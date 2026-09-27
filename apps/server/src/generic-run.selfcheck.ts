/**
 * The run dispatches leaves, at any depth. A composite is a shell.
 * A wire names the instance path, then the port.
 */

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

import { boardStampOf } from "./world/circuit-stamp";
import { catalogRoot, planWorld } from "./world/plan";
import { NANO_BOARD_A } from "./world/power-path";
import { createRailCircuit, type RailCircuit } from "./world/rail-circuit";

const law = { k: 0.458, resistance: 7.1, quiescent: 0.01 };
const usb = { voltage: 5, rSeries: 0.5, currentLimit: 0.9 };
const SETTLE = 80;
const nanoExample = fileURLToPath(
  new URL("../../../examples/nano/", import.meta.url)
);

function expect(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(label);
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
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
    const real = boardStampOf("sfab/nano-ch340@1.0.0", "circuits", {
      boardId: "nano",
    });
    const rest = Math.abs(nodeAt(stamp, 0, false) - nodeAt(real, 0, false));
    const stall = Math.abs(nodeAt(stamp, 1, true) - nodeAt(real, 1, true));
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
    expect(!planned.ok, "sg90 class 2 planned");
    const messages = planned.errors.map((item) => item.message);
    const motor = messages.find((item) => item.includes("servo.motor"));
    expect(motor, `no servo.motor error: ${messages.join("; ")}`);
    expect(motor.includes("no runtime for a declared-only part"), motor);
    expect(
      messages.every((item) => !item.includes("nested instance")),
      messages.join("; ")
    );
    console.log(
      "sg90 class 2: servo.motor no runtime for a declared-only part"
    );
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
    expect(!planned.ok, "unknown chip planned");
    const messages = planned.errors.map((item) => item.message).join("; ");
    expect(messages.includes('unknown chip "no-such"'), messages);
    console.log('unknown chip: unknown chip "no-such"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
