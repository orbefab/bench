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
import { Worker } from "node:worker_threads";

import {
  pinBitSet,
  pinHas,
  pinIndex,
  type WorldPinState,
  type WorldState,
} from "@sfab-bench/contract";

import { closeRootWatches } from "./projects";
import { worldWorkerEntry } from "./world/host";
import { planWorld } from "./world/plan";
import { readDraft, writeDraft } from "./world/selfcheck-draft";
import type { FromWorker, ToWorker } from "./world/worker";

/**
 * Pin words on the board's own names, then the arm fixture.
 * `step(100)` is 100 ms of simulation.
 * The state under test is the one whose sim time is 0.100 s.
 */

const armDir = fileURLToPath(
  new URL("../../../examples/arm/", import.meta.url)
);
const armWorld = "parts/sfab/arm-bench@1.0.0.json";

const header = [
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
const bare = [
  "PB0",
  "PB1",
  "PB2",
  "PB3",
  "PB4",
  "PB5",
  "PB6",
  "PB7",
  "PC0",
  "PC1",
  "PC2",
  "PC3",
  "PC4",
  "PC5",
  "PC6",
  "PD0",
  "PD1",
  "PD2",
  "PD3",
  "PD4",
  "PD5",
  "PD6",
  "PD7",
];

expect(pinIndex(header, "D0") === 0, "D0 is pin 0 of a header list");
expect(pinIndex(header, "D9") === 9, "D9 is pin 9 of a header list");
expect(pinIndex(header, "D13") === 13, "D13 is pin 13 of a header list");
expect(pinIndex(header, "A5") === 19, "A5 is pin 19 of a header list");
expect(pinIndex(header, "PB5") === undefined, "a header list has no PB5");
expect(pinIndex(bare, "PB5") === 5, "PB5 is pin 5 of a bare chip");
expect(pinHas([1 << 5], header, "D5"), "bit 5 of a header list is D5");
expect(pinHas([1 << 5], bare, "PB5"), "bit 5 of a bare chip is PB5");
expect(!pinHas([1 << 5], bare, "D5"), "a bare chip does not label bit 5 as D5");
expect(pinBitSet([1 << 9], 9), "bit 9 is set");
expect(!pinBitSet([1 << 9], 8), "bit 8 is clear");

function pinOrder(
  project: string,
  world: string,
  id: string
): readonly string[] {
  const planned = planWorld(project, world);
  if (!planned.ok) {
    throw new Error(planned.errors.map((item) => item.message).join("; "));
  }
  const board = planned.plan.boards.find((item) => item.id === id);
  if (!board) throw new Error(`no board ${id}`);
  return board.pinOrder;
}

function waitUntil(
  pred: () => boolean,
  label: string,
  ms = 20000
): Promise<void> {
  if (pred()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`timed out: ${label}`));
    }, ms);
    const poll = setInterval(() => {
      if (!pred()) return;
      clearInterval(poll);
      clearTimeout(timer);
      resolve();
    }, 15);
  });
}

function errorText(messages: FromWorker[]): string {
  const err = messages.find((message) => message.type === "error");
  if (!err || err.type !== "error") return "";
  return err.message ?? err.errors.map((item) => item.message).join("; ");
}

