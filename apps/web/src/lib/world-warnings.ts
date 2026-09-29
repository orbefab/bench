/**
 * Warnings for one run, grouped by instance path. The tree icon, the
 * stage callout, and the card all read this.
 */

import type { RunReport } from "@sfab-bench/contract";

export type PathWarning = {
  path: string;
  message: string;
  code?: string;
  /** Set when the diagnostic names a port. `play` is the document. */
  port?: string;
};

/** A state diagnostic, or a report row. Path may be empty. */
export type WarningSource = {
  warnings?: readonly {
    path: string;
    message: string;
    code?: string;
    port?: string;
  }[];
  errors?: readonly {
    path: string;
    message: string;
    code?: string;
    port?: string;
  }[];
  degraded?: readonly {
    path: string;
    message: string;
    code?: string;
    port?: string;
  }[];
  diagnostics?: readonly {
    path: string;
    message: string;
    code?: string;
    port?: string;
  }[];
  snapshots?: readonly {
    path: string;
    envelope?: readonly string[];
    stale?: true;
  }[];
};

export function warningsByPath(
  source: WarningSource | null
): Map<string, PathWarning[]> {
  const map = new Map<string, PathWarning[]>();
  if (!source) return map;
  const add = (path: string, message: string, code?: string, port?: string) => {
    const key = path;
    const list = map.get(key) ?? [];
    if (list.some((row) => row.message === message && row.code === code))
      return;
    list.push({
      path: key,
      message,
      ...(code ? { code } : {}),
      ...(port ? { port } : {}),
    });
    map.set(key, list);
  };
  for (const row of source.warnings ?? [])
    add(row.path, row.message, row.code, row.port);
  for (const row of source.errors ?? [])
    add(row.path, row.message, row.code, row.port);
  for (const row of source.degraded ?? [])
    add(row.path, row.message, row.code, row.port);
  for (const row of source.diagnostics ?? [])
    add(row.path, row.message, row.code, row.port);
  for (const snap of source.snapshots ?? []) {
    for (const line of snap.envelope ?? []) {
      add(snap.path, line, "envelope");
    }
    if (snap.stale) add(snap.path, "This capture is stale.", "stale-capture");
  }
  return map;
}

/** Report rows plus the live state's diagnostics. */
export function warningsFromRun(
  report: RunReport | null,
  diagnostics?: readonly { path: string; message: string; code?: string }[]
): Map<string, PathWarning[]> {
  if (!report && !diagnostics) return new Map();
  return warningsByPath({
    warnings: report?.warnings,
    errors: report?.errors,
    degraded: report?.degraded,
    snapshots: report?.snapshots,
    diagnostics,
  });
}

/** Instance paths that have at least one warning. An empty path is omitted. */
export function warnedPaths(
  map: ReadonlyMap<string, PathWarning[]>
): Set<string> {
  const paths = new Set<string>();
  for (const [path, rows] of map) {
    if (path && rows.some((row) => !isDocumentWarning(row))) paths.add(path);
  }
  return paths;
}

/**
 * A document warning belongs on the open part's card, beside play.
 * That is an empty path, a play-settings code, or `$root` when the
 * port is `play`. `$root` with any other port is the stage instance.
 */
export function isDocumentWarning(row: {
  path: string;
  code?: string;
  port?: string;
}): boolean {
  if (row.path === "") return true;
  if (row.code === "timestep-unsupported") return true;
  return row.path === "$root" && row.port === "play";
}

export function documentWarnings(
  map: ReadonlyMap<string, PathWarning[]>
): PathWarning[] {
  const rows: PathWarning[] = [];
  for (const list of map.values()) {
    for (const row of list) {
      if (isDocumentWarning(row)) rows.push(row);
    }
  }
  return rows;
}

export function instanceWarnings(
  map: ReadonlyMap<string, PathWarning[]>,
  path: string
): PathWarning[] {
  return (map.get(path) ?? []).filter((row) => !isDocumentWarning(row));
}

export function instanceWarningMap(
  map: ReadonlyMap<string, PathWarning[]>
): Map<string, PathWarning[]> {
  const next = new Map<string, PathWarning[]>();
  for (const [path, rows] of map) {
    const kept = rows.filter((row) => !isDocumentWarning(row));
    if (kept.length > 0) next.set(path, kept);
  }
  return next;
}

export function warningText(rows: readonly PathWarning[]): string {
  return rows.map((row) => row.message).join("\n");
}

/**
 * The open-part card scrolls. The gutter stays reserved so a document
 * warning cannot show and hide the scrollbar and loop layout.
 */
export const inspectorBodyClass =
  "min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-3 [scrollbar-gutter:stable]";
