/**
 * Interaction golden. `board-replay.selfcheck.ts` only watches a passive run.
 * This one drives a board the way a user does, and pins what the sim computed:
 *
 * - `echo`: serial in, then the echo and the D13 pin, `reloadBoard`, serial in
 *   again;
 * - `brown`: a supply that cannot carry the servo, so the board browns out and
 *   reboots, with serial in and `reloadBoard` on the way;
 * - `swap`: the firmware changes through a `set-param` on the board instance,
 *   the document reloads, and serial in reaches the new image.
 *
 * Each run is a trace in `fixtures/traces/interact/` (see `trace.ts`): the
 * recorded frames as channels, the events, the serial text, the state at each
 * checkpoint, and the warnings. A world whose firmware swap reloads the
 * document records twice, so it has a second trace for the first recording,
 * `<world>.before-swap`. Board ids and diagnostic paths are kept: they must
 * not change when a board becomes a composite.
 *
 * Worlds are written into a temporary copy of `examples/nano`. `--write`
 * rewrites the traces; do it only for a change that is meant to move behaviour.
 */

import { ok as expect } from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { EditOp } from "@sfab-bench/contract";
import { EditSession } from "@sfab-bench/parts";

import { recordingTrace, stateSample } from "./board-trace";
import { closeRootWatches } from "./projects";
import { headlessSim } from "./run";
import { checkTraceDir, type Discrete, type Trace } from "./trace";
import { absolutePath, nodeStore } from "./world/node-store";
import { catalogRoot } from "./world/plan";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const traceDir = here("../fixtures/traces/interact/");
const nanoDir = here("../../../examples/nano/");
const armDir = here("../../../examples/arm/");
const echoDir = here("../fixtures/interaction/firmware/echo/");
const write = process.argv.includes("--write");

type Kind = {
  key: "uno" | "nano";
  part: string;
  type: string;
  /** The supply an echo or swap world runs on. */
  usb: boolean;
};
const KINDS: Kind[] = [
  { key: "uno", part: "sfab/uno-r3@1.0.0", type: "arduino-uno-r3", usb: false },
  {
    key: "nano",
    part: "sfab/nano-ch340@1.0.0",
    type: "arduino-nano",
    usb: true,
  },
];

type Script = "echo" | "brown" | "swap";
type World = { name: string; kind: Kind; script: Script; class: 1 | 2 };
const WORLDS: World[] = KINDS.flatMap((kind) =>
  (["echo", "brown", "swap"] as const).flatMap((script) =>
    ([1, 2] as const).map((cls) => ({
      name: `${kind.key}-${script}-c${cls}`,
      kind,
      script,
      class: cls,
    }))
  )
);

const NONE = (omit: string) => ({
  "0": {
    default: "none",
    variants: { none: { kind: "none", omits: [omit] } },
  },
});

function firmwareOf(world: World): string {
  if (world.script === "echo") return "firmware/echo/echo.hex";
  if (world.script === "brown") return "firmware/stall/stall.hex";
  return "firmware/hold/hold.hex";
}

function writeWorld(root: string, world: World) {
  const { key, part } = world.kind;
  const servo = world.script === "brown";
  // A weak bench supply is what browns the board out under the servo.
  const supply =
    world.kind.usb && !servo
      ? { part: "sfab/usb-port-500ma@1.0.0" }
      : {
          part: "sfab/bench-supply@1.0.0",
          params: { V: 5, Ilimit: servo ? 0.3 : 1 },
        };
  const supplyId = "supply";
  const instances: Record<string, unknown> = {
    [key]: {
      part,
      pose: { position: [0.08, 0, 0.004], rotation: [1, 0, 0, 0] },
      params: { firmware: firmwareOf(world) },
    },
    [supplyId]: supply,
  };
  const wires = [
    [`${supplyId}.5V`, `${key}.5V`],
    [`${supplyId}.GND`, `${key}.GND`],
  ];
  if (servo) {
    instances.flag = {
      part: "sfab/flag@1.0.0",
      pose: { position: [0, 0, 0], rotation: [1, 0, 0, 0] },
    };
    instances.servo = { part: "sfab/sg90@1.0.0" };
    wires.push(
      [`${key}.D9`, "servo.signal"],
      [`${key}.5V`, "servo.V+"],
      [`${key}.GND`, "servo.GND"],
      ["servo.shaft", "flag.hinge"],
      ["servo.mount", "flag.base"]
    );
  }
  const composite = (id: string, netlist: unknown, play?: unknown) => ({
    format: "sfab.part@1",
    id,
    type: "assembly",
    foreign: false,
    ...(play ? { play } : {}),
    axes: {
      behaviour: {
        "2": {
          default: "netlist",
          variants: {
            netlist: { kind: "composite", omits: ["a test world"], netlist },
          },
        },
      },
      body: NONE("assembly adds no body"),
      visual: NONE("assembly adds no visual"),
    },
  });
  const sceneId = `sfab/${world.name}-scene@1.0.0`;
  const levels: Record<string, unknown> = { default: 1 };
  if (world.class === 2) {
    levels.types = { [world.kind.type]: { behaviour: 2 } };
  }
  const dir = join(root, "parts", "sfab");
  writeFileSync(
    join(dir, `${world.name}-scene@1.0.0.json`),
    `${JSON.stringify(composite(sceneId, { instances, wires, expose: {} }), null, 2)}\n`
  );
  writeFileSync(
    join(dir, `${world.name}@1.0.0.json`),
    `${JSON.stringify(
      composite(
        `sfab/${world.name}@1.0.0`,
        {
          instances: {
            scene: { part: sceneId },
            ground: { part: "sfab/ground-plane@1.0.0" },
          },
          wires: [],
          expose: {},
        },
        { gravity: [0, 0, -9.81], seed: 1, timestep: 0.001, levels }
      ),
      null,
      2
    )}\n`
  );
}

