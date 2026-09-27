/**
 * Edit `run.levels` in a world file. Only that value is rewritten, so the
 * rest of the file stays byte-identical.
 */

import type { AxisName, LevelClass, LevelSpec } from "@sfab-bench/contract";

export type LevelTable = {
  default: LevelSpec;
  types?: Record<string, LevelSpec>;
  paths?: Record<string, LevelSpec>;
  nets?: Record<string, "digital" | "analog">;
};

export type LevelEdit = {
  scope: "default" | "type" | "path";
  key?: string;
  axis?: AxisName;
  class: LevelClass | null;
};

const AXES: readonly AxisName[] = ["behaviour", "body", "visual"];

export function applyLevelEdit(
  levels: LevelTable,
  edit: LevelEdit
): { levels: LevelTable } | { error: string } {
  if (edit.scope === "default") {
    if (edit.key) return { error: "default takes no key" };
    if (edit.class === null) {
      return { error: "the default level cannot be removed" };
    }
    if (!edit.axis) return { levels: ordered({ ...levels, default: edit.class }) };
    const spec = axesOf(levels.default);
    spec[edit.axis] = edit.class;
    return { levels: ordered({ ...levels, default: collapse(spec) }) };
  }
  if (!edit.key) return { error: `${edit.scope} needs a key` };
  const tableName = edit.scope === "type" ? "types" : "paths";
  const table = { ...(levels[tableName] ?? {}) };
  if (edit.class === null) {
    const current = table[edit.key];
    if (current === undefined) {
      return { error: `no ${edit.scope} rule "${edit.key}"` };
    }
    if (!edit.axis) {
      delete table[edit.key];
    } else {
      const spec = axesOf(current);
      if (spec[edit.axis] === undefined) {
        return {
          error: `no ${edit.scope} rule "${edit.key}" for ${edit.axis}`,
        };
      }
      delete spec[edit.axis];
      if (AXES.every((axis) => spec[axis] === undefined)) delete table[edit.key];
      else table[edit.key] = collapse(spec);
    }
    return { levels: ordered({ ...levels, [tableName]: table }) };
  }
  if (!edit.axis) {
    table[edit.key] = edit.class;
  } else {
    const spec = table[edit.key] === undefined ? {} : axesOf(table[edit.key]);
    spec[edit.axis] = edit.class;
    table[edit.key] = collapse(spec);
  }
  return { levels: ordered({ ...levels, [tableName]: table }) };
}

function ordered(levels: LevelTable): LevelTable {
  const out: LevelTable = { default: levels.default };
  if (levels.types && Object.keys(levels.types).length > 0) {
    out.types = levels.types;
  }
  if (levels.paths && Object.keys(levels.paths).length > 0) {
    out.paths = levels.paths;
  }
  if (levels.nets && Object.keys(levels.nets).length > 0) {
    out.nets = levels.nets;
  }
  return out;
}

function axesOf(spec: LevelSpec): Partial<Record<AxisName, LevelClass>> {
  if (typeof spec === "number") {
    return { behaviour: spec, body: spec, visual: spec };
  }
  return { ...spec };
}

function collapse(spec: Partial<Record<AxisName, LevelClass>>): LevelSpec {
  const values = AXES.map((axis) => spec[axis]);
  if (
    values.every((value) => value !== undefined) &&
    values.every((value) => value === values[0])
  ) {
    return values[0] as LevelClass;
  }
  const out: Partial<Record<AxisName, LevelClass>> = {};
  for (const axis of AXES) {
    if (spec[axis] !== undefined) out[axis] = spec[axis];
  }
  return out;
}

/**
 * Replace the `levels` value. Arrays and other keys keep their original
 * bytes. The new value uses the file's indent.
 */
export function replaceLevels(text: string, levels: LevelTable): string {
  const span = levelsSpan(text);
  if (!span) throw new Error("world file has no run.levels");
  const lineStart = text.lastIndexOf("\n", span.key) + 1;
  const indent = span.key - lineStart;
  const pretty = JSON.stringify(levels, null, 2);
  const pad = " ".repeat(indent);
  const formatted = pretty
    .split("\n")
    .map((line, index) => (index === 0 ? line : pad + line))
    .join("\n");
  return text.slice(0, span.start) + formatted + text.slice(span.end);
}

function levelsSpan(
  text: string
): { key: number; start: number; end: number } | null {
  let i = 0;
  let span: { key: number; start: number; end: number } | null = null;
  const skip = () => {
    while (i < text.length && " \t\n\r".includes(text[i] ?? "")) i += 1;
  };
  const readString = (): { at: number; value: string } => {
    const at = i;
    i += 1;
    let value = "";
    while (i < text.length) {
      const ch = text[i] ?? "";
      if (ch === "\\") {
        value += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === '"') {
        i += 1;
        return { at, value };
      }
      value += ch;
      i += 1;
    }
    throw new Error("world file is not JSON");
  };
  const parse = (depth: number, key: string | null): void => {
    skip();
    if (text[i] === "{") {
      i += 1;
      skip();
      if (text[i] === "}") {
        i += 1;
        return;
      }
      while (i < text.length) {
        skip();
        if (text[i] !== '"') throw new Error("world file is not JSON");
        const name = readString();
        skip();
        if (text[i] !== ":") throw new Error("world file is not JSON");
        i += 1;
        skip();
        const start = i;
        const hit = depth === 1 && key === "run" && name.value === "levels";
        parse(depth + 1, name.value);
        if (hit) span = { key: name.at, start, end: i };
        skip();
        if (text[i] === ",") {
          i += 1;
          continue;
        }
        if (text[i] === "}") {
          i += 1;
          return;
        }
        throw new Error("world file is not JSON");
      }
      return;
    }
    if (text[i] === "[") {
      i += 1;
      skip();
      if (text[i] === "]") {
        i += 1;
        return;
      }
      while (i < text.length) {
        parse(depth + 1, null);
        skip();
        if (text[i] === ",") {
          i += 1;
          continue;
        }
        if (text[i] === "]") {
          i += 1;
          return;
        }
        throw new Error("world file is not JSON");
      }
      return;
    }
    if (text[i] === '"') {
      readString();
      return;
    }
    while (i < text.length && !",}] \t\n\r".includes(text[i] ?? "")) i += 1;
  };
  parse(0, null);
  return span;
}
