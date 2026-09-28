import { maskHasPin } from "@sfab-bench/contract";
import { assemble } from "avr8js/dist/esm/utils/assembler.js";

import { AvrBoard } from "./world/board";
import { AVR_PIN } from "./world/circuit/pin";
import { FLASH_BYTES } from "./world/ihex";
import type { RunPin, RunPlan } from "./world/plan";
import { applyGpioDrives, gpioInputNets } from "./world/wiring";

const GPIO: RunPin = {
  kind: "gpio",
  output: true,
  digital: true,
  pwm: true,
};
const GROUND: RunPin = {
  kind: "ground",
  output: false,
  digital: false,
  pwm: false,
};
const VCC: RunPin = {
  kind: "power",
  output: true,
  digital: false,
  pwm: false,
};

/** A plan with only the pins these nets touch. */
function gpioPlan(
  boardIds: string[],
  wires: [string, string][],
  supplyIds: string[] = []
): RunPlan {
  const pins: Record<string, RunPin> = {
    D2: GPIO,
    D3: GPIO,
    GND: GROUND,
    "5V": VCC,
  };
  return {
    environment: {
      ground: { plane: true },
      gravity: [0, 0, -9.81],
      targets: [],
    },
    robots: [],
    boards: boardIds.map((id) => ({
      id,
      type: "arduino-uno-r3",
      chip: "atmega328p",
      firmware: "unused.hex",
      pose: { position: [0, 0, 0], rotation: [1, 0, 0, 0] },
      size: [0.0686, 0.0534, 0.012],
      pins,
      powerInputs: ["5V"],
      vinFeed: false,
      voltagePin: "5V",
      groundPin: "GND",
      current: 0.05,
      boardCircuit: null,
      hasNetlist: false,
      brownoutVoltage: 2.7,
      brownoutAssertVoltage: 2.675,
      brownoutReleaseVoltage: 2.725,
      operatingVoltage: 5,
      supply: { min: 5, max: 5 },
      pin: AVR_PIN,
    })),
    supplies: supplyIds.map((id) => ({
      id,
      type: "usb-a-port",
      voltage: 5,
      currentLimit: 0.9,
      rSeries: 0.5,
      positivePin: "5V",
      groundPin: "GND",
      connector: "usb",
      pins: { "5V": VCC, GND: GROUND },
    })),
    parts: [],
    wires,
    shownWires: wires,
  };
}

/**
 * avr8js does not resolve INPUT_PULLUP. The bridge holds an undriven
 * input high, and a wired output wins. Built without arduino-cli: the
 * program is a few instructions from avr8js's assembler.
 *
 *   ldi r16, 0x04
 *   out 0x0b, r16      ; PORTD bit 2, DDRD stays 0 → D2 INPUT_PULLUP
 * loop:
 *   in r17, 0x09       ; PIND
 *   rjmp loop
 */

function expect(cond: unknown, label: string): asserts cond {
  if (!cond) throw new Error(label);
}

const source = `
ldi r16, 0x04
out 0x0b, r16
loop:
in r17, 0x09
rjmp loop
`;
const assembled = assemble(source);
expect(assembled.errors.length === 0, assembled.errors.join("; "));
const image = new Uint8Array(FLASH_BYTES);
image.fill(0xff);
image.set(assembled.bytes);

const board = new AvrBoard("uno");
board.load(image);
expect(board.running, "pull-up program did not load");
board.stepMillis();
const read = board.peekByte(17);
expect(read !== null && (read & 0x04) !== 0, `digitalRead D2 was ${read}`);
const high = board.peekPins();
expect(
  !maskHasPin(high.ddr, "D2") && maskHasPin(high.level, "D2"),
  `D2 pin table ddr ${high.ddr} level ${high.level}`
);
console.log("pull-up: D2 reads HIGH, pin table in H");

board.setDriven(2, false);
board.stepMillis();
const driven = board.peekByte(17);
expect(
  driven !== null && (driven & 0x04) === 0,
  `wired low lost to the pull-up (${driven})`
);
const low = board.peekPins();
expect(
  !maskHasPin(low.ddr, "D2") && !maskHasPin(low.level, "D2"),
  "a wired output low reads L"
);

