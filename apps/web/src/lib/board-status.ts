import {
  ATMEGA328P_16MHZ_MIN_V,
  atmega328pSoaWarning,
} from "@sfab-bench/contract";

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

/**
 * The same line for a scrubbed frame. `belowSoa` is the window flag.
 * `supplyId` is this board's feed from `powerFeeds`; another rail in
 * the band is not this board's voltage.
 */
export function recordedSoaLine(
  belowSoa: boolean | undefined,
  supplies: Record<string, { voltage: number; minVoltage: number }> | undefined,
  supplyId: string | null | undefined,
  brownoutVoltage = 2.7
): string {
  if (!belowSoa) return "";
  const brownout = brownoutVoltage;
  const row = supplyId ? supplies?.[supplyId] : undefined;
  if (row) {
    const voltage =
      row.minVoltage > brownout && row.minVoltage < ATMEGA328P_16MHZ_MIN_V
        ? row.minVoltage
        : row.voltage;
    const warning = atmega328pSoaWarning(voltage, brownout);
    if (warning) return warning.message;
  }
  return "supply was below the 3.78 V the ATmega328P needs at 16 MHz";
}
