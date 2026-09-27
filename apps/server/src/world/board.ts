import type { WorldPinState } from "@sfab-bench/contract";
import { arduinoPinMask } from "@sfab-bench/contract";
import {
  AVRIOPort,
  AVRTimer,
  AVRUSART,
  avrInstruction,
  CPU,
  portBConfig,
  portCConfig,
  portDConfig,
  timer0Config,
  timer1Config,
  timer2Config,
  usart0Config,
} from "avr8js";

import { attachBoardAdc, type BoardAdcHooks } from "./board-adc";
import type { PinMode } from "./circuit/pin";
import { FLASH_BYTES } from "./ihex";

/** ATmega328P is clocked at 16 MHz. One sim millisecond is 16 000 cycles. */
export const CPU_HZ = 16_000_000;
export const CYCLES_PER_MS = 16_000;
/** ATmega328P SRAM, not counting the 256-byte register/IO space. */
const SRAM_BYTES = 2048;

/** I/O data-space addresses on the ATmega328P. */
const IO = {
  DDRB: 0x24,
  PORTB: 0x25,
  SREG: 0x5f,
  TCCR1A: 0x80,
  TCCR1B: 0x81,
  UCSR0A: 0xc0,
  UCSR0C: 0xc2,
} as const;

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
 * One ATmega328P. `stepMillis` runs CYCLES_PER_MS of instructions, then
 * stops. The last instruction may pass that budget; `overshoot` is how
 * many extra cycles it used, and the next millisecond runs that many fewer.
 */
export class AvrBoard {
  readonly id: string;
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
  private portB: AVRIOPort | null = null;
  private portC: AVRIOPort | null = null;
  private portD: AVRIOPort | null = null;
  /**
   * Bits that changed since the last `takePins`. Port listeners OR these
   * in; the state tick is the only place that reads the registers.
   */
  private toggled = 0;
  /** Arduino bits whose rising and falling edges are timed. */
  private edgeMask = 0;
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
  onEdge: ((bit: number, high: boolean, cycles: number) => void) | null =
    null;
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

  constructor(id: string) {
    this.id = id;
  }

  get rxQueued(): number {
    return this.rx.length;
  }

  /** Call before `load`. Remounts pick up the same hooks. */
  setAnalog(hooks: BoardAdcHooks | null) {
    this.analog = hooks;
  }