function setFirmware(root: string, world: World, image: string) {
  const file = absolutePath(
    join(root, "parts", "sfab", `${world.name}-scene@1.0.0.json`)
  );
  const opened = EditSession.open({
    file,
    names: [`parts/sfab/${world.name}-scene@1.0.0.json`, file],
    store: nodeStore,
    catalogDir: absolutePath(catalogRoot()),
    assetRoot: absolutePath(root),
  });
  if ("error" in opened) throw new Error(opened.error);
  const applied = opened.apply({
    kind: "set-param",
    document: `parts/sfab/${world.name}-scene@1.0.0.json`,
    id: world.kind.key,
    name: "firmware",
    value: image,
  } as EditOp);
  if ("error" in applied) throw new Error(applied.error);
}

/** One trace per recording: `<world>`, and `<world>.before-swap` for a swap. */
async function play(root: string, world: World): Promise<Map<string, Trace>> {
  const sim = headlessSim();
  const traces = new Map<string, Trace>();
  let serial: Record<string, string> = {};
  let samples: Record<string, Record<string, Discrete>> = {};
  const id = world.kind.key;
  const target = {
    project: root,
    world: `parts/sfab/${world.name}@1.0.0.json`,
  };

  const checkpoint = (label: string) => {
    for (const chunk of sim.drainSerial()) {
      serial[chunk.board] = (serial[chunk.board] ?? "") + chunk.text;
    }
    const state = sim.state();
    if (!state) throw new Error(`${world.name}: no state at ${label}`);
    samples[label] = stateSample(state);
  };
  /** The recording ends with the world that made it, so read it first. */
  const epoch = (name: string, label: string, last: boolean) => {
    checkpoint(label);
    const state = sim.state();
    const body = sim.record({ op: "read", from: 0, to: state?.simTime ?? 0 });
    if (body.op !== "read") throw new Error(`${world.name}: no recording`);
    traces.set(
      name,
      recordingTrace({
        source: target.world,
        read: body.read,
        serial,
        samples,
        warnings: last ? (sim.report()?.warnings ?? []) : [],
      })
    );
    serial = {};
    samples = {};
  };
  const step = (ms: number) => sim.step(ms);

  try {
    const loaded = await sim.load({ ...target, generation: 1 });
    if (!loaded.ok) throw new Error(`${world.name}: ${JSON.stringify(loaded)}`);
    await step(300);
    checkpoint("boot");
    if (world.script === "swap") {
      epoch(`${world.name}.before-swap`, "before-swap", false);
      setFirmware(root, world, "firmware/echo/echo.hex");
      const again = await sim.reload();
      if (!again.ok) throw new Error(`${world.name}: reload failed`);
      await step(300);
      checkpoint("swapped");
      sim.serialIn(id, "1");
      await step(150);
      checkpoint("swap-serial");
    } else if (world.script === "echo") {
      sim.serialIn(id, "1");
      await step(150);
      checkpoint("echo-1");
      sim.serialIn(id, "0x");
      await step(150);
      checkpoint("echo-0x");
      await sim.accept({ type: "reloadBoard", board: id, generation: 1 });
      await step(250);
      checkpoint("reloaded");
      sim.serialIn(id, "1");
      await step(150);
      checkpoint("echo-again");
    } else {
      await step(500);
      checkpoint("browned");
      sim.serialIn(id, "1");
      await step(100);
      checkpoint("serial-while-browned");
      await sim.accept({ type: "reloadBoard", board: id, generation: 1 });
      await step(500);
      checkpoint("reloaded");
    }
    epoch(world.name, "end", true);
    return traces;
  } finally {
    sim.dispose();
  }
}

const root = mkdtempSync(join(tmpdir(), "sfab-interact-"));
const traces = new Map<string, Trace>();
try {
  cpSync(nanoDir, root, { recursive: true });
  mkdirSync(join(root, "firmware", "echo"), { recursive: true });
  cpSync(join(echoDir, "echo.hex"), join(root, "firmware", "echo", "echo.hex"));
  mkdirSync(join(root, "firmware", "stall"), { recursive: true });
  cpSync(
    join(armDir, "firmware", "stall", "stall.hex"),
    join(root, "firmware", "stall", "stall.hex")
  );
  for (const world of WORLDS) writeWorld(root, world);
  for (const world of WORLDS) {
    for (const [name, trace] of await play(root, world))
      traces.set(name, trace);
  }
} finally {
  closeRootWatches();
  rmSync(root, { recursive: true, force: true });
}

const problems = checkTraceDir(traceDir, traces, write);
expect(
  problems.length === 0,
  `board interaction moved:\n${problems.join("\n")}`
);
console.log(
  write
    ? `board-interact: wrote ${traces.size} traces for ${WORLDS.length} worlds`
    : `board-interact: ${WORLDS.length} scripted worlds match their traces (serial in, reloadBoard, set-param firmware, brownout reboot)`
);
