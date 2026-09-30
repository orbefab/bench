/**
 * A firmware chip that is a netlist child runs as its parent's board; a
 * firmware part that is not a child is its own board.
 *
 * A test board (a composite of the catalog chip) and the bare chip each sit in
 * a scene. The composite's board id, type, pins and serial route are the
 * composite's, and the chip child is not a second board. The bare chip is its
 * own board. A composite that forwards `firmware` optionally and gets none
 * leaves the same "no firmware image" diagnostic a single-part board did, on
 * the composite's path.
 *
 * Copies only. Nothing under the catalog or the examples is written.
 */

import { ok as expect } from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { closeRootWatches } from "./projects";
import { headlessSim } from "./run";
import { planWorld } from "./world/plan";

const echoDir = fileURLToPath(
  new URL("../fixtures/interaction/firmware/echo/", import.meta.url)
);

const NONE = (omit: string) => ({
  "0": { default: "none", variants: { none: { kind: "none", omits: [omit] } } },
});

function part(id: string, type: string, behaviour: unknown) {
  return {
    format: "sfab.part@1",
    id,
    type,
    foreign: false,
    axes: {
      behaviour,
      body: NONE("test part"),
      visual: NONE("test part"),
    },
  };
}

function composite(id: string, netlist: unknown, cls: "1" | "2" = "2") {
  return part(id, "assembly", {
    [cls]: {
      default: "netlist",
      variants: {
        netlist: { kind: "composite", omits: ["a test world"], netlist },
      },
    },
  });
}

const BOARD_TYPE = {
  format: "sfab.part-type@1",
  id: "test-board",
  plausible: { Voltage: [-1, 25], Current: [-0.5, 0.5] },
  ports: {
    "5V": {
      domain: "electrical",
      role: "power",
      direction: "in",
      ratings: { voltage: [3.78, 5.5], absMaxVoltage: [0, 6] },
    },
    GND: { domain: "electrical", role: "ground", direction: "passive" },
    D9: {
      domain: "electrical",
      role: "logic",
      direction: "inout",
      ratings: { absMaxVoltage: [-0.5, 5.5] },
    },
  },
};

/** The board: the catalog chip as the `mcu` child, header ports exposed onto it. */
const BOARD = part("sfab/test-board@1.0.0", "test-board", {
  "1": {
    default: "netlist",
    variants: {
      netlist: {
        kind: "composite",
        omits: ["a test board"],
        netlist: {
          instances: {
            mcu: {
              part: "sfab/atmega328p@1.0.0",
              params: {
                firmware: { $param: "firmware", optional: true },
              },
            },
          },
          wires: [["mcu.VCC", "mcu.AVCC"]],
          expose: {
            "5V": "mcu.VCC",
            GND: "mcu.GND",
            D9: "mcu.PB1",
          },
        },
      },
    },
  },
});

function scene(name: string, boardPart: string, params: object, power: string) {
  const instances = {
    board: { part: boardPart, params },
    usb: { part: "sfab/usb-port-500ma@1.0.0" },
  };
  const wires = [
    ["usb.5V", `board.${power}`],
    ["usb.GND", "board.GND"],
  ];
  return [
    composite(
      `sfab/${name}-scene@1.0.0`,
      { instances, wires, expose: {} },
      "1"
    ),
    composite(`sfab/${name}@1.0.0`, {
      instances: {
        scene: { part: `sfab/${name}-scene@1.0.0` },
        ground: { part: "sfab/ground-plane@1.0.0" },
      },
      wires: [],
      expose: {},
    }),
  ];
}

