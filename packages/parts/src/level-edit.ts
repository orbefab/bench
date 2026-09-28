/**
 * Edit `run.levels` in a world file, or `play.levels` in a root part.
 * Only that value is rewritten, so the rest of the file stays byte-identical.
 */

import type {
  AxisLevel,
  AxisName,
  LevelClass,
  LevelSpec,
  LockFile,
  LockSnapshot,
} from "@sfab-bench/contract";

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
  /** With `axis`, write `{ class, variant }` instead of the bare class. */
  variant?: string;
};

const AXES: readonly AxisName[] = ["behaviour", "body", "visual"];

export function applyLevelEdit(
  levels: LevelTable,
  edit: LevelEdit
): { levels: LevelTable } | { error: string } {
  const variantError = variantNeeds(edit);
  if (variantError) return { error: variantError };
  if (edit.scope === "default") {
    if (edit.key) return { error: "default takes no key" };
    if (edit.class === null) {
      return { error: "the default level cannot be removed" };
    }
    if (!edit.axis)
      return { levels: ordered({ ...levels, default: edit.class }) };
    const spec = axesOf(levels.default);
    spec[edit.axis] = axisValue(edit);
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
      if (AXES.every((axis) => spec[axis] === undefined))
        delete table[edit.key];
      else table[edit.key] = collapse(spec);
    }
    return { levels: ordered({ ...levels, [tableName]: table }) };
  }
  if (!edit.axis) {
    table[edit.key] = edit.class;
  } else {
    const spec = table[edit.key] === undefined ? {} : axesOf(table[edit.key]);
    spec[edit.axis] = axisValue(edit);
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

function variantNeeds(edit: LevelEdit): string | null {
  if (!edit.variant) return null;
  if (!edit.axis) return "a variant needs an axis";
  if (edit.class === null) return "a variant needs a class";
  return null;
}

function axisValue(edit: LevelEdit): AxisLevel {
  if (edit.variant && edit.class !== null) {
    return { class: edit.class, variant: edit.variant };
  }
  return edit.class as LevelClass;
}

function axesOf(spec: LevelSpec): Partial<Record<AxisName, AxisLevel>> {
  if (typeof spec === "number") {
    return { behaviour: spec, body: spec, visual: spec };
  }
  const out: Partial<Record<AxisName, AxisLevel>> = {};
  for (const axis of AXES) {
    const value = spec[axis];
    if (value !== undefined) out[axis] = value;
  }
  return out;
}

/**
 * A bare number when every axis is that same class. A variant object
 * stays as written. Setting a class on one axis replaces that axis's
 * variant rule with the class alone; the caller assigns the number
 * before this runs.
 */
function collapse(spec: Partial<Record<AxisName, AxisLevel>>): LevelSpec {
  const values = AXES.map((axis) => spec[axis]);
  const bare = values.every((value) => typeof value === "number");
  if (
    bare &&
    values.every((value) => value !== undefined) &&
    values.every((value) => value === values[0])
  ) {
    return values[0] as LevelClass;
  }
  const out: Partial<Record<AxisName, AxisLevel>> = {};
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
        const hit =
          depth === 1 &&
          (key === "run" || key === "play") &&
          name.value === "levels";
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

/**
 * The lock written after a level edit. Part and type rows stay as pinned.
 * Snapshot rows may appear or disappear with the levels. A hash that no
 * longer matches the pin is drift: the tool must not re-pin it.
 *
 * `refresh` is the document part, when the levels live on that part. Its
 * hash is copied from the resolved lock. Every other row still has to match.
 */
export function lockAfterLevels(
  pinned: LockFile,
  resolved: LockFile,
  refresh: readonly string[] = []
): { lock: LockFile } | { error: string } {
  const refreshing = new Set(refresh);
  const part = rowDrift("part", pinned.parts, resolved.parts, refreshing);
  if (part) return { error: part };
  const type = rowDrift("part type", pinned.types, resolved.types);
  if (type) return { error: type };
  const snapshot = snapshotDrift(
    pinned.snapshots ?? [],
    resolved.snapshots ?? []
  );
  if (snapshot) return { error: snapshot };
  const snapshots = resolved.snapshots ?? [];
  const parts = pinned.parts.map((row) => {
    if (!refreshing.has(row.id)) return row;
    const next = resolved.parts.find((item) => item.id === row.id);
    return next ? { ...row, sha256: next.sha256 } : row;
  });
  return {
    lock: {
      format: pinned.format,
      world: pinned.world,
      parts,
      types: pinned.types,
      ...(snapshots.length > 0 ? { snapshots } : {}),
    },
  };
}

/**
 * The lock after any document edit. The open part is re-pinned. Parts
 * and types the edit started using gain a row; rows nothing resolves
 * any more are dropped. A hash change on anything else is drift.
 * Snapshot rows may appear or disappear with the levels. Row key order
 * stays as the file had it, so a byte-identical undo can print it back.
 */
export function lockAfterEdit(
  pinned: LockFile,
  resolved: LockFile,
  refresh: readonly string[]
): { lock: LockFile } | { error: string } {
  if (pinned.format !== resolved.format) {
    return {
      error: `lockfile format mismatch (${String(pinned.format)} vs ${String(resolved.format)})`,
    };
  }
  if (pinned.world !== resolved.world) {
    return {
      error: `lockfile world name mismatch (${pinned.world} vs ${resolved.world})`,
    };
  }
  const refreshing = new Set(refresh);
  const parts = mergeRows("part", pinned.parts, resolved.parts, refreshing);
  if ("error" in parts) return parts;
  const types = mergeRows("part type", pinned.types, resolved.types, new Set());
  if ("error" in types) return types;
  const snapshot = snapshotDrift(
    pinned.snapshots ?? [],
    resolved.snapshots ?? []
  );
  if (snapshot) return { error: snapshot };
  const lock = structuredClone(pinned);
  lock.parts = parts.rows;
  lock.types = types.rows;
  const snapshots = shapeSnapshots(
    pinned.snapshots ?? [],
    resolved.snapshots ?? []
  );
  if (snapshots.length > 0) lock.snapshots = snapshots;
  else delete lock.snapshots;
  return { lock };
}

function mergeRows<T extends { id: string; sha256: string }>(
  kind: "part" | "part type",
  pinned: T[],
  resolved: T[],
  refresh: ReadonlySet<string>
): { rows: T[] } | { error: string } {
  const have = new Map(pinned.map((row) => [row.id, row]));
  const sample = pinned[0];
  const rows: T[] = [];
  for (const next of resolved) {
    const prev = have.get(next.id);
    if (!prev) {
      rows.push(shapeLike(sample, next));
      continue;
    }
    if (prev.sha256 !== next.sha256 && !refresh.has(next.id)) {
      return {
        error: `${next.id} port file quantity sha256: lockfile hash mismatch on a ${kind} (content changed, lockfile did not) (${prev.sha256} vs ${next.sha256})`,
      };
    }
    if (prev.sha256 !== next.sha256) {
      const copy = structuredClone(prev);
      copy.sha256 = next.sha256;
      rows.push(copy);
    } else {
      rows.push(prev);
    }
  }
  return { rows };
}

function shapeSnapshots(
  pinned: LockSnapshot[],
  resolved: LockSnapshot[]
): LockSnapshot[] {
  const have = new Map(pinned.map((row) => [row.id, row]));
  const sample = pinned[0];
  return resolved.map((next) => {
    const prev = have.get(next.id);
    if (prev && prev.sha256 === next.sha256) return prev;
    return shapeLike(sample, next);
  });
}

function shapeLike<T extends object>(sample: T | undefined, row: T): T {
  if (!sample) return row;
  const out: Record<string, unknown> = {};
  const src = row as Record<string, unknown>;
  for (const key of Object.keys(sample)) {
    if (key in src) out[key] = src[key];
  }
  for (const key of Object.keys(src)) {
    if (!(key in out)) out[key] = src[key];
  }
  return out as T;
}

function rowDrift(
  kind: "part" | "part type",
  pinned: { id: string; sha256: string }[],
  resolved: { id: string; sha256: string }[],
  refresh: ReadonlySet<string> = new Set()
): string | null {
  const have = new Map(pinned.map((row) => [row.id, row.sha256]));
  const want = new Map(resolved.map((row) => [row.id, row.sha256]));
  for (const [id, sha] of want) {
    const found = have.get(id);
    if (found === undefined) {
      return `${id} port file quantity sha256: lockfile is missing a resolved ${kind} (missing vs ${sha})`;
    }
    if (found !== sha && !refresh.has(id)) {
      return `${id} port file quantity sha256: lockfile hash mismatch on a ${kind} (content changed, lockfile did not) (${found} vs ${sha})`;
    }
  }
  for (const [id, sha] of have) {
    if (want.has(id)) continue;
    return `${id} port file quantity sha256: lockfile lists a ${kind} this world does not resolve (${sha} vs not used)`;
  }
  return null;
}

/** A snapshot that stays pinned must keep its hash. Appearing or disappearing is the level change. */
function snapshotDrift(
  pinned: LockSnapshot[],
  resolved: LockSnapshot[]
): string | null {
  const have = new Map(pinned.map((row) => [row.id, row.sha256]));
  for (const row of resolved) {
    const found = have.get(row.id);
    if (found !== undefined && found !== row.sha256) {
      return `${row.id} port file quantity sha256: lockfile hash mismatch on a snapshot (content changed, lockfile did not) (${found} vs ${row.sha256})`;
    }
  }
  return null;
}
