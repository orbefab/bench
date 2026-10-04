/**
 * Nano behaviour `ideal-terminal` is a firmware level with no chip child,
 * so the part is its own board. The header is still D0–D13, A0–A5: blink
 * drives D13, and a scene wire on D9 still stamps a pin.
 *
 * The header comes from the level's `pinMapFrom` (layered-sim M3c), not from
 * the chip part's id: a copy of the 328P under another id keeps the same
 * header, chip pins, ADC labels and reset port. A board whose firmware level
 * names no pin map, or one that does not resolve, sits idle with a named
 * row, nested or at the root; it never runs as a bare chip.
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

import { type PartFile, pinBitSet, pinIndex } from "@sfab-bench/contract";

import { closeRootWatches } from "./projects";
import { headlessSim } from "./run";
import { planWorld } from "./world/plan";

const nanoDir = fileURLToPath(
  new URL("../../../examples/nano/", import.meta.url)
);
const catalog = fileURLToPath(new URL("../catalog/", import.meta.url));

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

// The pin map is the reference, not the chip part's id.
const NANO = "sfab/nano-ch340@1.0.0";
const CHIP = "sfab/atmega328p@1.0.0";
type Shadow = Record<string, (part: PartFile) => PartFile>;
type RunBoard = Extract<
  ReturnType<typeof planWorld>,
  { ok: true }
>["plan"]["boards"][number];
const catalogPart = (id: string): PartFile =>
  JSON.parse(readFileSync(join(catalog, "parts", `${id}.json`), "utf8"));
const firmwareLevel = (part: PartFile) => {
  const impl = part.axes?.behaviour?.["1"]?.variants["ideal-terminal"];
  if (impl?.kind !== "firmware") throw new Error("no ideal-terminal level");
  return impl;
};

/**
 * A world with the Nano on `ideal-terminal`, with project shadows of parts:
 * the nano-led scene (the board at `nano`), or a document that unwraps to
 * the Nano (the board at the root, which the loader does not idle).
 */
