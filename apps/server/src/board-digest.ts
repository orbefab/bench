/**
 * The value canon the board goldens hash: sorted keys, `undefined` dropped,
 * numbers rounded to a nanounit so a reordered sum does not move a digest.
 */

/** Numbers are rounded to a nanounit. */
const QUANTUM = 1e9;

export function num(value: number): number | string {
  if (!Number.isFinite(value)) return String(value);
  const rounded = Math.round(value * QUANTUM) / QUANTUM;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** JSON with sorted keys and rounded numbers. `undefined` keys are dropped. */
export function canon(value: unknown): string {
  if (typeof value === "number") return JSON.stringify(num(value));
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort();
    return `{${keys
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canon((value as Record<string, unknown>)[key])}`
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

type PinWords = {
  ddr: readonly number[] | number;
  level: readonly number[] | number;
  toggled: readonly number[] | number;
};

function r5bWord(value: readonly number[] | number): number {
  return typeof value === "number" ? value : (value[0] ?? 0);
}

/**
 * Project pin-word arrays back onto the R5b 20-bit mask.
 * Keeps the R5b digests comparable: for a board whose GPIO order is
 * D0–D13 then A0–A5, word 0 is that mask.
 */
export function r5bPins<T extends { pins?: PinWords }>(board: T): T {
  if (!board.pins) return board;
  return {
    ...board,
    pins: {
      ddr: r5bWord(board.pins.ddr),
      level: r5bWord(board.pins.level),
      toggled: r5bWord(board.pins.toggled),
    },
  };
}

/** Same projection for every board on a frame or a live state. */
export function r5bBoards<T extends { pins?: PinWords }>(
  boards: Record<string, T>
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [id, board] of Object.entries(boards)) out[id] = r5bPins(board);
  return out;
}

/** Values of a record in key order, with the keys dropped. */
export function byOrder<T>(record: Record<string, T> | undefined): T[] {
  if (!record) return [];
  return Object.keys(record)
    .sort()
    .map((key) => record[key] as T);
}
