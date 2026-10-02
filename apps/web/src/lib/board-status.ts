import { atmega328pSoaWarning } from "@sfab-bench/contract";

type BoardStatusInput = {
  running: boolean;
  fault?: string;
  brownout?: boolean;
  /** No supply reaches the board, so the CPU never boots. */
  unpowered?: boolean;
};

/** What the board header says. `running` means the sim is playing, not merely loaded. */
export function boardStatusLabel(
  board: BoardStatusInput | undefined,
  playing: boolean
): "" | "paused" | "running" | "stopped" | "in reset" | "unpowered" {
  if (!board) return "";
  if (board.unpowered) return "unpowered";
  if (board.brownout) return "in reset";
  if (!board.running || board.fault) return "stopped";
  return playing ? "running" : "paused";
}

/**
 * Status of a scrubbed frame. The frame has no play bit, so a loaded
 * board reads as running rather than as the live run's pause.
 */
export function scrubbedBoardStatus(
  board: BoardStatusInput | undefined
): "" | "running" | "stopped" | "in reset" | "unpowered" {
  if (!board) return "";
  if (board.unpowered) return "unpowered";
  if (board.brownout) return "in reset";
  if (!board.running || board.fault) return "stopped";
  return "running";
}

/** One line under the board status. Empty when the supply is in spec. */
export function boardWarningLine(
  warnings: readonly { message: string }[] | undefined
): string {
  return warnings?.[0]?.message ?? "";
}

/** Brownout and SOA floor from the board view. Both are volts. */
export type SoaFacts = {
  brownoutVoltage?: number;
  /** Null when the chip publishes no floor. */
  minOperatingVoltage?: number | null;
};

/**
 * The same line for a scrubbed frame. `belowSoa` is the window flag.
 * The voltage is this board's 5V node, not the supply terminal.
 * The thresholds come from the view. Missing facts produce no line.
 */
export function recordedSoaLine(
  belowSoa: boolean | undefined,
  board: { voltage: number; minVoltage: number } | undefined,
  facts?: SoaFacts
): string {
  if (!belowSoa) return "";
  const brownout = facts?.brownoutVoltage;
  const floor = facts?.minOperatingVoltage;
  if (brownout === undefined || floor == null) return "";
  if (board) {
    const voltage =
      board.minVoltage > brownout && board.minVoltage < floor
        ? board.minVoltage
        : board.voltage;
    const warning = atmega328pSoaWarning(voltage, brownout, floor);
    if (warning) return warning.message;
  }
  const shown = floor.toFixed(2);
  return `supply was below the ${shown} V the ATmega328P needs at 16 MHz`;
}
