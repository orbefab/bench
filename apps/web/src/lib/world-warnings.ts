/**
 * Warnings for one run, grouped by instance path. The tree icon, the
 * stage callout, and the card all read this.
 */

import type { Diagnostic, RunReport } from "@sfab-bench/contract";

export type PathWarning = {
  path: string;
  message: string;
  code?: string;
};

/** A state diagnostic, or a report row. Path may be empty. */
export type WarningSource = {
  warnings?: readonly Pick<Diagnostic, "path" | "message" | "code">[];
  errors?: readonly Pick<Diagnostic, "path" | "message" | "code">[];
  degraded?: readonly Pick<Diagnostic, "path" | "message" | "code">[];
  diagnostics?: readonly { path: string; message: string; code?: string }[];
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
  const add = (path: string, message: string, code?: string) => {
    const key = path;
    const list = map.get(key) ?? [];
    if (list.some((row) => row.message === message && row.code === code))
      return;
    list.push({ path: key, message, ...(code ? { code } : {}) });
    map.set(key, list);
  };
  for (const row of source.warnings ?? []) add(row.path, row.message, row.code);
  for (const row of source.errors ?? []) add(row.path, row.message, row.code);
  for (const row of source.degraded ?? []) add(row.path, row.message, row.code);
  for (const row of source.diagnostics ?? [])
    add(row.path, row.message, row.code);
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
    if (path && rows.length > 0) paths.add(path);
  }
  return paths;
}

export function warningText(rows: readonly PathWarning[]): string {
  return rows.map((row) => row.message).join("\n");
}
