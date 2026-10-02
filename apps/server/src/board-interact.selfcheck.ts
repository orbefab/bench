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
 * The digest hashes the same values as the replay golden, but it keeps the
 * board id and the diagnostic path: the ids must not change when a board
 * becomes a composite. Each row also lists the ids and the serial text, so the
 * fixture reads as proof that the interaction happened.
 *
 * Worlds are written into a temporary copy of `examples/nano`. `--write`
 * rewrites the golden; do it only for a change that is meant to move behaviour.
 */

import { ok as expect } from "node:assert/strict";
import { createHash } from "node:crypto";
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

import type { EditOp, WorldState } from "@sfab-bench/contract";
import { EditSession } from "@sfab-bench/parts";

import { canon, r5bBoards } from "./board-digest";
import { closeRootWatches } from "./projects";
import { headlessSim } from "./run";
import { absolutePath, nodeStore } from "./world/node-store";
import { catalogRoot } from "./world/plan";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const goldenPath = here("./board-interact.golden.json");
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

type Row = {
  world: string;
  digest: string;
  frames: number;
  boards: string[];
  resets: number;
  reboots: number;
  serial: Record<string, string>;
};

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

/** The state fields the replay golden hashes, with board ids and paths kept. */
function stateView(state: WorldState) {
  return {
    simTime: state.simTime,
    poses: state.poses,
    joints: state.joints,
    boards: r5bBoards(state.boards),
    parts: state.parts,
    supplies: state.supplies,
    diagnostics: (state.diagnostics ?? []).map((row) => ({
      severity: row.severity,
      code: row.code,
      message: row.message,
      path: row.path,
    })),
  };
}

async function play(root: string, world: World): Promise<Row> {
  const sim = headlessSim();
  const hash = createHash("sha256");
  const serial: Record<string, string> = {};
  let frames = 0;
  let resets = 0;
  let reboots = 0;
  const id = world.kind.key;
  const target = {
    project: root,
    world: `parts/sfab/${world.name}@1.0.0.json`,
  };

  const chunks = () => {
    for (const chunk of sim.drainSerial()) {
      serial[chunk.board] = (serial[chunk.board] ?? "") + chunk.text;
      hash.update(`s${canon(chunk)}\n`);
    }
  };
  const checkpoint = (label: string) => {
    chunks();
    const state = sim.state();
    if (!state) throw new Error(`${world.name}: no state at ${label}`);
    hash.update(`z${label}:${canon(stateView(state))}\n`);
  };
  /** The recording ends with the world that made it, so read it first. */
  const epoch = (label: string) => {
    checkpoint(label);
    const state = sim.state();
    const body = sim.record({ op: "read", from: 0, to: state?.simTime ?? 0 });
    if (body.op !== "read") throw new Error(`${world.name}: no recording`);
    for (const frame of body.read.frames) {
      frames += 1;
      hash.update(`f${canon({ ...frame, boards: r5bBoards(frame.boards) })}\n`);
    }
    for (const event of body.read.events) {
      if (event.kind === "reset") resets += 1;
      if (event.kind === "reboot") reboots += 1;
      hash.update(`e${canon(event)}\n`);
    }
  };
  const step = (ms: number) => sim.step(ms);

  try {
    const loaded = await sim.load({ ...target, generation: 1 });
    if (!loaded.ok) throw new Error(`${world.name}: ${JSON.stringify(loaded)}`);
    await step(300);
    checkpoint("boot");
    if (world.script === "swap") {
      epoch("before-swap");
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
    epoch("end");
    const warnings = (sim.report()?.warnings ?? []).map((row) => ({
      severity: row.severity,
      code: row.code,
      message: row.message,
      path: row.path,
    }));
    hash.update(`w${canon(warnings)}\n`);
    return {
      world: world.name,
      digest: hash.digest("hex"),
      frames,
      boards: Object.keys(sim.state()?.boards ?? {}).sort(),
      resets,
      reboots,
      serial,
    };
  } finally {
    sim.dispose();
  }
}

const root = mkdtempSync(join(tmpdir(), "sfab-interact-"));
const rows: Row[] = [];
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
  for (const world of WORLDS) rows.push(await play(root, world));
} finally {
  closeRootWatches();
  rmSync(root, { recursive: true, force: true });
}

if (write) {
  writeFileSync(goldenPath, `${JSON.stringify(rows, null, 2)}\n`);
  console.log(`board-interact: wrote ${rows.length} rows`);
  for (const row of rows) {
    console.log(
      `  ${row.world} ${row.digest.slice(0, 12)} resets ${row.resets} reboots ${row.reboots} ${JSON.stringify(row.serial)}`
    );
  }
} else {
  const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as Row[];
  const byWorld = new Map(golden.map((row) => [row.world, row]));
  const failures: string[] = [];
  for (const row of rows) {
    const want = byWorld.get(row.world);
    if (!want) failures.push(`${row.world}: not in the golden`);
    else if (want.digest !== row.digest) {
      failures.push(
        `${row.world}: digest ${row.digest.slice(0, 12)} != ${want.digest.slice(0, 12)} ` +
          `(boards ${row.boards.join(",")}/${want.boards.join(",")}, ` +
          `resets ${row.resets}/${want.resets}, reboots ${row.reboots}/${want.reboots}, ` +
          `serial ${JSON.stringify(row.serial)}/${JSON.stringify(want.serial)})`
      );
    }
    byWorld.delete(row.world);
  }
  for (const world of byWorld.keys()) failures.push(`${world}: not run`);
  expect(
    failures.length === 0,
    `board interaction moved:\n${failures.join("\n")}`
  );
  console.log(
    `board-interact: ${rows.length} scripted worlds match the golden (serial in, reloadBoard, set-param firmware, brownout reboot)`
  );
}
