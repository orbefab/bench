import type { PinMode, WorldPinState } from "@sfab-bench/contract";
import {
  AVRIOPort,
  type AVRPortConfig,
  AVRTimer,
  AVRUSART,
  avrInstruction,
  CPU,
} from "avr8js";
import { attachBoardAdc, type BoardAdcHooks } from "./board-adc";
import type { ChipSpec } from "./chips";

/** Registers a fresh CPU has before the first instruction. */
export type CpuResetRegs = {
  DDRB: number;
  PORTB: number;
  SREG: number;
  TCCR1A: number;
  TCCR1B: number;
  UCSR0A: number;
  UCSR0C: number;
};

/** Written into that board's ring when its `.hex` is loaded again. */
export const FIRMWARE_RELOADED = "— firmware reloaded —\n";

/**
 * Appended to the serial stream when a brownout ends and the CPU boots
 * from address 0. Earlier text stays in the ring ahead of this line.
 */
export const BROWNOUT_RESET = "— brownout reset —\n";

/** Pending USART0 RX bytes. A send that does not fit is refused whole. */
export const RX_BACKLOG = 4 * 1024;

/**
 * One AVR chip, built from its `ChipSpec`. `stepMillis` runs one sim
 * millisecond of instructions (`hz / 1000` cycles), then stops. The last
 * instruction may pass that budget; `overshoot` is how many extra cycles it
 * used, and the next millisecond runs that many fewer.
 *
 * The pin mapping here is still the Arduino Uno's (D0–D7 on port D, D8–D13
 * on B, A0–A5 on C). A chip whose ports are not B, C and D needs the
 * native pin table first.
 */
export class AvrBoard {
  readonly id: string;
  /** Null leaves a board that can only report a fault: it never mounts. */
  readonly chip: ChipSpec | null;
  running = false;
  fault?: string;
  /** Held in reset because the supply is under the chip's brownout voltage. */
  brownout = false;
  overshoot = 0;
  /** Bytes passed to USART0, one at a time, at the baud the firmware set. */
  rxAccepted = 0;
  /** Firmware image kept so a brownout can boot the same program again. */
  private image: Uint8Array | null = null;
  private cpu: CPU | null = null;
  private usart: AVRUSART | null = null;
  /** Held so the port and timer hooks stay attached for the life of the CPU. */
  private peripherals: unknown[] = [];
  /** The CPU's GPIO ports by letter. Empty while the CPU is down. */
  private ports = new Map<string, AVRIOPort>();
  /** Wire bit to the port and index it reaches. Empty while the CPU is down. */
  private slots: ({ port: AVRIOPort; index: number } | null)[] = [];
  /**
   * Bits that changed since the last `takePins`. Port listeners OR these
   * in; the state tick is the only place that reads the registers.
   */
  private toggled = 0;
  /** Arduino bits whose rising and falling edges are timed. */
  private edgeMask = 0;
  /** Cycle count at the start of the current `stepMillis`. */
  stepOrigin = 0;
  /** Port-bit changes during the current `stepMillis`, in order. */
  pinChanges: { bit: number; high: boolean; cycle: number }[] = [];
  /** Cycle count at the rising edge, keyed by Arduino bit. */
  private riseAt = new Map<number, number>();
  private pulses: { bit: number; us: number }[] = [];
  private rx: number[] = [];
  private tx = "";
  /**
   * Per Arduino bit: 0 = nothing else drives the wire, 1 = driven low,
   * 2 = driven high. A driven level wins over the pin's pull-up.
   */
  private driven = new Uint8Array(20);
  /**
   * The wiring layer fills `driven` when another output on the net
   * changes. Pull-ups themselves are applied here.
   */
  onPinsChanged: (() => void) | null = null;
  /**
   * A port write, at `cpu.cycles`. Null unless a part is listening.
   * Worlds with no listener skip the walk.
   */
  onEdge: ((bit: number, high: boolean, cycles: number) => void) | null = null;
  /**
   * Latest GPIO value reported by each port listener. avr8js copies
   * that value into PIN after the listener returns, so a same-port
   * read during the callback has to use this cache.
   */
  private liveLevel = new Map<AVRIOPort, number>();
  /**
   * Set before `load`. The ADC is attached on every mount, including a
   * brownout reboot. Null leaves the chip without an ADC peripheral.
   */
  private analog: BoardAdcHooks | null = null;

