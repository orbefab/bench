// ATmega32U4 peripherals for avr8js. Register addresses and vectors are the
// 32U4's (Atmel-7766J / the device header): a word address is the vector
// number times two. Timer 4 and USB are not here; the spec names them as gaps.

import {
  type ADCConfig,
  ADCMuxInputType,
  ADCReference,
  type AVRPortConfig,
  type AVRTimerConfig,
  type CPU,
  PCINT0,
  portBConfig,
  timer0Config,
  timer1Config,
} from "avr8js";
import type { ChipPin, ChipSpec } from "./chips";

/** PLLCSR, data space. IO 0x29. PLOCK (bit 0) follows PLLE (bit 1). */
const PLLCSR = 0x49;
const PLLE = 0x02;
const PLOCK = 0x01;

/**
 * Arduino's USB start waits on PLOCK. avr8js has no PLL, so a write that
 * sets PLLE reports the lock in the same write. Clearing PLLE clears it.
 */
function lockPll(cpu: CPU): void {
  cpu.writeHooks[PLLCSR] = (value) => {
    const locked = (value & PLLE) !== 0 ? PLOCK : 0;
    cpu.data[PLLCSR] = (value & ~PLOCK) | locked;
    return true;
  };
}

const INT0: AVRPortConfig["externalInterrupts"][number] = {
  EICR: 0x69,
  EIMSK: 0x3d,
  EIFR: 0x3c,
  index: 0,
  iscOffset: 0,
  interrupt: 0x02,
};
const INT1: AVRPortConfig["externalInterrupts"][number] = {
  EICR: 0x69,
  EIMSK: 0x3d,
  EIFR: 0x3c,
  index: 1,
  iscOffset: 2,
  interrupt: 0x04,
};
const INT2: AVRPortConfig["externalInterrupts"][number] = {
  EICR: 0x69,
  EIMSK: 0x3d,
  EIFR: 0x3c,
  index: 2,
  iscOffset: 4,
  interrupt: 0x06,
};
const INT3: AVRPortConfig["externalInterrupts"][number] = {
  EICR: 0x69,
  EIMSK: 0x3d,
  EIFR: 0x3c,
  index: 3,
  iscOffset: 6,
  interrupt: 0x08,
};
/** INT6 is PE6, EICRB bits 5:4, vector 7. */
const INT6: AVRPortConfig["externalInterrupts"][number] = {
  EICR: 0x6a,
  EIMSK: 0x3d,
  EIFR: 0x3c,
  index: 6,
  iscOffset: 4,
  interrupt: 0x0e,
};

// Port B's PIN/DDR/PORT and PCINT0 register addresses match the 328P config.
// The vector does not (32U4 PCINT0 is vector 9, word address 0x12). Copy the
// pin-change object; the shared avr8js constant stays the 328P vector.
const portB: AVRPortConfig = {
  ...portBConfig,
  pinChange: { ...PCINT0, pinChangeInterrupt: 0x12 },
  externalInterrupts: [],
};
// Port C has no pin-change interrupt on this chip. PC6 and PC7 only.
const portC: AVRPortConfig = {
  PIN: 0x26,
  DDR: 0x27,
  PORT: 0x28,
  externalInterrupts: [],
};
// INT0–INT3 sit on PD0–PD3, not the 328P's PD2/PD3 layout.
const portD: AVRPortConfig = {
  PIN: 0x29,
  DDR: 0x2a,
  PORT: 0x2b,
  externalInterrupts: [INT0, INT1, INT2, INT3],
};
const portE: AVRPortConfig = {
  PIN: 0x2c,
  DDR: 0x2d,
  PORT: 0x2e,
  externalInterrupts: [null, null, null, null, null, null, INT6],
};
const portF: AVRPortConfig = {
  PIN: 0x2f,
  DDR: 0x30,
  PORT: 0x31,
  externalInterrupts: [],
};

// Timer 0 register addresses match the 328P. Vectors and pins do not.
// OC0A = PB7, OC0B = PD0, T0 = PD7. Vectors 21, 22, 23.
const timer0: AVRTimerConfig = {
  ...timer0Config,
  compAInterrupt: 0x2a,
  compBInterrupt: 0x2c,
  ovfInterrupt: 0x2e,
  compPortA: portB.PORT,
  compPinA: 7,
  compPortB: portD.PORT,
  compPinB: 0,
  externalClockPort: portD.PORT,
  externalClockPin: 7,
};

// Timer 1: OC1A/B/C = PB5/PB6/PB7, T1 = PD6. OCR1C is 0x8c. Vectors 16–20.
const timer1: AVRTimerConfig = {
  ...timer1Config,
  captureInterrupt: 0x20,
  compAInterrupt: 0x22,
  compBInterrupt: 0x24,
  compCInterrupt: 0x26,
  ovfInterrupt: 0x28,
  OCRC: 0x8c,
  OCFC: 8,
  OCIEC: 8,
  compPortA: portB.PORT,
  compPinA: 5,
  compPortB: portB.PORT,
  compPinB: 6,
  compPortC: portB.PORT,
  compPinC: 7,
  externalClockPort: portD.PORT,
  externalClockPin: 6,
};

