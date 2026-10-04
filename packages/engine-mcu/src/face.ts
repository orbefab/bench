// L2 face over AvrBoard. avr8js stays behind this package.
import type { Engine } from "@sfab-bench/contract";
import { AvrBoard } from "./board";
import { requireChipSpec } from "./chips";

/** Chip, flash image, brownout threshold, and the board pin list. Supply starts at 5 V. */
export type McuEngineSpec = {
  /** Chip registry key, e.g. `atmega328p` or `atmega32u4`. */
  chip: string;
  firmware: Uint8Array;
  /**
   * Volts. The CPU is held in reset below this. The caller passes the
   * chip's `brownoutVoltage`. Omitted means this engine does not brown out.
   */
  brownoutVoltage?: number;
  /** Chip pin per exposed header, in pin-state order. Absent is no GPIO. */
  wire?: readonly string[];
  /** Header names in that same order. `read` and `write` use these. */
  pins?: readonly string[];
  /**
   * A header's input edges at `supply` volts, from its port's `vil` / `vih`.
   * Required to `write` a pin voltage.
   */
  edges?: (pin: string, supply: number) => PinEdges;
};

/** Volts. Low below `vil`, high above `vih`; between them the level holds. */
export type PinEdges = { vil: number | null; vih: number | null };

/**
 * Port face of one registered AVR chip.
 * `supply.voltage` is the rail. A pin's `voltage` is its drive, or the
 * voltage written onto an input; its `level` (1 or 0) is what the CPU
 * reads from that voltage. `serial.tx` is the next USART byte
 * (0–255, or −1 when the buffer is empty) and `serial.rx` accepts one.
 */
export class McuEngine implements Engine {
  readonly id: string;
  private board: AvrBoard | null = null;
  private supply = 5;
  private brownoutVoltage = Number.POSITIVE_INFINITY;
  private ms = 0;
  private pendingTx = "";
  private pins: readonly string[] = [];
  private readonly pinVolts = new Map<number, number>();
  private readonly levels = new Map<number, boolean>();
  private edges: McuEngineSpec["edges"] = undefined;

  constructor(id = "mcu") {
    this.id = id;
  }

  init(spec: unknown): void {
    const parsed = mcuSpec(spec);
    this.brownoutVoltage = parsed.brownoutVoltage ?? Number.POSITIVE_INFINITY;
    this.supply = 5;
    this.ms = 0;
    this.pendingTx = "";
    this.pins = parsed.pins ?? [];
    this.pinVolts.clear();
    this.levels.clear();
    this.edges = parsed.edges;
    const board = new AvrBoard(
      this.id,
      requireChipSpec(parsed.chip),
      parsed.wire ?? []
    );
    this.board = board;
    board.load(parsed.firmware);
    this.applySupply();
  }

  advance(toSeconds: number): void {
    const board = this.need();
    const target = Math.round(toSeconds * 1000);
    while (this.ms < target) {
      this.applySupply();
      if (!board.inReset) board.stepMillis();
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
    const bit = this.pinBit(port);
    if (quantity === "level") return this.levels.get(bit) ? 1 : 0;
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
    const bit = this.pinBit(port);
    if (quantity !== "voltage") {
      throw new Error(`mcu engine cannot write ${port}.${quantity}`);
    }
    const edges = this.edges?.(port, this.supply);
    if (!edges) throw new Error(`mcu engine has no input edges for ${port}`);
    this.pinVolts.set(bit, value);
    const previous = this.levels.get(bit) ?? false;
    const high =
      edges.vih !== null && value > edges.vih
        ? true
        : edges.vil !== null && value < edges.vil
          ? false
          : previous;
    this.levels.set(bit, high);
    board.setDriven(bit, high);
  }

  dispose(): void {
    this.board?.stop("disposed");
    this.board = null;
    this.pendingTx = "";
    this.pinVolts.clear();
    this.levels.clear();
  }

  private applySupply(): void {
    const board = this.board;
    if (!board) return;
    if (this.supply < this.brownoutVoltage) {
      if (!board.inReset) board.holdInReset();
      return;
    }
    if (board.inReset) board.reboot();
  }

  private need(): AvrBoard {
    if (!this.board) throw new Error("mcu engine is not initialised");
    return this.board;
  }

  private pinBit(port: string): number {
    const bit = this.pins.indexOf(port);
    if (bit < 0) throw new Error(`mcu engine has no port ${port}`);
    return bit;
  }
}

function mcuSpec(spec: unknown): McuEngineSpec {
  if (!spec || typeof spec !== "object") {
    throw new Error("mcu engine spec is missing");
  }
  const row = spec as McuEngineSpec;
  if (typeof row.chip !== "string") {
    throw new Error("mcu engine spec needs a chip");
  }
  if (!(row.firmware instanceof Uint8Array)) {
    throw new Error("mcu engine spec needs a firmware image");
  }
  return row;
}
