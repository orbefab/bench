/**
 * A firmware variant that still carries `board` or `boardCircuit` is a lint
 * error on that part, naming the field: the board is a composite now.
 */

import { ok as expect } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { planWorld } from "./world/plan";

const none = (label: string) => ({
  "0": {
    default: "none",
    variants: { none: { kind: "none", omits: [label] } },
  },
});

function writeJson(file: string, doc: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(doc));
}

const dir = mkdtempSync(join(tmpdir(), "sfab-retired-board-"));
try {
  writeJson(join(dir, "old.world.json"), {
    version: 2,
    environment: { ground: { plane: true }, gravity: [0, 0, -9.81] },
    run: { seed: 1, levels: { default: 1 } },
    root: {
      id: "scene",
      part: {
        format: "sfab.part@1",
        id: "sfab/old-scene@1.0.0",
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
                    instances: { old: { part: "sfab/old-board@1.0.0" } },
                    wires: [],
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
  });
  writeJson(join(dir, "parts", "sfab", "old-board@1.0.0.json"), {
    format: "sfab.part@1",
    id: "sfab/old-board@1.0.0",
    type: "arduino-nano",
    axes: {
      behaviour: {
        "1": {
          default: "avr",
          variants: {
            avr: {
              kind: "firmware",
              chip: "atmega328p",
              imageParam: "firmware",
              resetPort: "RESET",
              railVoltage: 5,
              resetFraction: 0.9,
              boardCircuit: "path:uno-usb",
              board: { instances: {}, wires: [], expose: {} },
              omits: ["test"],
            },
          },
        },
      },
      body: none("none"),
      visual: none("none"),
    },
  });
  const planned = planWorld(dir, "old.world.json");
  const messages = planned.ok
    ? (planned.plan.degraded ?? []).map((row) => row.message)
    : planned.errors.map((row) => row.message);
  const hit = messages.find((text) =>
    text.includes("firmware variant field board, boardCircuit is retired")
  );
  expect(hit, `no diagnostic for the old fields: ${messages.join("; ")}`);
  expect(hit.includes("composite"), "the diagnostic names the composite");
  console.log(`retired fields: ${hit}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("retired-board.selfcheck ok");
