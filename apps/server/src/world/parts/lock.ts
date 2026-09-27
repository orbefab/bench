/** Ported from layered-sim E7 (318b899). */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  type Diagnostic,
  LOCK_FORMAT,
  type LockFile,
  type LockPart,
  type LockSnapshot,
  type LockType,
} from "@sfab-bench/contract";

import type { Library } from "./library";
import { canonicalJson, makeDiag, parsePartRef } from "./si";

export function buildLock(
  lib: Library,
  snapshots: LockSnapshot[] = []
): LockFile {
  const parts: LockPart[] = [...lib.parts.values()]
    .map((loaded) => {
      const parsed = parsePartRef(loaded.part.id);
      if (!parsed) throw new Error(`bad part id ${loaded.part.id}`);
      return {
        id: loaded.part.id,
        version: parsed.version,
        sha256: loaded.sha256,
        source: loaded.source,
        path: loaded.path,
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const types: LockType[] = [...lib.types.values()]
    .map((loaded) => ({
      id: loaded.type.id,
      sha256: loaded.sha256,
      source: loaded.source,
      path: loaded.path,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const pinned = [...snapshots].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  );
  return {
    format: LOCK_FORMAT,
    world: lib.worldName,
    parts,
    types,
    ...(pinned.length > 0 ? { snapshots: pinned } : {}),
  };
}

/**
 * One lock per world file. A folder can hold two worlds (the arm and the
 * stall), and a directory-named lock can describe only one of them.
 */
export function lockPathFor(worldFile: string): string {
  const dir = path.dirname(worldFile);
  const stem = path.basename(worldFile).replace(/\.json$/, "");
  return path.join(dir, `${stem}.lock.json`);
}

export function writeLock(file: string, lock: LockFile): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${canonicalJson(lock)}\n`);
}

export function readLock(file: string): LockFile {
  return JSON.parse(readFileSync(file, "utf8")) as LockFile;
}

export function verifyLock(
  lib: Library,
  lock: LockFile,
  snapshots: LockSnapshot[] = []
): Diagnostic[] {
  const diags: Diagnostic[] = [];
  if (lock.format !== LOCK_FORMAT) {
    diags.push(
      makeDiag({
        severity: "error",
        path: lib.worldName,
        port: "lock",
        quantity: "format",
        left: String(lock.format),
        right: LOCK_FORMAT,
        detail: "lockfile format mismatch",
      })
    );
  }
  if (lock.world !== lib.worldName) {
    diags.push(
      makeDiag({
        severity: "error",
        path: lib.worldName,
        port: "lock",
        quantity: "world",
        left: lock.world,
        right: lib.worldName,
        detail: "lockfile world name mismatch",
      })
    );
  }
  const expected = buildLock(lib, snapshots);
  compareRows(
    diags,
    "part",
    expected.parts.map((row) => [row.id, row.sha256]),
    lock.parts.map((row) => [row.id, row.sha256])
  );
  compareRows(
    diags,
    "part type",
    expected.types.map((row) => [row.id, row.sha256]),
    lock.types.map((row) => [row.id, row.sha256])
  );
  compareRows(
    diags,
    "snapshot",
    (expected.snapshots ?? []).map((row) => [row.id, row.sha256]),
    (lock.snapshots ?? []).map((row) => [row.id, row.sha256])
  );
  return diags;
}

function compareRows(
  diags: Diagnostic[],
  kind: "part" | "part type" | "snapshot",
  expected: [string, string][],
  got: [string, string][]
): void {
  const exp = new Map(expected);
  const have = new Map(got);
  for (const [id, sha] of exp) {
    const found = have.get(id);
    if (found === undefined) {
      diags.push(
        makeDiag({
          severity: "error",
          path: id,
          port: "file",
          quantity: "sha256",
          left: "missing",
          right: sha,
          detail: `lockfile is missing a resolved ${kind}`,
        })
      );
      continue;
    }
    if (found !== sha) {
      diags.push(
        makeDiag({
          severity: "error",
          path: id,
          port: "file",
          quantity: "sha256",
          left: found,
          right: sha,
          detail: `lockfile hash mismatch on a ${kind} (content changed, lockfile did not)`,
        })
      );
    }
  }
  for (const [id, sha] of have) {
    if (exp.has(id)) continue;
    diags.push(
      makeDiag({
        severity: "error",
        path: id,
        port: "file",
        quantity: "sha256",
        left: sha,
        right: "not used",
        detail: `lockfile lists a ${kind} this world does not resolve`,
      })
    );
  }
}
