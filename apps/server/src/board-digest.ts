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

/** Values of a record in key order, with the keys dropped. */
export function byOrder<T>(record: Record<string, T> | undefined): T[] {
  if (!record) return [];
  return Object.keys(record)
    .sort()
    .map((key) => record[key] as T);
}
