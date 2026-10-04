/**
 * Whether a capture's `from.hash` still matches its source. The level,
 * variant and (for a sweep) the stamped instance come from the snapshot's
 * provenance; the signature is the one the capture runner wrote
 * (`capture-signature.ts`), read through the same capture source: the
 * project, then the catalog. One stamp or one hash per snapshot per plan,
 * not per step.
 */
import type { SnapshotFile } from "@sfab-bench/contract";

import {
  groupSignature,
  hingeSignature,
  stampSignature,
} from "./capture-signature";
import { captureSource } from "./capture-source";
import { assemblyStampOf } from "./circuit-stamp";
import type { StampEnv } from "./env";

export type Freshness =
  | { checked: true; hash: string }
  | { checked: false; reason: string };

/**
 * Recompute the signature the capture runner stored. A measured snapshot,
 * a provenance that does not name its source, or a source that no longer
 * builds is not checked, and says why.
 */
export function provenanceHash(
  file: SnapshotFile,
  opts: { catalogDir: string; worldDir: string },
  env: StampEnv
): Freshness {
  const from = file.provenance.from;
  if (file.provenance.source === "measured") {
    return { checked: false, reason: "a measured snapshot has no source" };
  }
  if (!from) return { checked: false, reason: "no source part" };
  const variant = file.provenance.variant;
  if (!variant) {
    return { checked: false, reason: "the provenance names no variant" };
  }
  const source = { level: from.level, variant };
  const read = captureSource(opts.catalogDir, opts.worldDir, env);
  const readPart = (id: string) => read.part(id)?.part ?? null;
  const unbuilt = (what: string): Freshness => ({
    checked: false,
    reason: `${from.part} class ${from.level} variant ${variant} is not ${what}`,
  });
  try {
    if (file.form === "hinge@1" && file.axis === "body") {
      const part = readPart(from.part);
      const hash = part ? hingeSignature(part, source) : null;
      return hash ? { checked: true, hash } : unbuilt("a gear train");
    }
    // A capture across a port pair (a table, or a law fitted to that
    // sweep) hashes the stamp it swept. Any other behaviour snapshot was
    // captured from the group running.
    const across = pair(file.params.across);
    if (file.axis === "behaviour" && !across) {
      const hash = groupSignature(
        from.part,
        source,
        readPart,
        (id) => read.type(id)?.type ?? null
      );
      return hash ? { checked: true, hash } : unbuilt("a composite");
    }
    if (!across) return unbuilt("a group or a sweep");
    const instance = file.provenance.instance;
    if (!instance) {
      return { checked: false, reason: "the provenance names no instance" };
    }
    const stamp = assemblyStampOf(
      from.part,
      variant,
      {
        catalogDir: opts.catalogDir,
        worldDir: read.worldDir,
        assetRoot: read.worldDir,
        boardId: instance,
        across,
      },
      env
    );
    return { checked: true, hash: stampSignature(stamp, source) };
  } catch (err) {
    return {
      checked: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function pair(value: unknown): [string, string] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const a = value[0];
  const b = value[1];
  if (typeof a !== "string" || typeof b !== "string") return null;
  return [a, b];
}
