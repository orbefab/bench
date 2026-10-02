/**
 * The chip registry's ATmega328P record against the values `board.ts` wired
 * as module constants before the registry: clock, memory, avr8js configs,
 * reset-check addresses, and the native pin table.
 */
import { deepStrictEqual, ok as expect, throws } from "node:assert/strict";
import {
  ADCMuxInputType,
  ADCReference,
  adcConfig,
  PCINT0,
  portBConfig,
  portCConfig,
  portDConfig,
  timer0Config,
  timer1Config,
  timer2Config,
  usart0Config,
} from "avr8js";
import { AvrBoard, chipSpec, requireChipSpec } from "../src/index";

const spec = chipSpec("atmega328p");
expect(spec, "atmega328p is registered");
if (!spec) throw new Error("unreachable");

expect(spec.chip === "atmega328p", "record names its chip");
expect(spec.hz === 16_000_000, "clock is 16 MHz");
expect(spec.flashBytes === 32 * 1024, "flash is 32 KiB");
expect(spec.sramBytes === 2048, "SRAM is 2 KiB");
expect(spec.onCpu === undefined, "the 328P needs no CPU hook");
expect(spec.onAdc === undefined, "the 328P needs no ADC hook");
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
deepStrictEqual(spec.adcPins, {
  0: "PC0",
  1: "PC1",
  2: "PC2",
  3: "PC3",
  4: "PC4",
  5: "PC5",
  6: "ADC6",
  7: "ADC7",
});
expect(spec.gaps === undefined, "the 328P names no emulator gap");

