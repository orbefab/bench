/**
 * The observer's build fingerprint: SHA-256 over the bytes of every file
 * that takes or reduces an observation (`OBSERVER_SOURCES`), resolved next
 * to `@sfab-bench/sim/observe`. No package version is read: a change to
 * that code changes the fingerprint whether or not a version moved.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Bytes } from "@sfab-bench/parts";
import { OBSERVER_SOURCES } from "@sfab-bench/sim/observe";

/** Where the observer's sources are, for a caller that hashes a copy. */
export function observerDir(): string {
  return dirname(fileURLToPath(import.meta.resolve("@sfab-bench/sim/observe")));
}

export function observerBuild(dir = observerDir()): string {
  const lines = OBSERVER_SOURCES.map(
    (rel) => `${rel} ${sha256Bytes(readFileSync(join(dir, rel)))}`
  );
  return sha256Bytes(new TextEncoder().encode(lines.join("\n")));
}
