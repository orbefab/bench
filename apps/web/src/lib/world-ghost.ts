/**
 * The snapshot ghost on the card and in the scene. The card offers it on
 * a part that runs a detailed behaviour that has a snapshot option; the
 * run then carries a second run of the same world with only that
 * behaviour on the snapshot.
 */

import type {
  WorldGhostSpec,
  WorldGhostState,
  WorldViewNode,
} from "@sfab-bench/contract";

/**
 * A robot is drawn as a ghost once its largest joint gap passes this, in
 * radians (0.01°). Under it the two would sit inside each other.
 */
export const GHOST_SHOWN_RAD = (0.01 * Math.PI) / 180;

export type GhostOffer = WorldGhostSpec & { ref: string };

/**
 * The snapshot this node's behaviour could run as, when it runs a
 * detailed level now. Null when it already runs a snapshot, or has none.
 */
export function ghostOffer(node: WorldViewNode): GhostOffer | null {
  const axis = node.levels.find((row) => row.axis === "behaviour");
  if (!axis?.chosen) return null;
  const chosen = axis.chosen;
  const current = axis.options.find(
    (option) =>
      option.class === chosen.class && option.variant === chosen.variant
  );
  if (!current || current.ref) return null;
  const snapshot = axis.options.find(
    (option) => option.ref !== undefined && option.runnable
  );
  if (!snapshot?.ref) return null;
  return {
    path: node.id,
    class: snapshot.class,
    variant: snapshot.variant,
    ref: snapshot.ref,
  };
}

function degrees(radians: number): string {
  return `${((radians * 180) / Math.PI).toFixed(2)}°`;
}

export type GhostReadout =
  | { kind: "error"; text: string }
  | { kind: "gap"; ref: string; lines: string[] };

/** What the card says about the ghost at `path`. Null when it is not on. */
export function ghostReadout(
  ghost: WorldGhostState | undefined,
  path: string
): GhostReadout | null {
  if (!ghost || ghost.path !== path) return null;
  if ("error" in ghost) return { kind: "error", text: ghost.error };
  const lines = ghost.joints
    .slice(0, 3)
    .map(
      (row) =>
        `${row.robot}/${row.joint}  now ${degrees(row.now)}  max ${degrees(row.max)}`
    );
  return {
    kind: "gap",
    ref: ghost.ref ?? ghost.impl,
    lines: lines.length > 0 ? lines : ["no joints to compare"],
  };
}

/** Robots far enough from their ghost to draw it. */
export function ghostRobots(ghost: WorldGhostState | undefined): Set<string> {
  const out = new Set<string>();
  if (!ghost || "error" in ghost) return out;
  for (const row of ghost.joints) {
    if (row.max > GHOST_SHOWN_RAD) out.add(row.robot);
  }
  return out;
}
