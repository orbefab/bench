import {
  type ChipClock,
  type ResetCause,
  soaNeed,
  soaWarning,
} from "@sfab-bench/contract";

type BoardStatusInput = {
  running: boolean;
  fault?: string;
  inReset?: boolean;
  /** Live only: what holds the chip while `inReset`. */
  resetCause?: ResetCause;
  /** No supply reaches the board, so the CPU never boots. */
  unpowered?: boolean;
};

type InResetLabel = "in reset" | "in reset (RESET pin)" | "in reset (brownout)";

/** "in reset", naming what holds the chip when the live state says. */
function inResetLabel(cause: ResetCause | undefined): InResetLabel {
  if (cause === "pin") return "in reset (RESET pin)";
  if (cause === "brownout") return "in reset (brownout)";
  return "in reset";
}

/** What the board header says. `running` means the sim is playing, not merely loaded. */
export function boardStatusLabel(
  board: BoardStatusInput | undefined,
  playing: boolean
): "" | "paused" | "running" | "stopped" | InResetLabel | "unpowered" {
  if (!board) return "";
  if (board.unpowered) return "unpowered";
  if (board.inReset) return inResetLabel(board.resetCause);
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
  if (board.inReset) return "in reset";
  if (!board.running || board.fault) return "stopped";
  return "running";
}

/**
 * Lines under the board status, one per distinct warning: the supply
 * band and each gap the chip names (the Pro Micro's timer 4 and USB CDC).
 * Empty when there is none.
 */
export function boardWarningLines(
  warnings: readonly { message: string }[] | undefined
): string[] {
  return [...new Set((warnings ?? []).map((row) => row.message))];
}

/** Card label for the onboard LED, from the pin the view names. */
export function ledLabel(pin: string | null | undefined): string {
  if (!pin) return "LED";
  return pin.endsWith("LED") ? pin : `${pin} LED`;
}

/** Brownout and SOA floor from the board view, volts, and the chip. */
export type SoaFacts = {
  brownoutVoltage?: number;
  /** Null when the chip publishes no floor. */
  minOperatingVoltage?: number | null;
  /** The chip's name and clock. Null when the view names none. */
  clock?: ChipClock | null;
};

/**
 * The same line for a scrubbed frame. `belowSoa` is the window flag.
 * The voltage is this board's 5V node, not the supply terminal.
 * The thresholds come from the view. When the view lacks them the flag
 * still shows, as a line without the numbers it cannot name.
 */
export function recordedSoaLine(
  belowSoa: boolean | undefined,
  board: { voltage: number; minVoltage: number } | undefined,
  facts?: SoaFacts
): string {
  if (!belowSoa) return "";
  const brownout = facts?.brownoutVoltage;
  const floor = facts?.minOperatingVoltage;
  const clock = facts?.clock;
  if (brownout === undefined || floor == null || !clock) {
    return floor == null
      ? "supply was below the chip's minimum operating voltage"
      : `supply was below the ${floor.toFixed(2)} V minimum operating voltage`;
  }
  if (board) {
    const voltage =
      board.minVoltage > brownout && board.minVoltage < floor
        ? board.minVoltage
        : board.voltage;
    const warning = soaWarning(voltage, brownout, floor, clock);
    if (warning) return warning.message;
  }
  const shown = floor.toFixed(2);
  return `supply was below the ${shown} V ${soaNeed(clock)}`;
}