  /** Wire bit to the chip's own pin name, or null for a bit no pin reaches. */
  private readonly wire: readonly (string | null)[];

  /**
   * `chip` comes from `chipSpec`. A chip the emulator does not know is
   * null: the caller stops the board with its own message. `wire` says which
   * chip pin each of the 20 wire bits reaches; the planner builds it from the
   * board's `expose` table. The default is the Uno and Nano header.
   */
  constructor(
    id: string,
    chip: ChipSpec | null,
    wire: readonly (string | null)[] = ARDUINO_WIRE
  ) {
    this.id = id;
    this.chip = chip;
    this.wire = wire;
  }

  /** CPU clock, hertz. 0 on a board with no chip. */
  get hz(): number {
    return this.chip?.hz ?? 0;
  }

  get rxQueued(): number {
    return this.rx.length;
  }

  /** Call before `load`. Remounts pick up the same hooks. */
  setAnalog(hooks: BoardAdcHooks | null) {
    this.analog = hooks;
  }

  load(program: Uint8Array) {
    if (!this.chip) {
      this.stop("board has no chip");
      return;
    }
    if (program.length !== this.chip.flashBytes) {
      this.stop("firmware image is the wrong size");
      return;
    }
    this.image = program.slice();
    this.mount(program, false);
  }

  /**
   * Drop the CPU so every pin reads as an input with no drive. The image
   * and any serial not yet flushed stay, so `reboot` can start over.
   */
  holdInReset() {
    this.brownout = true;
    this.running = false;
    this.fault = undefined;
    this.cpu = null;
    this.usart = null;
    this.peripherals = [];
    this.ports = new Map();
    this.slots = [];
    this.toggled = 0;
    this.riseAt.clear();
    this.pulses = [];
    this.rx = [];
    this.overshoot = 0;
    this.liveLevel.clear();
  }

  /**
   * Boot the saved image from address 0: a fresh CPU, USART, and timers.
   * The brownout marker is appended in front of whatever the new program
   * prints. Serial that was already in `tx` stays ahead of the marker.
   */
  reboot(): boolean {
    if (!this.image) return false;
    // The previous run's wire levels are not the new CPU's. Nets are
    // resolved again by the caller once this image is mounted.
    this.driven.fill(0);
    this.tx += BROWNOUT_RESET;
    this.mount(this.image, true);
    return this.running;
  }

  private mount(program: Uint8Array, keepTx: boolean) {
    const chip = this.chip;
    if (!chip) {
      this.stop("board has no chip");
      return;
    }
    const keptTx = keepTx ? this.tx : "";
    this.liveLevel.clear();
    const words = new Uint16Array(chip.flashBytes / 2);
    for (let i = 0; i < words.length; i++) {
      const lo = program[i * 2] ?? 0xff;
      const hi = program[i * 2 + 1] ?? 0xff;
      words[i] = lo | (hi << 8);
    }
    const cpu = new CPU(words, chip.sramBytes);
    chip.onCpu?.(cpu);
    const ports = new Map<string, AVRIOPort>();
    for (const letter of Object.keys(chip.ports)) {
      ports.set(letter, new AVRIOPort(cpu, portConfigOf(chip, letter)));
    }
    const slots = this.wire.map((name) => {
      const pin = name === null ? undefined : chip.pins[name];
      const port = pin ? ports.get(pin.port) : undefined;
      return pin && port ? { port, index: pin.bit } : null;
    });
    for (const port of ports.values()) {
      const wired = new Map<number, number>();
      slots.forEach((slot, bit) => {
        if (slot?.port === port) wired.set(slot.index, bit);
      });
      this.watchPort(port, wired);
    }
    this.ports = ports;
    this.slots = slots;
    this.toggled = 0;
    this.riseAt.clear();
    this.pulses = [];
    const peripherals: unknown[] = [
      ...ports.values(),
      ...chip.timers.map((config) => new AVRTimer(cpu, config)),
    ];
    // The hook runs only when firmware writes ADCSRA, so a program that
    // never touches the ADC keeps the same cycle counts.
    if (this.analog) peripherals.push(attachBoardAdc(cpu, this.analog, chip));
    const usart = new AVRUSART(cpu, chip.usart, chip.hz);
    usart.onByteTransmit = (value) => {
      this.tx += String.fromCharCode(value & 0xff);
    };
    // The byte that just landed frees the shifter. The next queued byte
    // starts its own character time here, so a burst is not written at once.
    usart.onRxComplete = () => {
      this.pumpRx();
    };
    this.cpu = cpu;
    this.usart = usart;
    this.peripherals = peripherals;
    this.rx = [];
    this.tx = keptTx;
    this.overshoot = 0;
    this.rxAccepted = 0;
    this.fault = undefined;
    this.brownout = false;
    this.running = true;
    this.applyInputLevels();
  }

