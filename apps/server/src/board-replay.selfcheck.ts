/**
 * Replay golden. Every example root that has a firmware board runs headless
 * for a fixed simulated time, and a digest of what the sim computed is
 * compared with `board-replay.golden.json`.
 *
 * The digest covers computed values only: frame poses and joints, part and
 * supply voltages and currents, board state and pins, serial text, faults and
 * warnings. It leaves out anything that names how the document is laid out
 * (instance lists, the tree, lock hashes, manifest paths, seams, diagnostic
 * paths), and it reads boards and their LEDs by order, not by instance path,
 * so a board that gains a chip child keeps its digest.
 *
 * `--write` rewrites the golden. Do it only for a change that is meant to move
 * behaviour, never for a refactor.
 */

import { ok as expect } from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import type { RecordedFrame, RecordingEvent } from "@sfab-bench/contract";

import { byOrder, canon, num } from "./board-digest";
import { closeRootWatches } from "./projects";
import { headlessSim } from "./run";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const goldenPath = fileURLToPath(
  new URL("./board-replay.golden.json", import.meta.url)
);
const write = process.argv.includes("--write");

/** Simulated milliseconds each world runs. */
const RUN_MS = 3000;
type Row = {
  world: string;
  ms: number;
  digest: string;
  frames: number;
  boards: number;
  serialLines: number;
  resets: number;
  finalVolts: number[];
};

function boardOrdinals(ids: string[]): Map<string, number> {
  return new Map([...ids].sort().map((id, index) => [id, index]));
}

function frameView(frame: RecordedFrame) {
  return {
    t: frame.t,
    joints: frame.joints,
    limitDeg: frame.limitDeg,
    poses: frame.poses,
    parts: frame.parts,
    supplies: frame.supplies,
    boards: byOrder(frame.boards).map((board) => ({
      ...board,
      leds: byOrder(board.leds),
    })),
  };
}

function eventView(event: RecordingEvent, ordinal: Map<string, number>) {
  if (
    event.kind === "fault" ||
    event.kind === "reset" ||
    event.kind === "reboot" ||
    event.kind === "reload"
  ) {
    return {
      t: event.t,
      kind: event.kind,
      board: ordinal.get(event.board),
      message: "message" in event ? event.message : undefined,
    };
  }
  return null;
}

function exampleWorlds(): { project: string; world: string }[] {
  const worlds: { project: string; world: string }[] = [];
  const examples = join(root, "examples");
  for (const name of readdirSync(examples).sort()) {
    const dir = join(examples, name, "parts", "sfab");
    let files: string[];
    try {
      files = readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".json") || file.endsWith(".lock.json")) continue;
      const doc = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
        type?: string;
      };
      if (doc.type !== "assembly") continue;
      worlds.push({
        project: join(examples, name),
        world: `parts/sfab/${file}`,
      });
    }
  }
  return worlds;
}

function worldId(target: { project: string; world: string }): string {
  return `${relative(root, target.project)}/${target.world}`;
}

/** One world's row, or null when the world has no firmware board. */
async function replay(target: {
  project: string;
  world: string;
}): Promise<Row | null> {
  const sim = headlessSim();
  try {
    const loaded = await sim.load({ ...target, generation: 1 });
    if (!loaded.ok) return null;
    await sim.step(RUN_MS);
    const state = sim.state();
    if (!state) throw new Error(`${target.world}: no state`);
    const boardIds = Object.keys(state.boards);
    if (boardIds.length === 0) return null;
    const ordinal = boardOrdinals(boardIds);
    const body = sim.record({ op: "read", from: 0, to: state.simTime });
    if (body.op !== "read") throw new Error(`${target.world}: no recording`);

    const hash = createHash("sha256");
    for (const frame of body.read.frames) {
      hash.update(`f${canon(frameView(frame))}\n`);
    }
    for (const event of body.read.events) {
      const view = eventView(event, ordinal);
      if (view) hash.update(`e${canon(view)}\n`);
    }

    const serial = new Map<number, string>();
    for (const chunk of sim.drainSerial()) {
      const at = ordinal.get(chunk.board) ?? -1;
      serial.set(at, (serial.get(at) ?? "") + chunk.text);
    }
    let serialLines = 0;
    for (const at of [...serial.keys()].sort((a, b) => a - b)) {
      const text = serial.get(at) ?? "";
      hash.update(`s${at}:${JSON.stringify(text)}\n`);
      serialLines += text.split("\n").filter((line) => line.trim()).length;
    }

    hash.update(
      `z${canon({
        simTime: state.simTime,
        poses: state.poses,
        joints: state.joints,
        boards: byOrder(state.boards).map((board) => ({
          ...board,
          leds: byOrder(board.leds),
        })),
        parts: state.parts,
        supplies: state.supplies,
        diagnostics: (state.diagnostics ?? []).map((row) => ({
          severity: row.severity,
          code: row.code,
          message: row.message,
        })),
      })}\n`
    );
    const warnings = (sim.report()?.warnings ?? []).map((row) => ({
      severity: row.severity,
      code: row.code,
      message: row.message,
    }));
    hash.update(`w${canon(warnings)}\n`);

    return {
      world: worldId(target),
      ms: RUN_MS,
      digest: hash.digest("hex"),
      frames: body.read.frames.length,
      boards: boardIds.length,
      serialLines,
      resets: byOrder(state.boards).reduce(
        (sum, board) => sum + (board.resets ?? 0),
        0
      ),
      finalVolts: byOrder(state.boards).map((board) =>
        Number(num(board.voltage ?? 0))
      ),
    };
  } finally {
    sim.dispose();
  }
}

const rows: Row[] = [];
const skipped: string[] = [];
for (const target of exampleWorlds()) {
  const row = await replay(target);
  if (row) rows.push(row);
  else skipped.push(worldId(target));
}
closeRootWatches();

if (write) {
  writeFileSync(goldenPath, `${JSON.stringify(rows, null, 2)}\n`);
  console.log(`board-replay: wrote ${rows.length} rows`);
  for (const row of rows)
    console.log(`  ${row.world} ${row.digest.slice(0, 12)}`);
  console.log(`  no board: ${skipped.join(", ")}`);
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
          `(frames ${row.frames}/${want.frames}, serial ${row.serialLines}/${want.serialLines}, ` +
          `resets ${row.resets}/${want.resets}, volts ${row.finalVolts.join(",")}/${want.finalVolts.join(",")})`
      );
    }
    byWorld.delete(row.world);
  }
  for (const world of byWorld.keys()) {
    failures.push(`${world}: in the golden but no longer a board world`);
  }
  expect(failures.length === 0, `board replay moved:\n${failures.join("\n")}`);
  expect(rows.length > 0, "at least one board world");
  console.log(
    `board-replay: ${rows.length} board worlds match the golden (${RUN_MS} ms each; ${skipped.length} roots have no board)`
  );
}