function terminalPlan(
  shadows: Shadow,
  at: "nested" | "root" = "nested"
): {
  board: RunBoard | undefined;
  rows: string[];
} {
  const dir = mkdtempSync(join(tmpdir(), "sfab-pin-map-"));
  try {
    cpSync(nanoDir, dir, { recursive: true });
    const worldRel =
      at === "root"
        ? "parts/sfab/nano-root@1.0.0.json"
        : "parts/sfab/nano-led@1.0.0.json";
    if (at === "root") {
      writeFileSync(join(dir, worldRel), JSON.stringify(nanoRoot()));
    } else {
      const world = JSON.parse(
        readFileSync(join(dir, worldRel), "utf8")
      ) as Doc;
      if (!world.play?.levels) throw new Error("nano-led has no play.levels");
      world.play.levels.paths = {
        nano: { behaviour: { class: 1, variant: "ideal-terminal" } },
      };
      writeFileSync(join(dir, worldRel), JSON.stringify(world));
      rmSync(join(dir, "parts/sfab/nano-led@1.0.0.lock.json"), {
        force: true,
      });
    }
    for (const [id, edit] of Object.entries(shadows)) {
      const part = edit(catalogPart(id));
      writeFileSync(
        join(dir, "parts", `${part.id}.json`),
        JSON.stringify(part)
      );
    }
    const planned = planWorld(dir, worldRel);
    if (!planned.ok) {
      throw new Error(planned.errors.map((item) => item.message).join("; "));
    }
    const boardId = at === "root" ? "$root" : "nano";
    return {
      board: planned.plan.boards.find((item) => item.id === boardId),
      rows: (planned.plan.degraded ?? [])
        .filter((row) => row.path === boardId || row.path === NANO)
        .map((row) => row.message),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A document whose one instance is the Nano: the run stages it at the root. */
function nanoRoot(): unknown {
  const none = {
    "0": {
      default: "none",
      variants: { none: { kind: "none", omits: ["none"] } },
    },
  };
  return {
    format: "sfab.part@1",
    id: "sfab/nano-root@1.0.0",
    type: "assembly",
    play: {
      gravity: [0, 0, -9.81],
      seed: 1,
      timestep: 0.001,
      levels: {
        default: 1,
        paths: {
          $root: { behaviour: { class: 1, variant: "ideal-terminal" } },
        },
      },
    },
    axes: {
      behaviour: {
        "2": {
          default: "netlist",
          variants: {
            netlist: {
              kind: "composite",
              omits: ["the Nano alone"],
              netlist: {
                instances: {
                  nano: {
                    part: NANO,
                    params: {
                      firmware: "firmware/blink/blink.hex",
                      source: "firmware/blink/blink.ino",
                    },
                  },
                },
                wires: [],
                expose: {},
              },
            },
          },
        },
      },
      body: none,
      visual: none,
    },
  };
}

const pinFacts = (board: RunBoard | undefined) =>
  JSON.stringify({
    pinOrder: board?.pinOrder,
    wire: board?.wire,
    adcLabels: board?.adcLabels,
    resetPort: board?.resetPort,
  });

try {
  const stock = terminalPlan({});
  expect(stock.board, "the stock ideal-terminal plans no nano board");
  expect(
    stock.board.pinOrder.join(",") === HEADER.join(",") &&
      stock.board.adcLabels?.[7] === "A7",
    `stock pin facts ${pinFacts(stock.board)}`
  );

  const COPY = "sfab/controller-copy@1.0.0";
  const copied = terminalPlan({
    [CHIP]: (part) => ({ ...part, id: COPY }),
    [NANO]: (part) => {
      for (const slot of Object.values(part.axes?.behaviour ?? {})) {
        for (const impl of Object.values(slot?.variants ?? {})) {
          if (impl.kind === "composite" && impl.netlist.instances.mcu) {
            impl.netlist.instances.mcu.part = COPY;
          }
        }
      }
      return part;
    },
  });
  expect(
    pinFacts(copied.board) === pinFacts(stock.board),
    `the chip under ${COPY}: ${pinFacts(copied.board)}`
  );

  const refused: [string, (part: PartFile) => void, string][] = [
    [
      "no pinMapFrom",
      (part) => {
        firmwareLevel(part).pinMapFrom = undefined;
      },
      "names no pin map",
    ],
    [
      "a missing variant",
      (part) => {
        const level = firmwareLevel(part);
        if (level.pinMapFrom) level.pinMapFrom.variant = "nope";
      },
      "class 1 variant nope does not exist",
    ],
    [
      "a firmware level",
      (part) => {
        const level = firmwareLevel(part);
        if (level.pinMapFrom) level.pinMapFrom.variant = "ideal-terminal";
      },
      "is firmware, not composite",
    ],
    [
      "a missing instance",
      (part) => {
        const level = firmwareLevel(part);
        if (level.pinMapFrom) level.pinMapFrom.instance = "chip";
      },
      "has no instance chip",
    ],
    [
      "an instance with no exposed port",
      (part) => {
        const level = firmwareLevel(part);
        if (level.pinMapFrom) {
          level.pinMapFrom = {
            class: 2,
            variant: "circuits",
            instance: "cvcc",
          };
        }
      },
      "exposes no port of cvcc",
    ],
    [
      "an instance that runs no chip",
      (part) => {
        const level = firmwareLevel(part);
        if (level.pinMapFrom) level.pinMapFrom.instance = "power";
      },
      "power runs chip none, not atmega328p",
    ],
  ];
  const otherChip: Shadow = {
    [NANO]: (part) => {
      const impl = part.axes?.behaviour?.["1"]?.variants.avr8js;
      if (impl?.kind !== "composite") throw new Error("no avr8js netlist");
      impl.netlist.instances.mcu.part = "sfab/atmega32u4@1.0.0";
      return part;
    },
  };
  const cases: [string, Shadow, string][] = [
    ...refused.map(([label, edit, want]): [string, Shadow, string] => [
      label,
      {
        [NANO]: (part) => {
          edit(part);
          return part;
        },
      },
      want,
    ]),
    ["another chip", otherChip, "mcu runs chip atmega32u4, not atmega328p"],
  ];
  for (const [label, shadows, want] of cases) {
    const got = terminalPlan(shadows);
    expect(
      !got.board && got.rows.some((row) => row.includes(want)),
      `${label}: board ${got.board ? "runs" : "idle"}, rows ${JSON.stringify(got.rows)}`
    );
    console.log(`ideal-terminal: ${label} → idle (${want})`);
  }

  // At the root the loader keeps the part; the planner idles the board on
  // the lint's row, the chip mismatch included.
  const rootStock = terminalPlan({}, "root");
  expect(
    pinFacts(rootStock.board) === pinFacts(stock.board) &&
      rootStock.rows.length === 0,
    `the Nano at the root: ${pinFacts(rootStock.board)} ${JSON.stringify(rootStock.rows)}`
  );
  for (const [label, shadows, want] of cases) {
    const got = terminalPlan(shadows, "root");
    const named = got.rows.some((row) => row.includes(want));
    expect(
      !got.board && named,
      `root ${label}: board ${got.board ? pinFacts(got.board) : "idle"}, rows ${JSON.stringify(got.rows)}`
    );
    console.log(`ideal-terminal: root ${label} → idle (${want})`);
  }
  console.log(
    "ideal-terminal: the 328P under another id keeps D0–A5, PD0–PC5, ADC A0–A7 and RESET"
  );
} finally {
  closeRootWatches();
}

console.log("ideal-terminal.selfcheck ok");