  stop(fault: string) {
    this.running = false;
    this.fault = fault;
    this.brownout = false;
    this.image = null;
    this.cpu = null;
    this.usart = null;
    this.peripherals = [];
    this.ports = new Map();
    this.slots = [];
    this.toggled = 0;
    this.riseAt.clear();
    this.pulses = [];
    this.rx = [];
    this.overshoot = 0;
    this.liveLevel.clear();
  }

  /**
   * DDR, level, and toggles for D0–D13 and A0–A5. Clears the toggle mask.
   * Call once per state tick. A stopped board reports zeros.
   */
  takePins(): WorldPinState {
    return this.readPins(true);
  }

  /**
   * Same snapshot as `takePins` without clearing toggles, so a recording
   * frame can sample pins and the state tick still sees every change.
   */
  peekPins(): WorldPinState {
    return this.readPins(false);
  }

  /** USART0 TX not yet taken. The recording reads the growth between flushes. */
  peekTx(): string {
    return this.tx;
  }

  private readPins(clear: boolean): WorldPinState {
    const toggled = this.toggled;
    if (clear) this.toggled = 0;
    const cpu = this.cpu;
    if (!cpu || this.slots.length === 0) {
      return { ddr: 0, level: 0, toggled: 0 };
    }
    const regs = new Map<AVRIOPort, { ddr: number; level: number }>();
    let ddr = 0;
    let level = 0;
    this.slots.forEach((slot, bit) => {
      if (!slot) return;
      let row = regs.get(slot.port);
      if (!row) {
        row = portRegs(cpu, slot.port);
        regs.set(slot.port, row);
      }
      if ((row.ddr >> slot.index) & 1) ddr |= 1 << bit;
      if ((row.level >> slot.index) & 1) level |= 1 << bit;
    });
    return { ddr, level, toggled };
  }

  /**
   * Time edges on this Arduino bit. The port listener already runs on a
   * pin write; this adds no per-instruction work. A servo is two edges
   * per 20 ms frame.
   */
  watchEdge(bit: number) {
    if (bit < 0 || bit > 19) return;
    this.edgeMask |= 1 << bit;
  }

  /** Completed pulses since the last take. Empty most milliseconds. */
  takePulses(): { bit: number; us: number }[] {
    if (this.pulses.length === 0) return [];
    const out = this.pulses;
    this.pulses = [];
    return out;
  }

  /** OR changed pin bits. Runs only when avr8js already noticed a port write. */
  private watchPort(port: AVRIOPort, wired: ReadonlyMap<number, number>) {
    port.addListener((value, oldValue) => {
      this.liveLevel.set(port, value);
      const cycles = this.cpu?.cycles;
      for (const [index, bit] of wired) {
        if (((value ^ oldValue) & (1 << index)) === 0) continue;
        const high = ((value >> index) & 1) === 1;
        this.toggled |= 1 << bit;
        this.noteEdge(bit, high);
        if (cycles !== undefined) {
          this.pinChanges.push({ bit, high, cycle: cycles });
          this.onEdge?.(bit, high, cycles);
        }
      }
      // A wired output is updated first, then this pin's pull-up, so
      // the next instruction's digitalRead sees the winner.
      this.onPinsChanged?.();
      this.applyInputLevels();
    });
  }

