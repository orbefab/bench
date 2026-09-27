/** Ported from layered-sim E4 (fd10742). Snapshot files sit beside parts in the library. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  type Diagnostic,
  type PartTypeFile,
  SNAPSHOT_FORMAT,
  type SnapshotFile,
  type SnapshotQuality,
} from "@sfab-bench/contract";

import type { LibraryOptions } from "./parts/library";
import { contentHash, makeDiag, parsePartRef } from "./parts/si";
import { lintSnapshot } from "./snapshot-lint";

export type LoadedSnapshot = {
  id: string;
  file: SnapshotFile;
  source: "world" | "library" | "catalog";
  path: string;
  sha256: string;
  quality: SnapshotQuality;
};

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

function relPosix(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join("/");
}

function snapshotFile(base: string, id: string): string | null {
  const parsed = parsePartRef(id);
  if (!parsed) return null;
  return path.join(
    base,
    "snapshots",
    parsed.publisher,
    `${parsed.name}@${parsed.version}.json`
  );
}

export function loadSnapshot(
  worldDir: string,
  opts: LibraryOptions,
  id: string,
  type: PartTypeFile | null
): { loaded: LoadedSnapshot | null; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  if (!parsePartRef(id)) {
    diagnostics.push(
      makeDiag({
        severity: "error",
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
  const found = layers.find((layer) => existsSync(layer.file));
  if (!found) {
    diagnostics.push(
      makeDiag({
        severity: "error",
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
  const raw = readJson(found.file) as SnapshotFile;
  if (raw.format !== SNAPSHOT_FORMAT) {
    diagnostics.push(
      makeDiag({
        severity: "error",
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
