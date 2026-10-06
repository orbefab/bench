/**
 * The snapshot ghost: the same world run a second time with one path's
 * behaviour set to its snapshot. Both runs step together with the same
 * inputs, so the gap between their joints is the snapshot's error in this
 * world, live.
 */
import type {
  RunReport,
  WorldGhostJoint,
  WorldGhostSpec,
  WorldGhostState,
  WorldState,
} from "@sfab-bench/contract";
import { applyLevelEdit, type LevelTable } from "@sfab-bench/parts";
import type { PlanEnv } from "../env";

/** The world file text with the ghost's level written into `play.levels`. */
export function ghostWorldText(
  text: string,
  spec: WorldGhostSpec
): { text: string } | { error: string } {
  let doc: unknown;
  try {
    doc = JSON.parse(text) as unknown;
  } catch {
    return { error: "the world file is not JSON" };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { error: "the world file is not a document" };
  }
  const root = doc as { play?: { levels?: LevelTable } };
  const levels = root.play?.levels ?? { default: 1 };
  const edited = applyLevelEdit(levels, {
    scope: "path",
    key: spec.path,
    axis: "behaviour",
    class: spec.class,
    variant: spec.variant,
  });
  if ("error" in edited) return { error: edited.error };
  root.play = { ...(root.play ?? {}), levels: edited.levels };
  return { text: JSON.stringify(root) };
}

/**
 * The host's plan env, with the world file read as `text`. Every other
 * file is the host's.
 */
export function ghostPlanEnv(
  env: PlanEnv,
  worldAbs: string,
  text: string
): PlanEnv {
  const key = (file: string): string => {
    try {
      return env.realpath(env.absolutePath(file));
    } catch {
      return env.absolutePath(file);
    }
  };
  const target = key(worldAbs);
  const isWorld = (file: string) => key(file) === target;
  return {
    ...env,
    readText: (file) => (isWorld(file) ? text : env.readText(file)),
    store: {
      ...env.store,
      readText: (file) => (isWorld(file) ? text : env.store.readText(file)),
    },
  };
}

/**
 * Null when the ghost's report runs `path`'s behaviour from a snapshot,
 * else why not. The snapshot's ref when it does.
 */
export function ghostRunsSnapshot(
  report: RunReport | null,
  path: string
): { ref: string; impl: string } | { error: string } {
  if (!report) return { error: "the ghost run has no report" };
  const row = report.levels.find(
    (item) => item.path === path && item.axis === "behaviour"
  );
  if (!row) return { error: `the ghost run has no behaviour at ${path}` };
  const snap = report.snapshots.find(
    (item) => item.path === path && item.axis === "behaviour"
  );
  if (!snap) {
    return {
      error: `the ghost runs ${path} as ${row.impl}, not a snapshot`,
    };
  }
  return { ref: snap.ref, impl: row.impl };
}

type Pair = {
  robot: string;
  joint: string;
  run: number;
  ghost: number;
  max: number;
  now: number;
};

/**
 * Joint pairs matched by robot and joint name, by qpos address in each
 * run. A joint only one run has is left out.
 */
export function ghostPairs(
  run: { robot: string; joint: string; qposadr: number }[],
  ghost: { robot: string; joint: string; qposadr: number }[]
): Pair[] {
  const byName = new Map(
    ghost.map((item) => [`${item.robot}\0${item.joint}`, item.qposadr])
  );
  const out: Pair[] = [];
  for (const item of run) {
    const at = byName.get(`${item.robot}\0${item.joint}`);
    if (at === undefined) continue;
    out.push({
      robot: item.robot,
      joint: item.joint,
      run: item.qposadr,
      ghost: at,
      max: 0,
      now: 0,
    });
  }
  return out;
}

/** Fold this step's gap into each pair. */
export function measurePairs(
  pairs: Pair[],
  run: Float64Array,
  ghost: Float64Array
): void {
  for (const pair of pairs) {
    const gap = Math.abs((run[pair.run] ?? 0) - (ghost[pair.ghost] ?? 0));
    pair.now = gap;
    if (gap > pair.max) pair.max = gap;
  }
}

export function ghostJoints(pairs: Pair[]): WorldGhostJoint[] {
  return pairs
    .map(({ robot, joint, now, max }) => ({ robot, joint, now, max }))
    .sort(
      (a, b) =>
        b.max - a.max ||
        a.robot.localeCompare(b.robot) ||
        a.joint.localeCompare(b.joint)
    );
}

export type GhostReading = {
  spec: WorldGhostSpec;
  ref?: string;
  impl?: string;
  error?: string;
  poses: () => WorldState["poses"] | null;
  pairs: Pair[];
};

export function ghostState(reading: GhostReading): WorldGhostState {
  const path = reading.spec.path;
  if (reading.error) return { path, error: reading.error };
  const poses = reading.poses();
  if (!poses) return { path, error: "the ghost run stopped" };
  return {
    path,
    ...(reading.ref ? { ref: reading.ref } : {}),
    impl: reading.impl ?? "",
    poses,
    joints: ghostJoints(reading.pairs),
  };
}
