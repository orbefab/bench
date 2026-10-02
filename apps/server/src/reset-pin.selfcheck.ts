/**
 * An external RESET held below the chip's V_RST keeps the chip in reset
 (ATmega328P datasheet DS40002061, "External Reset"). Releasing it starts
 * the same time-out as a brownout release (`resetHoldS`), then the first
 * instruction.
 *
 * The Nano runs blink at class 1 and class 2. With `nano.RESET` wired to
 * `nano.GND`, D13 never becomes an output, the board reads in reset, and
 * the one reset event names the pin as its cause. Without that wire the
 * same scene boots. The `hold` sketch prints `10` within its first
 * millisecond, so an empty console proves the held chip ran nothing. A
 * reload under a low RESET is still recorded as a reload. When another
 * Nano's D13 lets RESET go, the chip boots with `— external reset —`.
 */

import { ok as expect } from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { pinBitSet, pinIndex } from "@sfab-bench/contract";
import {
  BROWNOUT_RESET,
  EXTERNAL_RESET,
  FIRMWARE_RELOADED,
} from "@sfab-bench/engine-mcu";
import { closeRootWatches } from "./projects";
import { headlessSim } from "./run";
import { planWorld } from "./world/plan";
import { runningBrownout, stepBrownout } from "./world/power";

const LIMITS = { assertV: 2.675, releaseV: 2.725, holdMs: 66 };

// The state machine: a low pin asserts on a healthy rail, holds through
// a healthy rail, and its release waits `holdMs` like a brownout's.
{
  const asserted = stepBrownout(runningBrownout(), 5, 10, LIMITS, true);
  expect(
    asserted.assertReset && asserted.phase === "held",
    "a low RESET asserts on a 5 V rail"
  );
  expect(asserted.cause === "pin", `cause ${asserted.cause}`);
  const sag = stepBrownout(runningBrownout(), 2.6, 10, LIMITS, true);
  expect(sag.cause === "brownout", "a sag is a brownout even with the pin low");
  const still = stepBrownout(asserted, 5, 11, LIMITS, true);
  expect(
    still.phase === "held" && still.releaseAtMs === null,
    "a low RESET stays held"
  );
  const released = stepBrownout(still, 5, 12, LIMITS, false);
  expect(
    released.phase === "delay" && released.releaseAtMs === 12,
    "releasing RESET starts the time-out"
  );
  const again = stepBrownout(released, 5, 40, LIMITS, true);
  expect(
    again.phase === "held" && again.releaseAtMs === null,
    "a low RESET inside the time-out starts it over"
  );
  const early = stepBrownout(released, 5, 77, LIMITS, false);
  expect(early.phase === "delay" && !early.reboot, "65 ms is still held");
  const boot = stepBrownout(released, 5, 78, LIMITS, false);
  expect(boot.phase === "run" && boot.reboot, "66 ms after release boots");
  const steady = stepBrownout(runningBrownout(), 5, 10, LIMITS, false);
  expect(
    !steady.assertReset && steady.cause === null,
    "a high RESET on a 5 V rail stays running"
  );
}

const firmware = (name: string) =>
  fileURLToPath(
    new URL(
      `../../../examples/nano/firmware/${name}/${name}.hex`,
      import.meta.url
    )
  );

const none = (label: string) => ({
  "0": {
    default: "none",
    variants: { none: { kind: "none", omits: [label] } },
  },
});

/**
 * `held` wires `nano.RESET` to GND. `pair` adds a second Nano, `free`, on
 * the same USB supply with its RESET left alone, so the rail carries two
 * reset nodes. `driven` adds a Nano running blink whose D13 drives
 * `nano.RESET`: low for 200 ms, then released for 200 ms.
 */
type Scene = {
  held?: boolean;
  pair?: boolean;
  driven?: boolean;
  image?: string;
};

