/**
 * A wire to the Nano's RESET header reaches the chip at class 1 as at class 2:
 * the class 1 board exposes RESET, so the plan names the reset port and the
 * board's stamp carries the reset node the rail reads its margin from.
 */

import { ok as expect } from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { planWorld } from "./world/plan";

const blink = fileURLToPath(
  new URL("../../../examples/nano/firmware/blink/blink.hex", import.meta.url)
);

const none = (label: string) => ({
  "0": {
    default: "none",
    variants: { none: { kind: "none", omits: [label] } },
  },
});

function writeWorld(dir: string, level: 1 | 2): string {
  const doc = {
    version: 2,
    environment: { ground: { plane: true }, gravity: [0, 0, -9.81] },
    run: { seed: 1, levels: { default: level } },
    root: {
      id: "scene",
      part: {
        format: "sfab.part@1",
        id: "sfab/reset-scene@1.0.0",
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
                        params: { firmware: "blink.hex" },
                      },
                      usb: { part: "sfab/usb-port-500ma@1.0.0" },
                    },
                    wires: [
                      ["usb.5V", "nano.5V"],
                      ["usb.GND", "nano.GND"],
                      ["nano.RESET", "nano.GND"],
                    ],
                    expose: {},
                  },
                },
              },
            },
          },
          body: none("none"),
          visual: none("none"),
        },
      },
    },
  };
  const name = `reset-${level}.world.json`;
  writeFileSync(join(dir, name), JSON.stringify(doc));
  return name;
}

const dir = mkdtempSync(join(tmpdir(), "sfab-nano-reset-"));
try {
  copyFileSync(blink, join(dir, "blink.hex"));
  for (const level of [1, 2] as const) {
    const planned = planWorld(dir, writeWorld(dir, level));
    if (!planned.ok) {
      throw new Error(planned.errors.map((item) => item.message).join("; "));
    }
    const board = planned.plan.boards.find((item) => item.id === "nano");
    expect(
      board?.resetPort === "RESET",
      `class ${level} Nano resetPort is ${board?.resetPort}`
    );
    expect(
      board?.stamp?.resetNode,
      `class ${level} Nano stamp has no reset node`
    );
    // The chip part's brownout params are the board's, at both classes.
    expect(
      board?.brownoutVoltage === 2.7 &&
        board.brownoutAssertVoltage === 2.675 &&
        board.brownoutReleaseVoltage === 2.725,
      `class ${level} Nano brownout ${board?.brownoutVoltage}/${board?.brownoutAssertVoltage}/${board?.brownoutReleaseVoltage}`
    );
    console.log(
      `class ${level} Nano: reset port ${board?.resetPort}, reset node ${board?.stamp?.resetNode}`
    );
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("nano-reset-class1.selfcheck ok");
