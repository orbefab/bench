/**
 * Whether a capture's `from.hash` still matches the part at `from.level`.
 * The variant and board instance come from the snapshot's provenance; the
 * catalog config answers only for a snapshot that predates them.
 * Table captures hash `describeNetlist(stamp, 0, "header")`. Hinge
 * captures hash the gear-train variant. One stamp or one hash per
 * snapshot per plan, not per step.
 */
import type { SnapshotFile } from "@sfab-bench/contract";
import { contentHash, loadPartById, type Store } from "@sfab-bench/parts";

import { assemblyStampOf, describeNetlist } from "./circuit-stamp";
import type { StampEnv } from "./env";

export type Freshness = { checked: true; hash: string } | { checked: false };

/**
 * Recompute the hash the capture runner stored. A measured snapshot, or
 * a level that is neither a stampable netlist nor a gear train, is not
 * checked. The caller leaves `stale` off in that case.
 */
export function provenanceHash(
  file: SnapshotFile,
  opts: { catalogDir: string; worldDir: string; assetRoot: string },
  env: StampEnv
): Freshness {
  const from = file.provenance.from;
  if (!from || file.provenance.source === "measured") return { checked: false };
  try {
    if (file.form === "hinge@1" && file.axis === "body") {
      const hash = hingeHash(from.part, from.level, opts, env);
      return hash ? { checked: true, hash } : { checked: false };
    }
    if (file.form !== "table@1") return { checked: false };
    const across = pair(file.params.across);
    if (!across) return { checked: false };
    const captured =
      file.provenance.variant && file.provenance.instance
        ? {
            variant: file.provenance.variant,
            instance: file.provenance.instance,
          }
        : captureOf(from.part, opts.catalogDir, env);
    const variant =
      captured?.variant ?? defaultVariant(from.part, from.level, opts, env);
    if (!variant) return { checked: false };
    const stamp = assemblyStampOf(
      from.part,
      variant,
      {
        catalogDir: opts.catalogDir,
        worldDir: opts.worldDir,
        assetRoot: opts.assetRoot,
        boardId: captured?.instance ?? "board",
        across,
      },
      env
    );
    return {
      checked: true,
      hash: contentHash(describeNetlist(stamp, 0, "header")),
    };
  } catch {
    return { checked: false };
  }
}

function hingeHash(
  partId: string,
  level: string,
  opts: { catalogDir: string; worldDir: string; assetRoot: string },
  env: StampEnv
): string | null {
  const found = loadPartById(opts.worldDir, libOpts(opts, env.store), partId);
  if (!("part" in found)) return null;
  const slot = found.part.axes?.body?.[level as "0"];
  const impl = slot?.variants[slot.default];
  if (!impl || impl.kind !== "gear-train") return null;
  return contentHash(impl);
}

function defaultVariant(
  partId: string,
  level: string,
  opts: { catalogDir: string; worldDir: string; assetRoot: string },
  env: StampEnv
): string | null {
  const found = loadPartById(opts.worldDir, libOpts(opts, env.store), partId);
  if (!("part" in found)) return null;
  const slot = found.part.axes?.behaviour?.[level as "0"];
  return slot?.default ?? null;
}

function captureOf(
  partId: string,
  catalogDir: string,
  env: StampEnv
): { variant: string; instance: string } | null {
  const file = env.join(
    env.absolutePath(catalogDir),
    "fixtures",
    "capture.config.json"
  );
  if (!env.store.exists(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(env.store.readText(file)) as unknown;
  } catch {
    return null;
  }
  const entries = (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as {
      part?: unknown;
      variant?: unknown;
      instance?: unknown;
    };
    if (row.part !== partId) continue;
    if (typeof row.variant !== "string" || typeof row.instance !== "string")
      continue;
    return { variant: row.variant, instance: row.instance };
  }
  return null;
}

function pair(value: unknown): [string, string] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const a = value[0];
  const b = value[1];
  if (typeof a !== "string" || typeof b !== "string") return null;
  return [a, b];
}

function libOpts(
  opts: { catalogDir: string; assetRoot: string },
  store: Store
) {
  return {
    store,
    catalogDir: opts.catalogDir,
    assetRoot: opts.assetRoot,
  };
}