function writeWorld(dir: string, level: 1 | 2, scene: Scene): string {
  const { held = false, pair = false, driven = false } = scene;
  const image = scene.image ?? "blink.hex";
  const wires = [
    ["usb.5V", "nano.5V"],
    ["usb.GND", "nano.GND"],
  ];
  if (held) wires.push(["nano.RESET", "nano.GND"]);
  const instances: Record<string, unknown> = {
    nano: {
      part: "sfab/nano-ch340@1.0.0",
      params: { firmware: image },
    },
    usb: { part: "sfab/usb-port-500ma@1.0.0" },
  };
  if (pair) {
    instances.free = instances.nano;
    wires.push(["usb.5V", "free.5V"], ["usb.GND", "free.GND"]);
  }
  if (driven) {
    instances.driver = {
      part: "sfab/nano-ch340@1.0.0",
      params: { firmware: "blink.hex" },
    };
    wires.push(
      ["usb.5V", "driver.5V"],
      ["usb.GND", "driver.GND"],
      ["driver.D13", "nano.RESET"]
    );
  }
  const doc = {
    version: 2,
    environment: { ground: { plane: true }, gravity: [0, 0, -9.81] },
    run: { seed: 1, levels: { default: level } },
    root: {
      id: "scene",
      part: {
        format: "sfab.part@1",
        id: "sfab/reset-pin-scene@1.0.0",
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
                    instances,
                    wires,
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
  const shape = driven ? "driven" : held ? "held" : "free";
  const name = `reset-pin-${level}-${shape}${pair ? "-pair" : ""}-${image.replace(".hex", "")}.world.json`;
  writeFileSync(join(dir, name), JSON.stringify(doc));
  return name;
}

async function run(
  dir: string,
  level: 1 | 2,
  scene: Scene & { reload?: boolean; ms?: number }
) {
  const world = writeWorld(dir, level, scene);
  const planned = planWorld(dir, world);
  if (!planned.ok) {
    throw new Error(planned.errors.map((item) => item.message).join("; "));
  }
  const board = planned.plan.boards.find((item) => item.id === "nano");
  const bit = pinIndex(board?.pinOrder ?? [], "D13");
  const sim = headlessSim();
  try {
    const loaded = await sim.load({ project: dir, world, generation: 1 });
    expect(loaded.ok, `class ${level} reset world loads`);
    await sim.step(scene.ms ?? 150);
    if (scene.reload) {
      // A new image while RESET is low stays held as well.
      await sim.accept({ type: "reloadBoard", board: "nano", generation: 1 });
      await sim.step(150);
    }
    const state = sim.state();
    const live = state?.boards.nano;
    expect(live?.pins, `class ${level} nano has no pins`);
    const body = sim.record({ op: "read", from: 0, to: state?.simTime ?? 0 });
    if (body.op !== "read") throw new Error("no recording");
    const resets = body.read.events.filter((event) => event.kind === "reset");
    const reloads = body.read.events.filter(
      (event) => event.kind === "reload" && event.board === "nano"
    );
    const other = state?.boards.free;
    const serial = body.read.events
      .filter((event) => event.kind === "serial" && event.board === "nano")
      .map((event) => (event.kind === "serial" ? event.text : ""))
      .join("");
    return {
      serial,
      other: other?.pins
        ? {
            d13Output: pinBitSet(other.pins.ddr, bit ?? -1),
            inReset: other.brownout === true,
          }
        : null,
      d13Output: pinBitSet(live.pins.ddr, bit ?? -1),
      inReset: live.brownout === true,
      reboots: live.resets ?? 0,
      voltage: live.voltage ?? 0,
      resets,
      reloads,
    };
  } finally {
    sim.dispose();
  }
}

const dir = mkdtempSync(join(tmpdir(), "sfab-reset-pin-"));
try {
  copyFileSync(firmware("blink"), join(dir, "blink.hex"));
  copyFileSync(firmware("hold"), join(dir, "hold.hex"));
  for (const level of [1, 2] as const) {
    const free = await run(dir, level, {});
    expect(free.d13Output, `class ${level}: blink makes D13 an output`);
    expect(!free.inReset, `class ${level}: a free RESET runs`);
    expect(free.resets.length === 0, `class ${level}: no reset event`);

    const held = await run(dir, level, { held: true });
    expect(held.voltage > 4.5, `class ${level}: rail ${held.voltage} V`);
    expect(!held.d13Output, `class ${level}: RESET low keeps D13 an input`);
    expect(held.inReset, `class ${level}: RESET low reads in reset`);
    expect(held.reboots === 0, `class ${level}: a held RESET never reboots`);
    expect(
      held.resets.length === 1 &&
        held.resets[0]?.kind === "reset" &&
        held.resets[0].cause === "pin",
      `class ${level}: reset events ${JSON.stringify(held.resets)}`
    );
    // Not one instruction: the sketch that prints at once prints nothing.
    const quiet = await run(dir, level, { held: true, image: "hold.hex" });
    expect(
      quiet.serial === "" && quiet.inReset,
      `class ${level}: a held chip printed ${JSON.stringify(quiet.serial)}`
    );
    // A reload under a low RESET is still a reload: the event and its
    // marker are recorded, and the new image prints nothing.
    const reloaded = await run(dir, level, {
      held: true,
      image: "hold.hex",
      reload: true,
    });
    expect(
      reloaded.serial === FIRMWARE_RELOADED && reloaded.inReset,
      `class ${level}: a reload under a low RESET printed ${JSON.stringify(reloaded.serial)}`
    );
    expect(
      reloaded.reloads.length === 1,
      `class ${level}: reload events ${reloaded.reloads.length}`
    );
    const talks = await run(dir, level, { image: "hold.hex" });
    expect(
      talks.serial.startsWith("10"),
      `class ${level}: a free chip prints ${JSON.stringify(talks.serial)}`
    );
    // Two boards on one rail: only the grounded RESET holds its chip.
    const pair = await run(dir, level, { held: true, pair: true });
    expect(!pair.d13Output && pair.inReset, `class ${level}: nano held`);
    expect(
      pair.other?.d13Output === true && pair.other.inReset === false,
      `class ${level}: the other Nano on the rail runs ${JSON.stringify(pair.other)}`
    );
    expect(
      pair.resets.length === 1 && pair.resets[0]?.board === "nano",
      `class ${level}: pair resets ${JSON.stringify(pair.resets)}`
    );
    console.log(
      `class ${level} Nano: RESET to GND holds the chip at ${held.voltage.toFixed(2)} V; free RESET boots`
    );
    // Another Nano's D13 on RESET. Class 1 stamps no pins on a shared
    // rail, so that net has no voltage: the chip runs. At class 2, D13
    // low holds it, and once D13 lets go it boots holdMs later with a
    // console line that names the external reset, not a brownout.
    const driven = await run(dir, level, {
      driven: true,
      image: "hold.hex",
      ms: 1000,
    });
    if (level === 1) {
      expect(
        driven.resets.length === 0 && driven.serial.startsWith("10"),
        `class 1: an unsolved RESET net runs ${JSON.stringify(driven)}`
      );
      continue;
    }
    expect(
      driven.reboots >= 1 &&
        driven.resets.some(
          (event) =>
            event.kind === "reset" &&
            event.board === "nano" &&
            event.cause === "pin"
        ),
      `class ${level}: driven RESET reboots ${driven.reboots}, resets ${JSON.stringify(driven.resets)}`
    );
    expect(
      driven.serial.includes(EXTERNAL_RESET) &&
        !driven.serial.includes(BROWNOUT_RESET),
      `class ${level}: driven RESET console ${JSON.stringify(driven.serial)}`
    );
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

closeRootWatches();
console.log("reset-pin.selfcheck ok");
