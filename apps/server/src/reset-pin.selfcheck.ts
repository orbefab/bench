/**
 * An external RESET held below the chip's V_RST keeps the chip in reset
 * (Atmel DS40002061 §11.2.3, External Reset). Releasing it starts the same
 * time-out as a brownout release (`resetHoldS`), then the first instruction.
 *
 * The Nano runs blink at class 1 and class 2. With `nano.RESET` wired to
 * `nano.GND`, D13 never becomes an output, the board reads in reset, and
 * the one reset event names the pin as its cause. Without that wire the
 * same scene boots.
 */

import { ok as expect } from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { pinBitSet, pinIndex } from "@sfab-bench/contract";
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

const blink = fileURLToPath(
  new URL("../../../examples/nano/firmware/blink/blink.hex", import.meta.url)
);

const none = (label: string) => ({
  "0": {
    default: "none",
    variants: { none: { kind: "none", omits: [label] } },
  },
});

function writeWorld(dir: string, level: 1 | 2, held: boolean): string {
  const wires = [
    ["usb.5V", "nano.5V"],
    ["usb.GND", "nano.GND"],
  ];
  if (held) wires.push(["nano.RESET", "nano.GND"]);
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
                    instances: {
                      nano: {
                        part: "sfab/nano-ch340@1.0.0",
                        params: { firmware: "blink.hex" },
                      },
                      usb: { part: "sfab/usb-port-500ma@1.0.0" },
                    },
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
  const name = `reset-pin-${level}-${held ? "held" : "free"}.world.json`;
  writeFileSync(join(dir, name), JSON.stringify(doc));
  return name;
}

async function run(dir: string, level: 1 | 2, held: boolean) {
  const world = writeWorld(dir, level, held);
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
    await sim.step(150);
    const state = sim.state();
    const live = state?.boards.nano;
    expect(live?.pins, `class ${level} nano has no pins`);
    const body = sim.record({ op: "read", from: 0, to: state?.simTime ?? 0 });
    if (body.op !== "read") throw new Error("no recording");
    const resets = body.read.events.filter((event) => event.kind === "reset");
    return {
      d13Output: pinBitSet(live.pins.ddr, bit ?? -1),
      inReset: live.brownout === true,
      reboots: live.resets ?? 0,
      voltage: live.voltage ?? 0,
      resets,
    };
  } finally {
    sim.dispose();
  }
}

const dir = mkdtempSync(join(tmpdir(), "sfab-reset-pin-"));
try {
  copyFileSync(blink, join(dir, "blink.hex"));
  for (const level of [1, 2] as const) {
    const free = await run(dir, level, false);
    expect(free.d13Output, `class ${level}: blink makes D13 an output`);
    expect(!free.inReset, `class ${level}: a free RESET runs`);
    expect(free.resets.length === 0, `class ${level}: no reset event`);

    const held = await run(dir, level, true);
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
    console.log(
      `class ${level} Nano: RESET to GND holds the chip at ${held.voltage.toFixed(2)} V; free RESET boots`
    );
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

closeRootWatches();
console.log("reset-pin.selfcheck ok");