board.setDriven(2, null);
board.stepMillis();
const released = board.peekByte(17);
expect(
  released !== null && (released & 0x04) !== 0,
  `releasing the wire did not restore the pull-up (${released})`
);
console.log("pull-up: a wired output wins, then the pin reads HIGH again");

const nets = gpioInputNets(gpioPlan(["uno"], [["uno.D2", "uno.D3"]]));
const d2 = nets.find((net) => net.bit === 2);
const d3 = nets.find((net) => net.bit === 3);
expect(
  d2?.drivers.some((driver) => driver.kind === "gpio" && driver.bit === 3) &&
    d3?.drivers.some((driver) => driver.kind === "gpio" && driver.bit === 2),
  `D2/D3 net ${JSON.stringify(nets)}`
);
console.log("pull-up nets: D2 and D3 can drive each other");

/**
 * D3 is an output on the same port as D2's pull-up. The program writes
 * HIGH, LOW, HIGH. Each `in` lands in SRAM so the peer's own read is
 * what we check, and the listener records the same levels.
 *
 *   ldi r16, 0x0c / out PORTD   ; D2 pull-up, D3 high, still an input
 *   ldi r16, 0x08 / out DDRD    ; D3 output HIGH
 *   in / sts 0x100
 *   ldi r16, 0x04 / out PORTD   ; D3 LOW, D2 pull-up stays
 *   in / sts 0x101
 *   ldi r16, 0x0c / out PORTD   ; D3 HIGH again
 *   in / sts 0x102
 */
function loadProgram(id: string, source: string): AvrBoard {
  const assembled = assemble(source);
  expect(assembled.errors.length === 0, assembled.errors.join("; "));
  const image = new Uint8Array(FLASH_BYTES);
  image.fill(0xff);
  image.set(assembled.bytes);
  const board = new AvrBoard(id);
  board.load(image);
  expect(board.running, `${id} did not load`);
  return board;
}

/** The worker's listener: resolve nets, then the caller can sample. */
function bindNets(boards: AvrBoard[], doc: RunPlan, after: () => void): void {
  const nets = gpioInputNets(doc);
  expect(nets.length > 0, "expected a GPIO net");
  let applying = false;
  const refresh = () => {
    if (applying) return;
    applying = true;
    try {
      applyGpioDrives(nets, boards);
    } finally {
      applying = false;
    }
    after();
  };
  for (const item of boards) item.onPinsChanged = refresh;
}

const driverSource = `
ldi r16, 0x0c
out 0x0b, r16
ldi r16, 0x08
out 0x0a, r16
in r17, 0x09
sts 0x100, r17
ldi r16, 0x04
out 0x0b, r16
in r17, 0x09
sts 0x101, r17
ldi r16, 0x0c
out 0x0b, r16
in r17, 0x09
sts 0x102, r17
loop:
rjmp loop
`;

const same = loadProgram("uno", driverSource);
const sameLevels: boolean[] = [];
bindNets([same], gpioPlan(["uno"], [["uno.D2", "uno.D3"]]), () => {
  const level = same.outputLevel(3);
  if (level === null) return;
  const pins = same.peekPins();
  expect(!maskHasPin(pins.ddr, "D2"), "D2 became an output");
  expect(
    maskHasPin(pins.level, "D2") === level,
    `same-port D2 ${maskHasPin(pins.level, "D2")} vs D3 ${level}`
  );
  sameLevels.push(level);
});
same.stepMillis();
expect(
  sameLevels.length === 3 &&
    sameLevels[0] === true &&
    sameLevels[1] === false &&
    sameLevels[2] === true,
  `same-port listener levels ${sameLevels.join(",")}`
);
for (const [addr, high] of [
  [0x100, true],
  [0x101, false],
  [0x102, true],
] as const) {
  const byte = same.peekByte(addr);
  expect(
    byte !== null && ((byte & 0x04) !== 0) === high,
    `same-port PIND at ${addr.toString(16)} was ${byte}, want D2 ${high ? "H" : "L"}`
  );
}
console.log("pull-up: same-port D3 output wins HIGH LOW HIGH");