async function stepWorld(
  project: string,
  world: string,
  n: number
): Promise<WorldState> {
  const worker = new Worker(worldWorkerEntry());
  const messages: FromWorker[] = [];
  worker.on("message", (message: FromWorker) => {
    messages.push(message);
  });
  const stamp = (n / 1000).toFixed(3);
  try {
    worker.postMessage({
      type: "load",
      project,
      world,
      generation: 1,
    } satisfies ToWorker);
    await waitUntil(
      () =>
        messages.some((message) => message.type === "ready") ||
        errorText(messages) !== "",
      "worker ready"
    );
    const failed = errorText(messages);
    if (failed) throw new Error(failed);
    await waitUntil(
      () => messages.some((message) => message.type === "state"),
      "initial state"
    );
    worker.postMessage({ type: "step", n, generation: 1 } satisfies ToWorker);
    await waitUntil(
      () =>
        errorText(messages) !== "" ||
        messages.some(
          (message) =>
            message.type === "state" &&
            message.state.simTime.toFixed(3) === stamp
        ),
      `state at ${stamp}s`
    );
    const failedStep = errorText(messages);
    if (failedStep) throw new Error(failedStep);
    const hit = messages.find(
      (message) =>
        message.type === "state" && message.state.simTime.toFixed(3) === stamp
    );
    if (!hit || hit.type !== "state") throw new Error(`no state at ${stamp}s`);
    return hit.state;
  } finally {
    try {
      worker.postMessage({ type: "stop" } satisfies ToWorker);
    } catch {
      /* already gone */
    }
    await worker.terminate();
  }
}

function pinsOf(state: WorldState, id: string): WorldPinState {
  const pins = state.boards[id]?.pins;
  expect(pins, `${id} pins are on the state`);
  return pins as WorldPinState;
}

try {
  const unoNames = pinOrder(armDir, armWorld, "uno");
  const hold = await stepWorld(armDir, armWorld, 100);
  expect(hold.simTime.toFixed(3) === "0.100", `hold simTime ${hold.simTime}`);
  const uno = pinsOf(hold, "uno");
  expect(
    pinHas(uno.ddr, unoNames, "D9"),
    `D9 is an output, ddr ${(uno.ddr[0] ?? 0).toString(2)}`
  );
  expect(
    pinHas(uno.toggled, unoNames, "D9"),
    `D9 toggled, toggled ${(uno.toggled[0] ?? 0).toString(2)}`
  );
  expect(
    !pinHas(uno.ddr, unoNames, "D13"),
    `D13 is an input, ddr ${(uno.ddr[0] ?? 0).toString(2)}`
  );
  console.log(
    `fixture pins: D9 out+activity, D13 in, ddr ${(uno.ddr[0] ?? 0).toString(2)}`
  );

  const pairRoot = mkdtempSync(join(tmpdir(), "sfab-pins-"));
  try {
    cpSync(armDir, pairRoot, { recursive: true });
    const doc = readDraft(pairRoot, armWorld);
    const unoBoard = doc.boards[0];
    if (!unoBoard) throw new Error("fixture board");
    doc.boards.push({
      ...unoBoard,
      id: "stall",
      firmware: "firmware/stall/stall.hex",
      source: "firmware/stall/stall.ino",
      pose: {
        position: [0.2, 0, 0.006],
        rotation: [1, 0, 0, 0],
      },
    });
    // An unwired board does not run. This CPU is here for its pins, so
    // it takes the USB rail. Two boards plus the hold servo stay under
    // the 500 mA limit, and the rail does not sag.
    doc.wires.push(["usb.5V", "stall.5V"], ["usb.GND", "stall.GND"]);
    writeDraft(pairRoot, "two.world.json", doc);
    // 55 ms lands inside the stall firmware's longer servo pulse and after
    // the hold firmware's pulse has ended, so D9's level differs.
    const both = await stepWorld(pairRoot, "two.world.json", 55);
    const holdNames = pinOrder(pairRoot, "two.world.json", "uno");
    const stallNames = pinOrder(pairRoot, "two.world.json", "stall");
    const holdPins = pinsOf(both, "uno");
    const stallPins = pinsOf(both, "stall");
    expect(
      !pinHas(holdPins.level, holdNames, "D9"),
      `hold D9 is low at 55 ms, level ${holdPins.level}`
    );
    expect(
      pinHas(stallPins.level, stallNames, "D9"),
      `stall D9 is high at 55 ms, level ${stallPins.level}`
    );
    console.log("two boards: hold and stall report different pin states");
  } finally {
    rmSync(pairRoot, { recursive: true, force: true });
  }
} finally {
  closeRootWatches();
}

console.log("pin.selfcheck ok");
