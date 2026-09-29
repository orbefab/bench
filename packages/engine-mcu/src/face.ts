// L2 face over AvrBoard. avr8js stays behind this package.
import {
  ATMEGA328P_BROWNOUT_V,
  arduinoPinBit,
  type Engine,
} from "@sfab-bench/contract";
import { AvrBoard } from "./board";

/** Flash image and the brownout threshold. Supply starts at 5 V. */
export type McuEngineSpec = {
  firmware: Uint8Array;
  /** Volts. The CPU is held in reset below this. Default 2.7. */
  brownoutVoltage?: number;
};

const LOGIC_HIGH = 0.6;

/**
 * Port face of one ATmega328P.
 * `supply.voltage` is the rail. A pin's `voltage` is its drive, or the
 * voltage written onto an input. `serial.tx` is the next USART byte
 * (0–255, or −1 when the buffer is empty) and `serial.rx` accepts one.
 */
export class McuEngine implements Engine {
  readonly id: string;
  private board: AvrBoard | null = null;
  private supply = 5;
  private brownoutVoltage = ATMEGA328P_BROWNOUT_V;
  private ms = 0;
  private pendingTx = "";
  private readonly pinVolts = new Map<number, number>();

  constructor(id = "mcu") {
    this.id = id;
  }

  init(spec: unknown): void {
    const parsed = mcuSpec(spec);
    this.brownoutVoltage = parsed.brownoutVoltage ?? ATMEGA328P_BROWNOUT_V;
    this.supply = 5;
    this.ms = 0;
    this.pendingTx = "";
    this.pinVolts.clear();
    const board = new AvrBoard(this.id);
    this.board = board;
    board.load(parsed.firmware);
    this.applySupply();
  }

  advance(toSeconds: number): void {
    const board = this.need();
    const target = Math.round(toSeconds * 1000);
    while (this.ms < target) {
      this.applySupply();
      if (!board.brownout) board.stepMillis();
      this.ms += 1;
    }
  }

  read(port: string, quantity: string): number {
    const board = this.need();
    if (port === "serial" && quantity === "tx") {
      if (this.pendingTx.length === 0) this.pendingTx = board.takeTx();
      if (this.pendingTx.length === 0) return -1;
      const byte = this.pendingTx.charCodeAt(0) & 0xff;
      this.pendingTx = this.pendingTx.slice(1);
      return byte;
    }
    if (port === "supply" && quantity === "voltage") return this.supply;
    const bit = pinBit(port);
    if (quantity !== "voltage") {
      throw new Error(`mcu engine has no quantity ${quantity}`);
    }
    const mode = board.driveMode(bit);
    if (mode === "high") return this.supply;
    if (mode === "low") return 0;
    const external = this.pinVolts.get(bit);
    if (external !== undefined) return external;
    return mode === "pullup" ? this.supply : 0;
  }

  write(port: string, quantity: string, value: number): void {
    const board = this.need();
    if (port === "supply" && quantity === "voltage") {
      this.supply = value;
      this.applySupply();
      return;
    }
    if (port === "serial" && quantity === "rx") {
      const byte = value & 0xff;
      board.pushRx(String.fromCharCode(byte));
      return;
    }
    const bit = pinBit(port);
    if (quantity !== "voltage") {
      throw new Error(`mcu engine cannot write ${port}.${quantity}`);
    }
    this.pinVolts.set(bit, value);
    const high = value >= LOGIC_HIGH * Math.max(this.supply, 1e-9);
    board.setDriven(bit, high);
  }

  dispose(): void {
    this.board?.stop("disposed");
    this.board = null;
    this.pendingTx = "";
    this.pinVolts.clear();
  }

  private applySupply(): void {
    const board = this.board;
    if (!board) return;
    if (this.supply < this.brownoutVoltage) {
      if (!board.brownout) board.holdInReset();
      return;
    }
    if (board.brownout) board.reboot();
  }

  private need(): AvrBoard {
    if (!this.board) throw new Error("mcu engine is not initialised");
    return this.board;
  }
}

function pinBit(port: string): number {
  const bit = arduinoPinBit(port);
  if (bit === undefined) throw new Error(`mcu engine has no port ${port}`);
  return bit;
}

function mcuSpec(spec: unknown): McuEngineSpec {
  if (!spec || typeof spec !== "object") {
    throw new Error("mcu engine spec is missing");
  }
  const row = spec as McuEngineSpec;
  if (!(row.firmware instanceof Uint8Array)) {
    throw new Error("mcu engine spec needs a firmware image");
  }
  return row;
}