// Timer 3 is the timer-1 shape at the 32U4 addresses. Only OC3A (PC6) is a pin.
// Vectors 31–35. No external clock.
const timer3: AVRTimerConfig = {
  ...timer1Config,
  captureInterrupt: 0x3e,
  compAInterrupt: 0x40,
  compBInterrupt: 0x42,
  compCInterrupt: 0x44,
  ovfInterrupt: 0x46,
  TIFR: 0x38,
  OCRA: 0x98,
  OCRB: 0x9a,
  OCRC: 0x9c,
  ICR: 0x96,
  TCNT: 0x94,
  TCCRA: 0x90,
  TCCRB: 0x91,
  TCCRC: 0x92,
  TIMSK: 0x71,
  OCFC: 8,
  OCIEC: 8,
  compPortA: portC.PORT,
  compPinA: 6,
  compPortB: 0,
  compPinB: 0,
  compPortC: 0,
  compPinC: 0,
  externalClockPort: 0,
  externalClockPin: 0,
};

/** USART1, the console (Serial1). Vectors 25, 26, 27. */
const usart1 = {
  rxCompleteInterrupt: 0x32,
  dataRegisterEmptyInterrupt: 0x34,
  txCompleteInterrupt: 0x36,
  UCSRA: 0xc8,
  UCSRB: 0xc9,
  UCSRC: 0xca,
  UBRRL: 0xcc,
  UBRRH: 0xcd,
  UDR: 0xce,
};

/**
 * ADC. Same register addresses as the 328P, vector 29. MUX5 (ADCSRB bit 3)
 * makes avr8js OR 0x20 into the channel, so the mask keeps that bit.
 * Channels 8–13 are mux 0x20–0x25. ADC2 and ADC3 do not exist. Mux 0x1e is
 * the 1.1 V bandgap (Table 8-3, typical). Mux 0x27 is the temperature sensor;
 * it is omitted so a conversion there reads 0 rather than the 328P's 314 mV.
 * REFS 11 is the internal 2.56 V reference (Table 29-7, VINT typical).
 */
const adc: ADCConfig = {
  ADMUX: 0x7c,
  ADCSRA: 0x7a,
  ADCSRB: 0x7b,
  ADCL: 0x78,
  ADCH: 0x79,
  DIDR0: 0x7e,
  adcInterrupt: 0x3a,
  numChannels: 14,
  muxInputMask: 0x3f,
  muxChannels: {
    0: { type: ADCMuxInputType.SingleEnded, channel: 0 },
    1: { type: ADCMuxInputType.SingleEnded, channel: 1 },
    4: { type: ADCMuxInputType.SingleEnded, channel: 4 },
    5: { type: ADCMuxInputType.SingleEnded, channel: 5 },
    6: { type: ADCMuxInputType.SingleEnded, channel: 6 },
    7: { type: ADCMuxInputType.SingleEnded, channel: 7 },
    0x1e: { type: ADCMuxInputType.Constant, voltage: 1.1 },
    0x1f: { type: ADCMuxInputType.Constant, voltage: 0 },
    0x20: { type: ADCMuxInputType.SingleEnded, channel: 8 },
    0x21: { type: ADCMuxInputType.SingleEnded, channel: 9 },
    0x22: { type: ADCMuxInputType.SingleEnded, channel: 10 },
    0x23: { type: ADCMuxInputType.SingleEnded, channel: 11 },
    0x24: { type: ADCMuxInputType.SingleEnded, channel: 12 },
    0x25: { type: ADCMuxInputType.SingleEnded, channel: 13 },
  },
  adcReferences: [
    ADCReference.AREF,
    ADCReference.AVCC,
    ADCReference.Reserved,
    ADCReference.Internal2V56,
  ],
};

/**
 * Bonded GPIO only. PC0–PC5, PE0, PE1, PE3–PE5, PF2 and PF3 are not on the
 * product pinout (datasheet sections 2.2.4, 2.2.6, 2.2.7). XTAL1 and XTAL2
 * are not GPIO: the clock is the 16 MHz parameter.
 */
function gpio(
  rows: readonly (readonly [string, string])[]
): Record<string, ChipPin> {
  const pins: Record<string, ChipPin> = {};
  for (const [port, bits] of rows) {
    for (const ch of bits) {
      const bit = Number(ch);
      pins[`P${port}${bit}`] = { port, bit };
    }
  }
  return pins;
}

export const ATMEGA32U4: ChipSpec = {
  chip: "atmega32u4",
  hz: 16_000_000,
  flashBytes: 32 * 1024,
  /** 2.5 KB, data space 0x0100–0x0AFF. */
  sramBytes: 2560,
  ports: { B: portB, C: portC, D: portD, E: portE, F: portF },
  timers: [timer0, timer1, timer3],
  usart: usart1,
  adc,
  // ChipIo keeps the 328P field names. UCSR0A and UCSR0C are USART1 here,
  // the console the reset check reads.
  io: {
    DDRB: 0x24,
    PORTB: 0x25,
    SREG: 0x5f,
    TCCR1A: 0x80,
    TCCR1B: 0x81,
    UCSR0A: 0xc8,
    UCSR0C: 0xca,
  },
  pins: gpio([
    ["B", "01234567"],
    ["C", "67"],
    ["D", "01234567"],
    ["E", "26"],
    ["F", "014567"],
  ]),
  adcPins: {
    0: "PF0",
    1: "PF1",
    4: "PF4",
    5: "PF5",
    6: "PF6",
    7: "PF7",
    8: "PD4",
    9: "PD6",
    10: "PD7",
    11: "PB4",
    12: "PB5",
    13: "PB6",
  },
  onCpu: lockPll,
  gaps: [
    {
      code: "timer4",
      message:
        "ATmega32U4 timer 4 is not emulated: PWM on that timer stays GPIO",
    },
    {
      code: "usb-cdc",
      message:
        "ATmega32U4 USB CDC is not emulated: " +
        "Serial prints nothing; use Serial1",
    },
  ],
};