  /**
   * avr8js leaves pull-ups to the host. An input with PORT set and
   * nothing else driving the wire reads high. A wired output wins.
   */
  private applyInputLevels() {
    const cpu = this.cpu;
    if (!cpu || this.slots.length === 0) return;
    this.slots.forEach((slot, bit) => {
      if (!slot) return;
      const { port, index } = slot;
      const mask = 1 << index;
      const ddr = cpu.data[port.portConfig.DDR] ?? 0;
      if ((ddr & mask) !== 0) return;
      const written = cpu.data[port.portConfig.PORT] ?? 0;
      const external = this.driven[bit] ?? 0;
      const pullup = (written & mask) !== 0;
      const high = external === 2 ? true : external === 1 ? false : pullup;
      port.setPin(index, high);
    });
  }

  private pinIndex(bit: number): { port: AVRIOPort; index: number } | null {
    return this.slots[bit] ?? null;
  }

  /**
   * Pulse width is (fall − rise) cycles over the cycles in a microsecond
   * (16 at 16 MHz). Both edges use `cpu.cycles` at the port write.
   */
  private noteEdge(bit: number, high: boolean) {
    const cpu = this.cpu;
    if (!cpu || (this.edgeMask & (1 << bit)) === 0) return;
    if (high) {
      this.riseAt.set(bit, cpu.cycles);
      return;
    }
    const rise = this.riseAt.get(bit);
    this.riseAt.delete(bit);
    if (rise === undefined) return;
    const us = (cpu.cycles - rise) / (this.hz / 1_000_000);
    if (us < 0) return;
    this.pulses.push({ bit, us });
  }

  takeTx(): string {
    const text = this.tx;
    this.tx = "";
    return text;
  }

  /** False when `text` does not fit. Nothing is queued in that case. */
  pushRx(text: string): boolean {
    if (!this.running) return false;
    const bytes = new TextEncoder().encode(text);
    if (this.rx.length + bytes.length > RX_BACKLOG) return false;
    for (const byte of bytes) this.rx.push(byte);
    return true;
  }

  /**
   * A wire's output level, or null to leave the pin to its pull-up.
   * Ignored while this pin is itself an output.
   */
  /**
   * Run `fn` after `delayCycles` CPU cycles. avr8js adds at least one
   * cycle, so a delay of 0 fires on the next cycle. Returns false when
   * the CPU is down.
   */
  schedule(delayCycles: number, fn: () => void): boolean {
    const cpu = this.cpu;
    if (!cpu) return false;
    cpu.addClockEvent(fn, delayCycles);
    return true;
  }

  setDriven(bit: number, level: boolean | null) {
    if (bit < 0 || bit > 19) return;
    const next = level === null ? 0 : level ? 2 : 1;
    if (this.driven[bit] === next) return;
    this.driven[bit] = next;
    this.applyInputLevels();
  }

  /**
   * DDR and PORT, not the pin level. High is DDR and PORT set, low is
   * DDR set and PORT clear, pull-up is PORT set alone, input is neither.
   * An unmapped bit or a stopped CPU is an input.
   */
  driveMode(bit: number): PinMode {
    const found = this.pinIndex(bit);
    const cpu = this.cpu;
    if (!found || !cpu) return "input";
    const ddr = cpu.data[found.port.portConfig.DDR] ?? 0;
    const written = cpu.data[found.port.portConfig.PORT] ?? 0;
    const mask = 1 << found.index;
    if ((ddr & mask) !== 0) return (written & mask) !== 0 ? "high" : "low";
    return (written & mask) !== 0 ? "pullup" : "input";
  }