const root = mkdtempSync(join(tmpdir(), "sfab-host-"));
try {
  mkdirSync(join(root, "parts", "sfab"), { recursive: true });
  mkdirSync(join(root, "types"), { recursive: true });
  mkdirSync(join(root, "firmware", "echo"), { recursive: true });
  cpSync(join(echoDir, "echo.hex"), join(root, "firmware", "echo", "echo.hex"));
  writeFileSync(
    join(root, "types", "test-board.json"),
    JSON.stringify(BOARD_TYPE)
  );
  writeFileSync(
    join(root, "parts", "sfab", "test-board@1.0.0.json"),
    JSON.stringify(BOARD)
  );
  const worlds: [string, string, object, string][] = [
    [
      "composite",
      "sfab/test-board@1.0.0",
      { firmware: "firmware/echo/echo.hex" },
      "5V",
    ],
    [
      "bare-chip",
      "sfab/atmega328p@1.0.0",
      { firmware: "firmware/echo/echo.hex" },
      "VCC",
    ],
    ["no-image", "sfab/test-board@1.0.0", {}, "5V"],
  ];
  for (const [name, boardPart, params, power] of worlds) {
    for (const doc of scene(name, boardPart, params, power)) {
      writeFileSync(
        join(root, "parts", "sfab", `${doc.id.slice(5)}.json`),
        JSON.stringify({
          ...doc,
          ...(doc.id === `sfab/${name}@1.0.0`
            ? {
                play: {
                  gravity: [0, 0, -9.81],
                  seed: 1,
                  timestep: 0.001,
                  levels: { default: 1 },
                },
              }
            : {}),
        })
      );
    }
  }
  const world = (name: string) => `parts/sfab/${name}@1.0.0.json`;

  // The chip is a child of the composite, so the board is the composite.
  const planned = planWorld(root, world("composite"));
  if (!planned.ok) {
    throw new Error(planned.errors.map((item) => item.message).join("; "));
  }
  const ids = planned.plan.boards.map((board) => board.id);
  expect(
    ids.length === 1 && ids[0] === "board",
    `composite board ids ${JSON.stringify(ids)}, want ["board"]`
  );
  const board = planned.plan.boards[0];
  expect(board?.type === "test-board", `board type ${board?.type}`);
  expect(
    board?.voltagePin === "5V" && board?.groundPin === "GND",
    "the board's own header ports are its power and ground"
  );
  expect(
    board !== undefined &&
      Object.keys(board.pins).sort().join() === "5V,D9,GND",
    "the board's pins are the composite's ports"
  );
  expect(board?.hasNetlist === true, "a composite board has a netlist");
  expect(board?.resetFraction === 0.9, "facts come from the chip part");
  expect(board?.minOperatingVoltage === 3.78, "the SOA floor is chip data");

  const sim = headlessSim();
  try {
    const loaded = await sim.load({
      project: root,
      world: world("composite"),
      generation: 1,
    });
    expect(loaded.ok, "the composite world loads");
    await sim.step(100);
    sim.serialIn("board", "1");
    await sim.step(50);
    const text = sim
      .drainSerial()
      .filter((chunk) => chunk.board === "board")
      .map((chunk) => chunk.text)
      .join("");
    expect(
      text === "E1",
      `serial through the composite id: ${JSON.stringify(text)}`
    );
    const state = sim.state();
    expect(
      Object.keys(state?.boards ?? {}).join() === "board",
      `state boards ${Object.keys(state?.boards ?? {}).join()}`
    );
    expect(state?.boards.board?.running === true, "the board runs");
  } finally {
    sim.dispose();
  }

  // Not a child: the chip part in a scene is its own board.
  const alone = planWorld(root, world("bare-chip"));
  if (!alone.ok) {
    throw new Error(alone.errors.map((item) => item.message).join("; "));
  }
  expect(
    alone.plan.boards.map((row) => row.id).join() === "board" &&
      alone.plan.boards[0]?.type === "atmega328p",
    "a firmware part that is not a child is its own board"
  );

  // Bare: no image, no board, the single-part board's diagnostic at the composite.
  const bare = planWorld(root, world("no-image"));
  if (!bare.ok) {
    throw new Error(bare.errors.map((item) => item.message).join("; "));
  }
  expect(bare.plan.boards.length === 0, "no image, no board");
  const gap = (bare.plan.degraded ?? []).find(
    (row) => row.message === "the board has no firmware image"
  );
  expect(gap?.path === "board", `no-image diagnostic path ${gap?.path}`);
  expect(
    !(bare.plan.degraded ?? []).some((row) => row.code === "unresolved"),
    "an optional forward reports nothing"
  );
  console.log(
    "board-host: a chip child runs as its parent's board (id, type, pins, serial); a chip that is not a child is its own board; a bare board keeps its diagnostic"
  );
} finally {
  closeRootWatches();
  rmSync(root, { recursive: true, force: true });
}
