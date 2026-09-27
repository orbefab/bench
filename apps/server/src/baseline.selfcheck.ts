/**
 * The v2 arm runs match the frames frozen before the format change.
 * Every number is `===`, including the floats JSON kept.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { RecordingEvent, RecordingRead } from "@sfab-bench/contract";

import { closeRootWatches } from "./projects";
import { attachWorld, readRecording, stepWorld, stopWorld } from "./world/host";
import { planWorld } from "./world/plan";
import { unoUsbPathFor } from "./world/power-path";
import { powerFeedsOf } from "./world/wiring";

const armDir = fileURLToPath(
  new URL("../../../examples/arm/", import.meta.url)
);
const fixturePath = fileURLToPath(
  new URL("../fixtures/arm-baseline.json", import.meta.url)
);

type FrozenFrame = {
  t: number;
  joints: Record<string, Record<string, number>>;
  supplies: Record<string, { voltage: number; current: number }>;
  boards: Record<string, { reset: boolean; brownout: boolean; resets: number }>;
  servos: Record<string, { pulse: number | null; current: number }>;
};

type Frozen = {
  durationS: number;
  runs: Record<string, { frames: FrozenFrame[] }>;
};

function expect(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(label);
}

function eventsAt(
  events: RecordingEvent[],
  kind: "reset" | "reboot",
  board: string
): number[] {
  const times: number[] = [];
  for (const event of events) {
    if (event.kind === kind && event.board === board) times.push(event.t);
  }
  return times;
}

/**
 * The fixture froze the old supply voltage: the board node when a USB
 * path is present, and the terminal otherwise. `===` still catches a
 * 1e-7 change.
 */
function pathBoards(name: string): Map<string, string> {
  const planned = planWorld(armDir, name);
  if (!planned.ok) {
    throw new Error(planned.errors.map((item) => item.message).join("; "));
  }
  const feeds = powerFeedsOf(planned.plan);
  const boards = new Map<string, string>();
  for (const board of planned.plan.boards) {
    const supplyId = feeds.boards[board.id];
    if (!supplyId) continue;
    const supply = planned.plan.supplies.find((item) => item.id === supplyId);
    if (!supply || !unoUsbPathFor(supply.connector, board.boardCircuit))
      continue;
    boards.set(supplyId, board.id);
  }
  return boards;
}

/** The same rows the baseline script wrote from one 3 s recording. */
function captured(
  read: RecordingRead,
  pathOf: Map<string, string>
): FrozenFrame[] {
  return read.frames.map((frame) => {
    const prev = frame.t - 0.01;
    const boards: FrozenFrame["boards"] = {};
    for (const [id, board] of Object.entries(frame.boards)) {
      const resets = eventsAt(read.events, "reset", id);
      const reboots = eventsAt(read.events, "reboot", id);
      boards[id] = {
        reset: resets.some((t) => t > prev && t <= frame.t),
        brownout: board.brownout,
        resets: reboots.filter((t) => t <= frame.t).length,
      };
    }
    const servos: FrozenFrame["servos"] = {};
    for (const [id, part] of Object.entries(frame.parts)) {
      servos[id] = { pulse: part.pulseUs, current: part.current };
    }
    const supplies: FrozenFrame["supplies"] = {};
    for (const [id, supply] of Object.entries(frame.supplies)) {
      const boardId = pathOf.get(id);
      const node = boardId ? frame.boards[boardId]?.voltage : undefined;
      supplies[id] = {
        voltage: node === undefined ? supply.voltage : node,
        current: supply.current,
      };
    }
    return {
      t: frame.t,
      joints: frame.joints,
      supplies,
      boards,
      servos,
    };
  });
}

function differ(live: unknown, frozen: unknown, path: string): string | null {
  if (live === frozen) return null;
  if (
    live &&
    frozen &&
    typeof live === "object" &&
    typeof frozen === "object"
  ) {
    const left = live as Record<string, unknown>;
    const right = frozen as Record<string, unknown>;
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) {
      const found = differ(left[key], right[key], `${path}.${key}`);
      if (found) return found;
    }
    return null;
  }
  return `${path}: ${String(live)} !== ${String(frozen)}`;
}

async function runWorld(name: string): Promise<FrozenFrame[]> {
  const events: { type: string; message?: string }[] = [];
  const attached = await attachWorld(armDir, name, {
    sender: { kind: "loopback", label: "Mac" },
    onEvent(event) {
      if (event.type === "error") {
        events.push({
          type: event.type,
          message:
            event.message ??
            event.errors.map((item) => item.message).join("; "),
        });
      }
    },
  });
  if ("error" in attached) throw new Error(attached.error);
  try {
    const stepped = await stepWorld(armDir, name, 3000, {
      kind: "loopback",
      label: "Mac",
    });
    if ("error" in stepped) throw new Error(stepped.error);
    const read = await readRecording(armDir, name, { from: 0, to: 3 });
    if ("error" in read) throw new Error(read.error);
    const failed = events.find((event) => event.type === "error");
    expect(!failed, failed?.message ?? "world error");
    return captured(read, pathBoards(name));
  } finally {
    attached.detach();
    await stopWorld(armDir, name);
    closeRootWatches();
  }
}

const frozen = JSON.parse(readFileSync(fixturePath, "utf8")) as Frozen;
expect(frozen.durationS === 3, "fixture duration");

for (const name of ["arm.world.json", "arm-stall.world.json"] as const) {
  const live = await runWorld(name);
  const saved = frozen.runs[name]?.frames;
  expect(saved, `fixture run ${name}`);
  if (!saved) throw new Error("unreachable");
  expect(
    live.length === saved.length,
    `${name} frames ${live.length} vs ${saved.length}`
  );
  for (let i = 0; i < saved.length; i++) {
    const mismatch = differ(live[i], saved[i], `${name}[${i}]`);
    expect(!mismatch, mismatch ?? "");
  }
  console.log(`${name}: ${live.length} frames match the baseline`);
}

console.log("baseline.selfcheck ok");
