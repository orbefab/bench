/**
 * The source a capture ran, as one hash: `provenance.from.hash`. The
 * capture runners write it and freshness recomputes it with the same
 * function, so a capture is stale exactly when its source changed.
 *
 * Each signature covers the source's own definition, not the engine
 * built from it:
 * - a static sweep: the stamp it swept, every part with the form, the
 *   numbers that form parsed, its nodes, and any table or regulator law;
 * - a group: the source composite, the root's type, body axis and
 *   ratings, and every part and type the netlist reaches with their
 *   ratings (a run reads ratings: the servo's torque clamp, its supply,
 *   a motor's net torque);
 * - a hinge: the gear train and the part's ratings (the capture bounds
 *   its envelope by the shaft's).
 *
 * Each names the level and variant it read. Visual axes, citations,
 * snapshot bounds and resolutions are not the source (a run never reads a
 * resolution; a comparison judges by it), so editing them leaves a
 * capture fresh. A group's signature does not open a snapshot file a child
 * selects: a group that reaches a child with a snapshot variant lists it
 * in `nested`, and freshness reports that capture unchecked.
 */
import type {
  BehaviourImpl,
  PartFile,
  PartTypeFile,
} from "@sfab-bench/contract";
import { contentHash } from "@sfab-bench/parts";

import type { BoardStamp } from "./circuit-stamp";

/** Bumped when what a signature covers changes. */
export const CAPTURE_SIGNATURE = "sfab.capture-source@3";

/** A static sweep's source: the stamp, before any engine element. */
export function stampSignature(
  stamp: BoardStamp,
  source: { level: string; variant: string }
): string {
  return contentHash({
    signature: CAPTURE_SIGNATURE,
    kind: "stamp",
    ...source,
    stamp: {
      ...stamp,
      parts: stamp.parts.map(({ watch: _watch, ...part }) => part),
    },
  });
}

/**
 * A group's source: the composite at `level`/`variant`, the root's type,
 * body axis (the snapshot side may run any of its body levels) and
 * ratings, and every part the netlist reaches with its type, through the
 * composites of those parts too. `nested` names the reached parts with a
 * snapshot variant, whose files the hash does not cover. Null when that
 * variant is not a composite, or a part or type is missing.
 */
export function groupSource(
  partId: string,
  source: { level: string; variant: string },
  read: (id: string) => PartFile | null,
  readType: (id: string) => PartTypeFile | null
): { hash: string; nested: string[] } | null {
  const root = read(partId);
  const impl =
    root?.axes?.behaviour?.[source.level as "0"]?.variants[source.variant];
  if (!root || impl?.kind !== "composite") return null;
  const types: Record<string, PartTypeFile> = {};
  const typeOf = (part: PartFile): boolean => {
    if (typeof part.type !== "string") return true;
    if (types[part.type]) return true;
    const type = readType(part.type);
    if (!type) return false;
    types[part.type] = withoutResolutions(type);
    return true;
  };
  if (!typeOf(root)) return null;
  const parts: Record<string, unknown> = {};
  const nested: string[] = [];
  const queue = childrenOf(impl);
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    if (parts[id]) continue;
    const child = read(id);
    if (!child || !typeOf(child)) return null;
    parts[id] = sourceOf(child);
    for (const axis of Object.values(child.axes ?? {})) {
      for (const level of Object.values(axis ?? {})) {
        for (const variant of Object.values(level?.variants ?? {})) {
          const row = variant as BehaviourImpl;
          if (row.kind === "snapshot" && !nested.includes(id)) nested.push(id);
          queue.push(...childrenOf(row));
        }
      }
    }
  }
  const hash = contentHash({
    signature: CAPTURE_SIGNATURE,
    kind: "group",
    ...source,
    impl,
    type:
      typeof root.type === "string" ? root.type : withoutResolutions(root.type),
    body: root.axes?.body ?? null,
    ratings: root.ratings ?? null,
    parts,
    types,
  });
  return { hash, nested };
}

/** The hash of `groupSource`. */
export function groupSignature(
  partId: string,
  source: { level: string; variant: string },
  read: (id: string) => PartFile | null,
  readType: (id: string) => PartTypeFile | null
): string | null {
  return groupSource(partId, source, read, readType)?.hash ?? null;
}

/** A hinge's source: the gear train at `level`/`variant`, and the part's ratings. */
export function hingeSignature(
  part: PartFile,
  source: { level: string; variant: string }
): string | null {
  const impl = part.axes?.body?.[source.level as "0"]?.variants[source.variant];
  if (impl?.kind !== "gear-train") return null;
  return contentHash({
    signature: CAPTURE_SIGNATURE,
    kind: "hinge",
    ...source,
    train: impl,
    ratings: part.ratings ?? null,
  });
}

/**
 * A part as a group's source: what decides how it runs, its ratings
 * included. Its citations, capture recipe and visual axis do not.
 */
function sourceOf(part: PartFile): unknown {
  return {
    type:
      typeof part.type === "string" ? part.type : withoutResolutions(part.type),
    foreign: part.foreign ?? false,
    declaredOnly: part.declaredOnly ?? false,
    behaviour: part.axes?.behaviour ?? null,
    body: part.axes?.body ?? null,
    ratings: part.ratings ?? null,
  };
}

/** `type` as a run reads it: without the resolutions only a comparison reads. */
function withoutResolutions(type: PartTypeFile): PartTypeFile {
  const strip = <T extends { resolution?: unknown }>(row: T): T => {
    const { resolution: _resolution, ...rest } = row;
    return rest as T;
  };
  const out: PartTypeFile = {
    ...type,
    ports: Object.fromEntries(
      Object.entries(type.ports).map(([name, port]) => [name, strip(port)])
    ),
  };
  if (type.templates) out.templates = type.templates.map(strip);
  return out;
}

function childrenOf(impl: BehaviourImpl): string[] {
  if (impl.kind !== "composite") return [];
  return Object.values(impl.netlist.instances).map((row) => row.part);
}
