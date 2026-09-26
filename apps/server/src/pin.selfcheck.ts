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
  arduinoPinBit,
  arduinoPinMask,
  maskHasPin,
  type WorldPinState,
  type WorldState,
} from "@sfab-bench/contract";

import { closeRootWatches } from "./projects";
import { readDraft, writeDraft } from "./world/draft";
import { worldWorkerEntry } from "./world/host";
import type { FromWorker, ToWorker } from "./world/worker";

/**
 * Pin masks, then the arm fixture. `step(100)` is 100 ms of simulation.
 * The state under test is the one whose sim time is 0.100 s.
 */

const armDir = fileURLToPath(
  new URL("../../../examples/arm/", import.meta.url)
);

function expect(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(label);
}

function bit(pin: string): number {
  const index = arduinoPinBit(pin);
  expect(index !== undefined, `${pin} is an Arduino pin`);
  return index as number;
}

expect(bit("D0") === 0, "D0 is bit 0");
expect(bit("D7") === 7, "D7 is bit 7");
expect(bit("D8") === 8, "D8 is bit 8");
expect(bit("D9") === 9, "D9 is bit 9");
expect(bit("D13") === 13, "D13 is bit 13");
expect(bit("A0") === 14, "A0 is bit 14");
expect(bit("A5") === 19, "A5 is bit 19");
expect(arduinoPinBit("D14") === undefined, "D14 is not a pin");
expect(arduinoPinBit("A6") === undefined, "A6 is not a pin");
expect(arduinoPinBit("B0") === undefined, "port names are not pin names");

expect(arduinoPinMask(1 << 0, 0, 0) === 1 << bit("D0"), "PORTD0 is D0");
expect(arduinoPinMask(1 << 7, 0, 0) === 1 << bit("D7"), "PORTD7 is D7");
expect(arduinoPinMask(0, 1 << 0, 0) === 1 << bit("D8"), "PORTB0 is D8");
expect(arduinoPinMask(0, 1 << 1, 0) === 1 << bit("D9"), "PORTB1 is D9");
expect(arduinoPinMask(0, 1 << 5, 0) === 1 << bit("D13"), "PORTB5 is D13");
expect(arduinoPinMask(0, 1 << 6, 0) === 0, "PORTB6 is not an Arduino pin");
expect(arduinoPinMask(0, 1 << 7, 0) === 0, "PORTB7 is not an Arduino pin");
expect(arduinoPinMask(0, 0, 1 << 0) === 1 << bit("A0"), "PORTC0 is A0");
expect(arduinoPinMask(0, 0, 1 << 5) === 1 << bit("A5"), "PORTC5 is A5");
expect(arduinoPinMask(0, 0, 1 << 6) === 0, "PORTC6 is not an Arduino pin");
expect(
  arduinoPinMask(0xff, 0xff, 0xff) === (1 << 20) - 1,
  "the mask is twenty bits"
);
expect(maskHasPin(arduinoPinMask(0, 1 << 1, 0), "D9"), "maskHasPin reads D9");
expect(!maskHasPin(arduinoPinMask(0, 1 << 1, 0), "D8"), "maskHasPin misses D8");
console.log("pin mask: D/B/C bits map onto D0–D13 and A0–A5");

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
  const hold = await stepWorld(armDir, "arm.world.json", 100);
  expect(hold.simTime.toFixed(3) === "0.100", `hold simTime ${hold.simTime}`);
  const uno = pinsOf(hold, "uno");
  expect(
    maskHasPin(uno.ddr, "D9"),
    `D9 is an output, ddr ${uno.ddr.toString(2)}`
  );
  expect(
    maskHasPin(uno.toggled, "D9"),
    `D9 toggled, toggled ${uno.toggled.toString(2)}`
  );
  expect(
    !maskHasPin(uno.ddr, "D13"),
    `D13 is an input, ddr ${uno.ddr.toString(2)}`
  );
  console.log(
    `fixture pins: D9 out+activity, D13 in, ddr ${uno.ddr.toString(2)}`
  );

  const pairRoot = mkdtempSync(join(tmpdir(), "sfab-pins-"));
  try {
    cpSync(armDir, pairRoot, { recursive: true });
    const doc = readDraft(pairRoot, "arm.world.json");
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
    const holdPins = pinsOf(both, "uno");
    const stallPins = pinsOf(both, "stall");
    expect(
      !maskHasPin(holdPins.level, "D9"),
      `hold D9 is low at 55 ms, level ${holdPins.level}`
    );
    expect(
      maskHasPin(stallPins.level, "D9"),
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
