/**
 * Part documents are 2-space JSON plus a newline. Example files keep a
 * scalar array on one line (`[0, 0, -9.81]`). A converter file that
 * expands arrays with `JSON.stringify(value, null, 2)` stays that way.
 * The style is taken from the text being replaced, so an undo prints
 * the bytes it started from.
 */

export type PartStyle = "compact" | "expanded";

/** An inline scalar array means the compact style. */
export function partStyle(text: string): PartStyle {
  return /\[[\d\-"]/.test(text) ? "compact" : "expanded";
}

export function formatPart(value: unknown, style: PartStyle): string {
  const body =
    style === "expanded"
      ? JSON.stringify(value, null, 2)
      : formatCompact(value, 0);
  return body.endsWith("\n") ? body : `${body}\n`;
}

function formatCompact(value: unknown, indent: number): string {
  const pad = " ".repeat(indent);
  const inner = " ".repeat(indent + 2);
  if (Array.isArray(value)) {
    const scalar = value.every(
      (item) =>
        item === null ||
        typeof item === "string" ||
        typeof item === "number" ||
        typeof item === "boolean"
    );
    if (scalar) {
      return `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
    }
    const lines = value.map((item) => inner + formatCompact(item, indent + 2));
    return `[\n${lines.join(",\n")}\n${pad}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    const lines = entries.map(
      ([key, item]) =>
        `${inner}${JSON.stringify(key)}: ${formatCompact(item, indent + 2)}`
    );
    return `{\n${lines.join(",\n")}\n${pad}}`;
  }
  return JSON.stringify(value);
}