// ATmega32U4: ports E and F, USART1, timers 0/1/3, MUX5, the PLL hook.
const u4 = chipSpec("atmega32u4");
expect(u4, "atmega32u4 is registered");
if (!u4) throw new Error("unreachable");
expect(u4.chip === "atmega32u4", "record names its chip");
expect(u4.hz === 16_000_000, "32U4 clock is 16 MHz");
expect(u4.flashBytes === 32 * 1024, "32U4 flash is 32 KiB");
expect(u4.sramBytes === 2560, "32U4 SRAM is 2.5 KB");
expect(
  Object.keys(u4.ports).join() === "B,C,D,E,F",
  "32U4 ports are B, C, D, E and F"
);
deepStrictEqual(
  [u4.ports.B, u4.ports.C, u4.ports.D, u4.ports.E, u4.ports.F].map((port) => [
    port?.PIN,
    port?.DDR,
    port?.PORT,
  ]),
  [
    [0x23, 0x24, 0x25],
    [0x26, 0x27, 0x28],
    [0x29, 0x2a, 0x2b],
    [0x2c, 0x2d, 0x2e],
    [0x2f, 0x30, 0x31],
  ]
);
expect(
  u4.ports.B?.pinChange?.pinChangeInterrupt === 0x12,
  "32U4 PCINT0 is vector 9"
);
expect(
  PCINT0.pinChangeInterrupt === 6,
  "the shared PCINT0 vector stays the 328P's"
);
expect(u4.ports.C?.pinChange === undefined, "port C has no pin-change");
expect(
  u4.ports.D?.externalInterrupts.length === 4 &&
    u4.ports.D.externalInterrupts[0]?.interrupt === 0x02 &&
    u4.ports.D.externalInterrupts[3]?.interrupt === 0x08,
  "INT0–INT3 are PD0–PD3"
);
expect(u4.ports.E?.externalInterrupts[6]?.interrupt === 0x0e, "INT6 is PE6");
expect(u4.timers.length === 3, "timers 0, 1 and 3");
expect(
  u4.timers[0]?.ovfInterrupt === 0x2e && u4.timers[0]?.compPinB === 0,
  "timer 0 vectors and OC0B"
);
expect(
  u4.timers[1]?.TCNT === 0x84 &&
    u4.timers[1]?.OCRC === 0x8c &&
    u4.timers[1]?.compPinA === 5,
  "timer 1 keeps its registers and gains OCR1C"
);
expect(
  u4.timers[2]?.TCCRA === 0x90 &&
    u4.timers[2]?.TCNT === 0x94 &&
    u4.timers[2]?.compPinA === 6 &&
    u4.timers[2]?.externalClockPort === 0,
  "timer 3 is OC3A only"
);
expect(
  u4.usart.UDR === 0xce && u4.usart.UCSRA === 0xc8,
  "USART1 is the console"
);
expect(
  u4.adc.ADMUX === 0x7c &&
    u4.adc.numChannels === 14 &&
    u4.adc.muxInputMask === 0x3f &&
    u4.adc.adcInterrupt === 0x3a,
  "ADC keeps MUX5 in the channel"
);
expect(u4.adc.muxChannels[0x27] === undefined, "temperature mux reads 0");
expect(u4.adc.muxChannels[8] === undefined, "channel 8 is mux 0x20");
expect(
  u4.adc.adcReferences[3] === ADCReference.Internal2V56,
  "REFS 11 is the 2.56 V reference"
);
deepStrictEqual(u4.adc.muxChannels[0x20], {
  type: ADCMuxInputType.SingleEnded,
  channel: 8,
});
deepStrictEqual(u4.io, {
  DDRB: 0x24,
  PORTB: 0x25,
  SREG: 0x5f,
  TCCR1A: 0x80,
  TCCR1B: 0x81,
  UCSR0A: 0xc8,
  UCSR0C: 0xca,
});
const u4Names = Object.keys(u4.pins);
expect(u4Names.length === 26, "bonded GPIO only");
for (const name of u4Names) {
  const pin = u4.pins[name];
  expect(pin, `${name} has a row`);
  if (!pin) continue;
  expect(u4.ports[pin.port], `${name}: port ${pin.port} is in the record`);
  expect(name === `P${pin.port}${pin.bit}`, `${name} spells its port and bit`);
}
expect(
  !u4.pins.PC0 && !u4.pins.PE0 && !u4.pins.PF2,
  "unbonded bits are absent"
);
expect(u4.pins.PC6 && u4.pins.PE6 && u4.pins.PF7, "bonded high bits exist");
deepStrictEqual(u4.adcPins[7], "PF7");
deepStrictEqual(u4.adcPins[8], "PD4");
expect(u4.adcPins[2] === undefined, "ADC2 is not a channel");
expect(
  u4.gaps?.map((gap) => gap.code).join() === "timer4,usb-cdc",
  "timer 4 and USB CDC are named gaps"
);

// PLOCK follows PLLE. The image is: ldi r16,0x12; out 0x29,r16; in r17,0x29;
// ldi r16,0; out 0x29,r16; in r18,0x29; rjmp .-2.
const pll = new Uint8Array(u4.flashBytes);
pll.fill(0xff);
pll.set([
  0x02, 0xe1, 0x09, 0xbd, 0x19, 0xb5, 0x00, 0xe0, 0x09, 0xbd, 0x29, 0xb5, 0xff,
  0xcf,
]);
const pllBoard = new AvrBoard("pll", u4);
pllBoard.load(pll);
pllBoard.stepMillis();
expect(pllBoard.peekByte(17) === 0x13, "PLLE sets PLOCK");
expect(pllBoard.peekByte(18) === 0x00, "clearing PLLE clears PLOCK");

// Unknown chips are refused by name.
expect(chipSpec("atmega2560") === null, "no 2560 entry");
expect(chipSpec("toString") === null, "prototype keys are not chips");
throws(() => requireChipSpec("atmega2560"), /unsupported chip "atmega2560"/);

// A board takes its clock from the record.
const board = new AvrBoard("t", spec);
expect(
  board.hz === 16_000_000 && board.chip === spec,
  "board holds the record"
);
const none = new AvrBoard("t", null);
none.load(new Uint8Array(spec.flashBytes));
expect(!none.running && none.fault === "board has no chip", "no chip, no boot");

console.log(
  "chips: atmega328p record matches the constants it replaced; atmega32u4 record, PLL lock and refusals"
);
