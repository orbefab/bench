/** Ported from layered-sim E4 (fd10742). Snapshot files sit beside parts in the library. */
import {
  type Diagnostic,
  type PartTypeFile,
  SNAPSHOT_FORMAT,
  type SnapshotFile,
  type SnapshotQuality,
} from "@sfab-bench/contract";

import type { LibraryOptions } from "./library";
import { join, relative, sep } from "./path";
import { contentHash, makeDiag, parsePartRef } from "./si";
import { lintSnapshot, parseSnapshot } from "./snapshot-lint";
import type { Store } from "./store";

export type LoadedSnapshot = {
  id: string;
  file: SnapshotFile;
  source: "world" | "library" | "catalog";
  path: string;
  sha256: string;
  quality: SnapshotQuality;
};

/** The file's JSON, or why it could not be read. */
function readJson(
  store: Store,
  file: string
): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(store.readText(file)) as unknown };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * The axis a snapshot must stand for; its type is the `type` argument. A
 * part id is not an owner: a project copy of a part runs the snapshot its
 * type and axis fit.
 */
export type SnapshotOwner = {
  axis: "behaviour" | "body";
};

function relPosix(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}

function snapshotFile(base: string, id: string): string | null {
  const parsed = parsePartRef(id);
  if (!parsed) return null;
  return join(
    base,
    "snapshots",
    parsed.publisher,
    `${parsed.name}@${parsed.version}.json`
  );
}

/**
 * The snapshot `id`, read, shaped, owned and linted. Never throws: a file
 * that cannot be used is diagnostics, so the caller can idle only the
 * instance that asked for it.
 */
export function loadSnapshot(
  worldDir: string,
  opts: LibraryOptions,
  id: string,
  type: PartTypeFile | null,
  owner?: SnapshotOwner
): { loaded: LoadedSnapshot | null; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  if (!parsePartRef(id)) {
    diagnostics.push(
      makeDiag({
        severity: "error",
        code: "schema",
        path: id,
        port: "file",
        quantity: "Snapshot",
        left: id,
        right: "publisher/name@version",
        detail: "snapshot id is not publisher/name@version",
      })
    );
    return { loaded: null, diagnostics };
  }
  const layers: { source: LoadedSnapshot["source"]; file: string }[] = [];
  const worldPath = snapshotFile(worldDir, id);
  if (worldPath) layers.push({ source: "world", file: worldPath });
  if (opts.libraryDir) {
    const libPath = snapshotFile(opts.libraryDir, id);
    if (libPath) layers.push({ source: "library", file: libPath });
  }
  const catalogPath = snapshotFile(opts.catalogDir, id);
  if (catalogPath) layers.push({ source: "catalog", file: catalogPath });
  const found = layers.find((layer) => opts.store.exists(layer.file));
  if (!found) {
    diagnostics.push(
      makeDiag({
        severity: "error",
        code: "missing-file",
        path: id,
        port: "file",
        quantity: "Snapshot",
        left: "missing",
        right: "not found",
        detail: "snapshot not found in project, personal library, or catalog",
      })
    );
    return { loaded: null, diagnostics };
  }
  const read = readJson(opts.store, found.file);
  if (!read.ok) {
    diagnostics.push(
      makeDiag({
        severity: "error",
        code: "schema",
        path: id,
        port: "file",
        quantity: "Snapshot",
        left: "unreadable",
        right: "JSON",
        detail: `snapshot is not readable JSON: ${read.message}`,
      })
    );
    return { loaded: null, diagnostics };
  }
  const parsed = parseSnapshot(read.value, id);
  if (!parsed.file) return { loaded: null, diagnostics: parsed.diagnostics };
  const raw = parsed.file;
  if (raw.format !== SNAPSHOT_FORMAT) {
    diagnostics.push(
      makeDiag({
        severity: "error",
        code: "schema",
        path: id,
        port: "file",
        quantity: "format",
        left: String(raw.format),
        right: SNAPSHOT_FORMAT,
        detail: "snapshot format mismatch",
      })
    );
    return { loaded: null, diagnostics };
  }
  const owned = ownerErrors(id, raw, type, owner);
  if (owned.length > 0) return { loaded: null, diagnostics: owned };
  const lint = lintSnapshot(raw, {
    plausible: type?.plausible,
    ...(type ? { ports: type.ports } : {}),
    ...(type?.requiredOutputs ? { requiredOutputs: type.requiredOutputs } : {}),
  });
  if (lint.diagnostics.length > 0) {
    return { loaded: null, diagnostics: lint.diagnostics };
  }
  return {
    loaded: {
      id,
      file: raw,
      source: found.source,
      path: relPosix(opts.assetRoot, found.file),
      sha256: contentHash(raw),
      quality: lint.quality,
    },
    diagnostics,
  };
}

/** The snapshot names the part, type and axis that run it. */
function ownerErrors(
  id: string,
  file: SnapshotFile,
  type: PartTypeFile | null,
  owner: SnapshotOwner | undefined
): Diagnostic[] {
  const checks: [string, string, string | undefined, string][] = [
    [
      "partType",
      file.partType,
      type?.id,
      `snapshot ${id} partType ${file.partType} is not ${type?.id}`,
    ],
    ["axis", file.axis, owner?.axis, `${id} is a ${file.axis} snapshot`],
  ];
  return checks
    .filter(([, got, want]) => want !== undefined && got !== want)
    .map(([field, got, want, detail]) =>
      makeDiag({
        severity: "error",
        code: "snapshot",
        path: id,
        port: field,
        quantity: "Snapshot",
        left: got,
        right: String(want),
        detail,
      })
    );
}
