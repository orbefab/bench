import {
  type ADCConfig,
  type AVRPortConfig,
  type AVRTimerConfig,
  type AVRUSART,
  adcConfig,
  type CPU,
  portBConfig,
  portCConfig,
  portDConfig,
  timer0Config,
  timer1Config,
  timer2Config,
  usart0Config,
} from "avr8js";

/** A native pin: the chip's own name for it lives in `ChipSpec.pins`. */
export type ChipPin = {
  /** Port letter, a key of `ChipSpec.ports`. */
  port: string;
  bit: number;
};

/** Data-space addresses the reset check reads. Names are the 328P's. */
export type ChipIo = {
  DDRB: number;
  PORTB: number;
  SREG: number;
  TCCR1A: number;
  TCCR1B: number;
  UCSR0A: number;
  UCSR0C: number;
};

/**
 * What the emulator knows about one chip, and nothing electrical. The
 * rail, V_RST and brownout live on the chip part.
 *
 * A second chip is a second entry. Its extra ports (E, F) are more keys in
 * `ports`, its timers are the list it has (0, 1, 3), `usart` is the console
 * USART (USART1 on the 32U4), and `adc` carries its mux table. A register
 * the core needs poked at boot, such as the 32U4 USB PLL lock, goes in
 * `onCpu`, which runs on every fresh CPU before the first instruction.
 */
export type ChipSpec = {
  chip: string;
  /** CPU clock, hertz. */
  hz: number;
  /** Flash, bytes. */
  flashBytes: number;
  /** SRAM, bytes, not counting the register and I/O space. */
  sramBytes: number;
  /** GPIO port configs by port letter. */
  ports: Readonly<Record<string, AVRPortConfig>>;
  /** Timers in numeric order. */
  timers: readonly AVRTimerConfig[];
  /** The console USART. */
  usart: ConstructorParameters<typeof AVRUSART>[1];
  adc: ADCConfig;
  io: ChipIo;
  /** Native pin name to port and bit. */
  pins: Readonly<Record<string, ChipPin>>;
  /** Write hooks and other setup for a fresh CPU. Absent on the 328P. */
  onCpu?: (cpu: CPU) => void;
};

function pinTable(
  ports: Readonly<Record<string, number>>
): Record<string, ChipPin> {
  const pins: Record<string, ChipPin> = {};
  for (const [port, width] of Object.entries(ports)) {
    for (let bit = 0; bit < width; bit++) {
      pins[`P${port}${bit}`] = { port, bit };
    }
  }
  return pins;
}

const ATMEGA328P: ChipSpec = {
  chip: "atmega328p",
  hz: 16_000_000,
  flashBytes: 32 * 1024,
  sramBytes: 2048,
  ports: { B: portBConfig, C: portCConfig, D: portDConfig },
  timers: [timer0Config, timer1Config, timer2Config],
  usart: usart0Config,
  adc: adcConfig,
  io: {
    DDRB: 0x24,
    PORTB: 0x25,
    SREG: 0x5f,
    TCCR1A: 0x80,
    TCCR1B: 0x81,
    UCSR0A: 0xc0,
    UCSR0C: 0xc2,
  },
  pins: pinTable({ B: 8, C: 7, D: 8 }),
};

const CHIPS: Readonly<Record<string, ChipSpec>> = {
  atmega328p: ATMEGA328P,
};

/** The record for a chip type, or null when the emulator does not know it. */
export function chipSpec(chip: string): ChipSpec | null {
  return Object.hasOwn(CHIPS, chip) ? (CHIPS[chip] ?? null) : null;
}

/** As `chipSpec`, but an unknown chip throws with its name. */
export function requireChipSpec(chip: string): ChipSpec {
  const spec = chipSpec(chip);
  if (!spec) throw new Error(`unsupported chip "${chip}"`);
  return spec;
}