  load(program: Uint8Array) {
    if (program.length !== FLASH_BYTES) {
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
    this.portB = null;
    this.portC = null;
    this.portD = null;
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
    const keptTx = keepTx ? this.tx : "";
    this.liveLevel.clear();
    const words = new Uint16Array(FLASH_BYTES / 2);
    for (let i = 0; i < words.length; i++) {
      const lo = program[i * 2] ?? 0xff;
      const hi = program[i * 2 + 1] ?? 0xff;
      words[i] = lo | (hi << 8);
    }
    const cpu = new CPU(words, SRAM_BYTES);
    const portB = new AVRIOPort(cpu, portBConfig);
    const portC = new AVRIOPort(cpu, portCConfig);
    const portD = new AVRIOPort(cpu, portDConfig);
    this.watchPort(portD, 0, 8);
    this.watchPort(portB, 8, 6);
    this.watchPort(portC, 14, 6);
    this.portB = portB;
    this.portC = portC;
    this.portD = portD;
    this.toggled = 0;
    this.riseAt.clear();
    this.pulses = [];
    const peripherals: unknown[] = [
      portB,
      portC,
      portD,
      new AVRTimer(cpu, timer0Config),
      new AVRTimer(cpu, timer1Config),
      new AVRTimer(cpu, timer2Config),
    ];
    // The hook runs only when firmware writes ADCSRA, so a program that
    // never touches the ADC keeps the same cycle counts.
    if (this.analog) peripherals.push(attachBoardAdc(cpu, this.analog));
    const usart = new AVRUSART(cpu, usart0Config, CPU_HZ);
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
    this.portB = null;
    this.portC = null;
    this.portD = null;
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
    const portB = this.portB;
    const portC = this.portC;
    const portD = this.portD;
    if (!cpu || !portB || !portC || !portD) {
      return { ddr: 0, level: 0, toggled: 0 };
    }
    const d = portRegs(cpu, portD);
    const b = portRegs(cpu, portB);
    const c = portRegs(cpu, portC);
    return {
      ddr: arduinoPinMask(d.ddr, b.ddr, c.ddr),
      level: arduinoPinMask(d.level, b.level, c.level),
      toggled,
    };
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
  private watchPort(port: AVRIOPort, shift: number, width: number) {
    const mask = (1 << width) - 1;
    port.addListener((value, oldValue) => {
      this.liveLevel.set(port, value);
      const changed = (value ^ oldValue) & mask;
      if (changed !== 0) {
        this.toggled |= changed << shift;
        this.noteEdges(changed, shift, value);
        const cycles = this.cpu?.cycles;
        if (this.onEdge && cycles !== undefined) {
          for (let index = 0; index < width; index++) {
            if ((changed & (1 << index)) === 0) continue;
            const high = ((value >> index) & 1) === 1;
            this.onEdge(shift + index, high, cycles);
          }
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
    const portB = this.portB;
    const portC = this.portC;
    const portD = this.portD;
    if (!cpu || !portB || !portC || !portD) return;
    this.applyPort(portD, 0, 8);
    this.applyPort(portB, 8, 6);
    this.applyPort(portC, 14, 6);
  }

  private applyPort(port: AVRIOPort, shift: number, width: number) {
    const cpu = this.cpu;
    if (!cpu) return;
    const ddr = cpu.data[port.portConfig.DDR] ?? 0;
    const written = cpu.data[port.portConfig.PORT] ?? 0;
    for (let index = 0; index < width; index++) {
      const mask = 1 << index;
      if ((ddr & mask) !== 0) continue;
      const external = this.driven[shift + index] ?? 0;
      const pullup = (written & mask) !== 0;
      const high = external === 2 ? true : external === 1 ? false : pullup;
      port.setPin(index, high);
    }
  }

  private pinIndex(bit: number): { port: AVRIOPort; index: number } | null {
    if (bit >= 0 && bit <= 7 && this.portD) {
      return { port: this.portD, index: bit };
    }
    if (bit >= 8 && bit <= 13 && this.portB) {
      return { port: this.portB, index: bit - 8 };
    }
    if (bit >= 14 && bit <= 19 && this.portC) {
      return { port: this.portC, index: bit - 14 };
    }
    return null;
  }

  /**
   * Pulse width is (fall − rise) / 16. The CPU is 16 MHz, so 16 cycles
   * are one microsecond. Both edges use `cpu.cycles` at the port write.
   */
  private noteEdges(changed: number, shift: number, value: number) {
    const cpu = this.cpu;
    if (!cpu || this.edgeMask === 0) return;
    for (let index = 0; index < 8; index++) {
      if ((changed & (1 << index)) === 0) continue;
      const bit = shift + index;
      if ((this.edgeMask & (1 << bit)) === 0) continue;
      const now = (value >> index) & 1;
      if (now === 1) {
        this.riseAt.set(bit, cpu.cycles);
        continue;
      }
      const rise = this.riseAt.get(bit);
      this.riseAt.delete(bit);
      if (rise === undefined) continue;
      const us = (cpu.cycles - rise) / 16;
      if (us < 0) continue;
      this.pulses.push({ bit, us });
    }
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
    if (!cpu) return null;
    return {
      DDRB: cpu.data[IO.DDRB] ?? 0,
      PORTB: cpu.data[IO.PORTB] ?? 0,
      SREG: cpu.data[IO.SREG] ?? 0,
      TCCR1A: cpu.data[IO.TCCR1A] ?? 0,
      TCCR1B: cpu.data[IO.TCCR1B] ?? 0,
      UCSR0A: cpu.data[IO.UCSR0A] ?? 0,
      UCSR0C: cpu.data[IO.UCSR0C] ?? 0,
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

  stepMillis() {
    const cpu = this.cpu;
    // Ports and timers stay reachable from this object, not only from CPU hooks.
    if (!this.running || !cpu || this.peripherals.length === 0) return;
    const budget = CYCLES_PER_MS - this.overshoot;
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

/** PORT for output bits, PIN for input bits. Width is applied by the mask packer. */
function portRegs(cpu: CPU, port: AVRIOPort): { ddr: number; level: number } {
  const ddr = cpu.data[port.portConfig.DDR] ?? 0;
  const written = cpu.data[port.portConfig.PORT] ?? 0;
  const pin = cpu.data[port.portConfig.PIN] ?? 0;
  const level = (ddr & written) | (~ddr & pin);
  return { ddr, level };
}
