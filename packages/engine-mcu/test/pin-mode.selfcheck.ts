/**
 * One pin model on `AvrBoard`: the drive mode, the output level, the packed
 * pin state and the mode-change events all read the port's output word and
 * DDR. A timer compare output (PWM never writes PORT) packs as the wire
 * reads; every DDR and PORT change is a cycle-stamped mode change, including
 * the same-level high → pull-up release a level edge cannot show.
 */
import { ok as expect } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PinMode } from "@sfab-bench/contract";
import { AvrBoard, parseIntelHex, requireChipSpec } from "../src/index";

const chip = requireChipSpec("atmega328p");

/** A flash image from 16-bit instruction words, the rest erased. */
function image(words: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(chip.flashBytes).fill(0xff);
  words.forEach((word, i) => {
    bytes[2 * i] = word & 0xff;
    bytes[2 * i + 1] = word >> 8;
  });
  return bytes;
}

const SBI_DDRB0 = 0x9a20;
const CBI_DDRB0 = 0x9820;
const SBI_PORTB0 = 0x9a28;
const CBI_PORTB0 = 0x9828;
const RJMP_SELF = 0xcfff;

// Every transition the four modes need, one SBI/CBI each (avr8js stamps
// them one or two cycles apart).
const walk = new AvrBoard("walk", chip, ["PB0"]);
walk.load(
  image([
    SBI_DDRB0, // input → low
    SBI_PORTB0, // low → high
    CBI_DDRB0, // high → pull-up: the level stays high
    CBI_PORTB0, // pull-up → input
    SBI_PORTB0, // input → pull-up
    SBI_DDRB0, // pull-up → high
    CBI_PORTB0, // high → low
    RJMP_SELF,
  ])
);
let levelEdges = 0;
walk.onEdge = () => {
  levelEdges += 1;
};
expect(walk.driveMode(0) === "input", "a fresh pin is an input");
walk.stepMillis();
const want: PinMode[] = [
  "low",
  "high",
  "pullup",
  "input",
  "pullup",
  "high",
  "low",
];
const got = walk.modeChanges.map((change) => change.mode);
expect(
  JSON.stringify(got) === JSON.stringify(want),
  `mode changes ${JSON.stringify(got)}`
);
const cycles = walk.modeChanges.map((change) => change.cycle);
expect(
  cycles.every((cycle, i) => i === 0 || cycle > (cycles[i - 1] ?? 0)),
  `mode changes are in cycle order: ${cycles.join(",")}`
);
expect(
  walk.modeChanges.every((change) => change.bit === 0),
  "each change names its pin"
);
// Only the output word's four PORT flips are level edges. The DDR writes
// (high → pull-up among them) change the mode alone.
expect(levelEdges === 4, `level edges ${levelEdges}, want 4`);
expect(walk.driveMode(0) === "low", "the walk ends low");

// The pull-up is the read level until a wire drives the pin.
const pulled = new AvrBoard("pulled", chip, ["PB0"]);
pulled.load(image([SBI_PORTB0, RJMP_SELF]));
pulled.stepMillis();
expect(pulled.driveMode(0) === "pullup", "PORT alone is the pull-up");
expect(pulled.outputLevel(0) === null, "a pull-up has no output level");
expect(pulled.pinLevel(0), "a free pull-up reads high");
expect((pulled.peekPins().level[0] ?? 0) === 1, "and packs high");
expect((pulled.peekPins().ddr[0] ?? 0) === 0, "and packs as an input");
pulled.setDriven(0, false);
expect(!pulled.pinLevel(0), "a wire driven low wins over the pull-up");
pulled.holdInReset();
expect(pulled.driveMode(0) === "input", "a held chip's pin is an input");
expect(!pulled.pinLevel(0), "and reads low");

// Timer1 PWM on D9 (PB1): the packed level is the output level at every
// step, high and low both seen. PORTB1 is never written.
const hexPath = fileURLToPath(
  new URL(
    "../../../apps/server/fixtures/pwm-rc/firmware/pwm-rc/pwm-rc.hex",
    import.meta.url
  )
);
const hex = parseIntelHex(readFileSync(hexPath, "utf8"));
expect(hex.ok, `pwm-rc.hex: ${hex.ok ? "" : hex.error}`);
if (hex.ok) {
  const pwm = new AvrBoard("pwm", chip, ["PB1"]);
  pwm.load(hex.bytes);
  let mismatches = 0;
  let highs = 0;
  let lows = 0;
  for (let ms = 0; ms < 100; ms++) {
    pwm.stepMillis();
    const out = pwm.outputLevel(0);
    if (out === null) continue;
    const packed = ((pwm.peekPins().level[0] ?? 0) & 1) === 1;
    if (packed !== out || pwm.pinLevel(0) !== out) mismatches += 1;
    if (out) highs += 1;
    else lows += 1;
  }
  expect(mismatches === 0, `packed vs output mismatches: ${mismatches}`);
  expect(highs > 0 && lows > 0, `PWM seen high ${highs}, low ${lows}`);
  expect(
    ((pwm.peekRegs()?.PORTB ?? 0) & 0b10) === 0,
    "PWM never writes PORTB1"
  );
  console.log(`pin-mode: PWM D9 high ${highs}, low ${lows} of 100 steps`);
}

console.log(`pin-mode: changes ${got.join(" → ")}, ${levelEdges} level edges`);
console.log("pin-mode.selfcheck ok");