  /** Null while the CPU is down, including brownout reset. */
  peekRegs(): CpuResetRegs | null {
    const cpu = this.cpu;
    const io = this.chip?.io;
    if (!cpu || !io) return null;
    return {
      DDRB: cpu.data[io.DDRB] ?? 0,
      PORTB: cpu.data[io.PORTB] ?? 0,
      SREG: cpu.data[io.SREG] ?? 0,
      TCCR1A: cpu.data[io.TCCR1A] ?? 0,
      TCCR1B: cpu.data[io.TCCR1B] ?? 0,
      UCSR0A: cpu.data[io.UCSR0A] ?? 0,
      UCSR0C: cpu.data[io.UCSR0C] ?? 0,
    };
  }

  /** One data-space byte. Registers are addresses 0–31. Null if the CPU is down. */
  peekByte(addr: number): number | null {
    const cpu = this.cpu;
    if (!cpu || addr < 0) return null;
    return cpu.data[addr] ?? 0;
  }

  /**
   * Output level of an Arduino bit, or null when the pin is an input
   * or the CPU is down. DDR bits use the port listener's value when
   * one is cached: avr8js has not written PIN yet at that point.
   */
  outputLevel(bit: number): boolean | null {
    const found = this.pinIndex(bit);
    const cpu = this.cpu;
    if (!found || !cpu) return null;
    const ddr = cpu.data[found.port.portConfig.DDR] ?? 0;
    const mask = 1 << found.index;
    if ((ddr & mask) === 0) return null;
    const cached = this.liveLevel.get(found.port);
    const level =
      cached !== undefined
        ? cached
        : (cpu.data[found.port.portConfig.PIN] ?? 0);
    return (level & mask) !== 0;
  }

  /** CPU cycle counter. Equal to `stepOrigin` while the CPU is down. */
  cycles(): number {
    return this.cpu?.cycles ?? this.stepOrigin;
  }

  stepMillis() {
    const cpu = this.cpu;
    // Ports and timers stay reachable from this object, not only from CPU hooks.
    if (!this.running || !cpu || this.peripherals.length === 0) return;
    this.pinChanges = [];
    this.stepOrigin = cpu.cycles;
    const budget = this.hz / 1000 - this.overshoot;
    if (budget <= 0) {
      this.overshoot = -budget;
      return;
    }
    this.pumpRx();
    let ran = 0;
    while (ran < budget) {
      const before = cpu.cycles;
      avrInstruction(cpu);
      cpu.tick();
      const used = cpu.cycles - before;
      if (used <= 0) {
        this.stop("AVR instruction did not advance the cycle clock");
        return;
      }
      ran += used;
    }
    this.overshoot = ran - budget;
  }

  private pumpRx() {
    const usart = this.usart;
    if (!usart) return;
    while (this.rx.length > 0) {
      const next = this.rx[0];
      if (next === undefined) return;
      // False while RX is off (before Serial.begin) or a character is in flight.
      if (!usart.writeByte(next)) return;
      this.rx.shift();
      this.rxAccepted += 1;
    }
  }
}

/**
 * The wire's 20 bits on an Arduino Uno or Nano: D0 to D7 on port D, D8 to D13
 * on port B, A0 to A5 on port C. A board built from its `expose` table passes
 * its own.
 */
export const ARDUINO_WIRE: readonly (string | null)[] = [
  ...Array.from({ length: 8 }, (_, n) => `PD${n}`),
  ...Array.from({ length: 6 }, (_, n) => `PB${n}`),
  ...Array.from({ length: 6 }, (_, n) => `PC${n}`),
];

function portConfigOf(chip: ChipSpec, letter: string): AVRPortConfig {
  const config = chip.ports[letter];
  if (!config) throw new Error(`${chip.chip} has no port ${letter}`);
  return config;
}

/** PORT for output bits, PIN for input bits. Width is applied by the mask packer. */
function portRegs(cpu: CPU, port: AVRIOPort): { ddr: number; level: number } {
  const ddr = cpu.data[port.portConfig.DDR] ?? 0;
  const written = cpu.data[port.portConfig.PORT] ?? 0;
  const pin = cpu.data[port.portConfig.PIN] ?? 0;
  const level = (ddr & written) | (~ddr & pin);
  return { ddr, level };
}