const peerSource = `
ldi r16, 0x04
out 0x0b, r16
loop:
rjmp loop
`;
const driver = loadProgram("uno", driverSource);
const peer = loadProgram("other", peerSource);
const crossLevels: boolean[] = [];
bindNets(
  [driver, peer],
  gpioPlan(["uno", "other"], [["uno.D3", "other.D2"]]),
  () => {
    const level = driver.outputLevel(3);
    if (level === null) return;
    const pins = peer.peekPins();
    expect(!maskHasPin(pins.ddr, "D2"), "peer D2 became an output");
    expect(
      maskHasPin(pins.level, "D2") === level,
      `cross-board D2 ${maskHasPin(pins.level, "D2")} vs D3 ${level}`
    );
    crossLevels.push(level);
  }
);
peer.stepMillis();
const pulled = peer.peekPins();
expect(
  !maskHasPin(pulled.ddr, "D2") && maskHasPin(pulled.level, "D2"),
  "peer D2 pull-up was not high before the driver wrote"
);
driver.stepMillis();
expect(
  crossLevels.length === 3 &&
    crossLevels[0] === true &&
    crossLevels[1] === false &&
    crossLevels[2] === true,
  `cross-board listener levels ${crossLevels.join(",")}`
);
console.log("pull-up: cross-board D3 output wins HIGH LOW HIGH");

const lowSource = `
ldi r16, 0x00
out 0x0b, r16
ldi r16, 0x08
out 0x0a, r16
loop:
rjmp loop
`;
const resetDriver = loadProgram("uno", lowSource);
const resetPeer = loadProgram("other", peerSource);
const resetDoc = gpioPlan(["uno", "other"], [["uno.D3", "other.D2"]]);
const resetNets = gpioInputNets(resetDoc);
bindNets([resetDriver, resetPeer], resetDoc, () => {});
resetPeer.stepMillis();
resetDriver.stepMillis();
const drivenLow = resetPeer.peekPins();
expect(
  !maskHasPin(drivenLow.ddr, "D2") && !maskHasPin(drivenLow.level, "D2"),
  "peer did not follow the driver low"
);
resetDriver.holdInReset();
applyGpioDrives(resetNets, [resetDriver, resetPeer]);
const releasedByReset = resetPeer.peekPins();
expect(
  !maskHasPin(releasedByReset.ddr, "D2") &&
    maskHasPin(releasedByReset.level, "D2"),
  "peer did not return to its pull-up while the driver is in reset"
);
console.log("pull-up: reset driver releases the peer");

const sticky = loadProgram("uno", peerSource);
sticky.setDriven(2, true);
sticky.stepMillis();
expect(maskHasPin(sticky.peekPins().level, "D2"), "external high missing");
expect(sticky.reboot(), "reboot failed");
const cleared = sticky.peekPins();
expect(
  !maskHasPin(cleared.ddr, "D2") && !maskHasPin(cleared.level, "D2"),
  "reboot kept a stale driven high before the first instruction"
);
console.log("pull-up: reboot clears driven");

const grounded = loadProgram("uno", peerSource);
bindNets([grounded], gpioPlan(["uno"], [["uno.D2", "uno.GND"]]), () => {});
grounded.stepMillis();
const groundedPins = grounded.peekPins();
expect(
  !maskHasPin(groundedPins.ddr, "D2") && !maskHasPin(groundedPins.level, "D2"),
  "D2 pull-up won against GND"
);
console.log("pull-up: GND drives an input low");

const idleSource = `
loop:
rjmp loop
`;
const supplied = loadProgram("uno", idleSource);
const beforeSupply = supplied.peekPins();
expect(
  !maskHasPin(beforeSupply.level, "D2"),
  "D2 was high before the supply wire"
);
applyGpioDrives(
  gpioInputNets(gpioPlan(["uno"], [["uno.D2", "usb.5V"]], ["usb"])),
  [supplied]
);
const suppliedPins = supplied.peekPins();
expect(
  !maskHasPin(suppliedPins.ddr, "D2") && maskHasPin(suppliedPins.level, "D2"),
  "supply positive did not drive D2 high"
);
console.log("pull-up: a supply positive drives an input high");

console.log("pullup.selfcheck ok");
