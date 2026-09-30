/**
 * The chip registry's ATmega328P record against the values `board.ts` wired
 * as module constants before the registry: clock, memory, avr8js configs,
 * reset-check addresses, and the native pin table.
 */
import { deepStrictEqual, ok as expect, throws } from "node:assert/strict";
import { AvrBoard, chipSpec, requireChipSpec } from "@sfab-bench/engine-mcu";
import {
  adcConfig,
  portBConfig,
  portCConfig,
  portDConfig,
  timer0Config,
  timer1Config,
  timer2Config,
  usart0Config,
} from "avr8js";

const spec = chipSpec("atmega328p");
expect(spec, "atmega328p is registered");
if (!spec) throw new Error("unreachable");

expect(spec.chip === "atmega328p", "record names its chip");
expect(spec.hz === 16_000_000, "clock is 16 MHz");
expect(spec.flashBytes === 32 * 1024, "flash is 32 KiB");
expect(spec.sramBytes === 2048, "SRAM is 2 KiB");
expect(spec.onCpu === undefined, "the 328P needs no CPU hook");
expect(
  Object.keys(spec.ports).join() === "B,C,D",
  "ports are B, C and D, in that order"
);
deepStrictEqual(spec.ports.B, portBConfig);
deepStrictEqual(spec.ports.C, portCConfig);
deepStrictEqual(spec.ports.D, portDConfig);
expect(spec.timers.length === 3, "three timers");
deepStrictEqual(spec.timers[0], timer0Config);
deepStrictEqual(spec.timers[1], timer1Config);
deepStrictEqual(spec.timers[2], timer2Config);
deepStrictEqual(spec.usart, usart0Config);
deepStrictEqual(spec.adc, adcConfig);
// Literal register addresses, so the record cannot drift with the library.
deepStrictEqual(
  [spec.ports.B, spec.ports.C, spec.ports.D].map((port) => [
    port?.PIN,
    port?.DDR,
    port?.PORT,
  ]),
  [
    [0x23, 0x24, 0x25],
    [0x26, 0x27, 0x28],
    [0x29, 0x2a, 0x2b],
  ]
);
expect(
  spec.timers[1]?.TCNT === 0x84 && spec.timers[1]?.OCRA === 0x88,
  "timer 1"
);
expect(
  spec.usart.UDR === 0xc6 && spec.usart.UCSRA === 0xc0,
  "USART0 registers"
);
expect(spec.adc.ADMUX === 0x7c && spec.adc.ADCSRA === 0x7a, "ADC registers");
deepStrictEqual(spec.io, {
  DDRB: 0x24,
  PORTB: 0x25,
  SREG: 0x5f,
  TCCR1A: 0x80,
  TCCR1B: 0x81,
  UCSR0A: 0xc0,
  UCSR0C: 0xc2,
});

// Native pins: every one names a real port and a bit inside it, and the
// register addresses of the port agree with the avr8js config.
const widths: Record<string, number> = { B: 8, C: 7, D: 8 };
const names = Object.keys(spec.pins);
expect(names.length === 23, "PB0-7, PC0-6 and PD0-7 make 23 pins");
for (const name of names) {
  const pin = spec.pins[name];
  expect(pin, `${name} has a row`);
  if (!pin) continue;
  expect(spec.ports[pin.port], `${name}: port ${pin.port} is in the record`);
  expect(
    Number.isInteger(pin.bit) && pin.bit >= 0 && pin.bit < 8,
    `${name}: bit ${pin.bit} is 0-7`
  );
  expect(pin.bit < (widths[pin.port] ?? 0), `${name}: bit is on the chip`);
  expect(name === `P${pin.port}${pin.bit}`, `${name} spells its port and bit`);
}
deepStrictEqual(spec.pins.PB5, { port: "B", bit: 5 });
deepStrictEqual(spec.pins.PC0, { port: "C", bit: 0 });
deepStrictEqual(spec.pins.PD7, { port: "D", bit: 7 });
expect(spec.pins.PB7 && !spec.pins.PC7, "PC7 does not exist on the 328P");

// Unknown chips are refused by name.
expect(chipSpec("atmega32u4") === null, "no 32U4 entry yet");
expect(chipSpec("toString") === null, "prototype keys are not chips");
throws(() => requireChipSpec("atmega32u4"), /unsupported chip "atmega32u4"/);

// A board takes its clock from the record.
const board = new AvrBoard("t", spec);
expect(
  board.hz === 16_000_000 && board.chip === spec,
  "board holds the record"
);
const none = new AvrBoard("t", null);
none.load(new Uint8Array(spec.flashBytes));
expect(!none.running && none.fault === "board has no chip", "no chip, no boot");

console.log("chips: atmega328p record matches the constants it replaced");
