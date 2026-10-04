/**
 * The source a capture ran, as one hash: `provenance.from.hash`. The
 * capture runners write it and freshness recomputes it with the same
 * function, so a capture is stale exactly when its source changed.
 *
 * Each signature covers the source's own definition, not the engine
 * built from it:
 * - a static sweep: the stamp it swept, every part with the form, the
 *   numbers that form parsed, its nodes, and any table or regulator law;
 * - a group: the source composite, the root's type and body axis, and
 *   every part and type the netlist reaches;
 * - a hinge: the gear train.
 *
 * Each names the level and variant it read. Visual axes, citations and
 * snapshot bounds are not the source, so editing them leaves a capture
 * fresh. A group's signature does not open a snapshot file a child
 * selects; the catalog groups run their children as forms.
 */
import type {
  BehaviourImpl,
  PartFile,
  PartTypeFile,
} from "@sfab-bench/contract";
import { contentHash } from "@sfab-bench/parts";

import type { BoardStamp } from "./circuit-stamp";

/** Bumped when what a signature covers changes. */
export const CAPTURE_SIGNATURE = "sfab.capture-source@2";

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
 * A group's source: the composite at `level`/`variant`, the root's type
 * and body axis (the snapshot side may run any of its body levels), and
 * every part the netlist reaches with its type, through the composites
 * of those parts too. Null when that variant is not a composite, or a
 * part or type is missing.
 */
export function groupSignature(
  partId: string,
  source: { level: string; variant: string },
  read: (id: string) => PartFile | null,
  readType: (id: string) => PartTypeFile | null
): string | null {
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
    types[part.type] = type;
    return true;
  };
  if (!typeOf(root)) return null;
  const parts: Record<string, unknown> = {};
  const queue = childrenOf(impl);
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    if (parts[id]) continue;
    const child = read(id);
    if (!child || !typeOf(child)) return null;
    parts[id] = sourceOf(child);
    for (const axis of Object.values(child.axes ?? {})) {
      for (const level of Object.values(axis ?? {})) {
        for (const variant of Object.values(level?.variants ?? {})) {
          queue.push(...childrenOf(variant as BehaviourImpl));
        }
      }
    }
  }
  return contentHash({
    signature: CAPTURE_SIGNATURE,
    kind: "group",
    ...source,
    impl,
    type: root.type,
    body: root.axes?.body ?? null,
    parts,
    types,
  });
}

/** A hinge's source: the gear train at `level`/`variant`. */
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
  });
}

/**
 * A part as a group's source: what decides how it runs. Its citations,
 * ratings, capture recipe and visual axis do not.
 */
function sourceOf(part: PartFile): unknown {
  return {
    type: part.type,
    foreign: part.foreign ?? false,
    declaredOnly: part.declaredOnly ?? false,
    behaviour: part.axes?.behaviour ?? null,
    body: part.axes?.body ?? null,
  };
}

function childrenOf(impl: BehaviourImpl): string[] {
  if (impl.kind !== "composite") return [];
  return Object.values(impl.netlist.instances).map((row) => row.part);
}
