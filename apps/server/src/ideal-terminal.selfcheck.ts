/**
 * Nano behaviour `ideal-terminal` is a firmware level with no chip child,
 * so the part is its own board. The header is still D0–D13, A0–A5: blink
 * drives D13, and a scene wire on D9 still stamps a pin.
 *
 * Copies `examples/nano`. Nothing under the catalog or the examples is written.
 */

import { ok as expect } from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { pinBitSet, pinIndex } from "@sfab-bench/contract";

import { closeRootWatches } from "./projects";
import { headlessSim } from "./run";
import { planWorld } from "./world/plan";

const nanoDir = fileURLToPath(
  new URL("../../../examples/nano/", import.meta.url)
);

const HEADER = [
  "D0",
  "D1",
  "D2",
  "D3",
  "D4",
  "D5",
  "D6",
  "D7",
  "D8",
  "D9",
  "D10",
  "D11",
  "D12",
  "D13",
  "A0",
  "A1",
  "A2",
  "A3",
  "A4",
  "A5",
];

type Doc = {
  play?: { levels?: { paths?: Record<string, unknown> } };
  axes?: {
    behaviour?: {
      "2"?: {
        variants?: {
          netlist?: {
            netlist?: {
              instances?: {
                nano?: { params?: { firmware?: string; source?: string } };
              };
            };
          };
        };
      };
    };
  };
};

const root = mkdtempSync(join(tmpdir(), "sfab-ideal-terminal-"));
try {
  cpSync(nanoDir, root, { recursive: true });
  const scenePath = join(root, "parts", "sfab", "nano-led-scene@1.0.0.json");
  const scene = JSON.parse(readFileSync(scenePath, "utf8")) as Doc;
  const params =
    scene.axes?.behaviour?.["2"]?.variants?.netlist?.netlist?.instances?.nano
      ?.params;
  if (!params) throw new Error("nano-led scene has no nano params");
  params.firmware = "firmware/blink/blink.hex";
  params.source = "firmware/blink/blink.ino";
  writeFileSync(scenePath, JSON.stringify(scene));

  const worldPath = join(root, "parts", "sfab", "nano-led@1.0.0.json");
  const world = JSON.parse(readFileSync(worldPath, "utf8")) as Doc;
  const levels = world.play?.levels;
  if (!levels) throw new Error("nano-led has no play.levels");
  levels.paths = {
    nano: { behaviour: { class: 1, variant: "ideal-terminal" } },
  };
  writeFileSync(worldPath, JSON.stringify(world));

  const worldRel = "parts/sfab/nano-led@1.0.0.json";
  const planned = planWorld(root, worldRel);
  if (!planned.ok) {
    throw new Error(planned.errors.map((item) => item.message).join("; "));
  }
  const board = planned.plan.boards.find((item) => item.id === "nano");
  expect(board, "ideal-terminal plans a nano board");
  expect(
    board.pinOrder.join(",") === HEADER.join(","),
    `ideal-terminal pins ${board.pinOrder.join(",") || "(none)"}`
  );
  expect(
    board.wire.join(",") ===
      [
        "PD0",
        "PD1",
        "PD2",
        "PD3",
        "PD4",
        "PD5",
        "PD6",
        "PD7",
        "PB0",
        "PB1",
        "PB2",
        "PB3",
        "PB4",
        "PB5",
        "PC0",
        "PC1",
        "PC2",
        "PC3",
        "PC4",
        "PC5",
      ].join(","),
    `ideal-terminal wire ${board.wire.join(",") || "(none)"}`
  );
  const d9 = board.stamp?.pins.find((pin) => pin.port === "D9");
  expect(d9, "ideal-terminal stamp has no D9 pin");

  const bit = pinIndex(board.pinOrder, "D13");
  expect(bit === 13, `D13 index ${bit}`);
  const sim = headlessSim();
  try {
    const loaded = await sim.load({
      project: root,
      world: worldRel,
      generation: 1,
    });
    expect(loaded.ok, "ideal-terminal world loads");
    const sample = async (ms: number) => {
      await sim.step(ms);
      const pins = sim.state()?.boards.nano?.pins;
      expect(pins, "nano pins are on the state");
      return {
        ddr: pinBitSet(pins.ddr, bit ?? -1),
        level: pinBitSet(pins.level, bit ?? -1),
      };
    };
    const high = await sample(100);
    expect(
      high.ddr && high.level,
      `D13 at 100 ms ddr ${high.ddr} level ${high.level}`
    );
    const low = await sample(200);
    expect(
      low.ddr && !low.level,
      `D13 at 300 ms ddr ${low.ddr} level ${low.level}`
    );
    const again = await sample(150);
    expect(
      again.ddr && again.level,
      `D13 at 450 ms ddr ${again.ddr} level ${again.level}`
    );
  } finally {
    sim.dispose();
  }
  console.log(
    "ideal-terminal: D0–A5, blink D13 high then low then high, D9 stamped"
  );
} finally {
  closeRootWatches();
  rmSync(root, { recursive: true, force: true });
}
