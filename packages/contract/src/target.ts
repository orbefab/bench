import type { WorldTarget, WorldVec3 } from "./world";

/**
 * Position at `timeS`. Linear between keyframes, the first keyframe
 * before the path starts, and the last keyframe after it ends. `hold`
 * is an agent move: it replaces the path from the step that applies it.
 */
export function targetPosition(
  target: WorldTarget,
  timeS: number,
  hold: WorldVec3 | null
): WorldVec3 {
  if (hold) return hold;
  const path = target.path;
  const first = path?.[0];
  if (!path || !first) return target.pose.position;
  if (timeS <= first.t) return first.position;
  const last = path[path.length - 1];
  if (!last || timeS >= last.t) return last?.position ?? first.position;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    if (!a || !b || timeS > b.t) continue;
    const span = b.t - a.t;
    const u = span > 0 ? (timeS - a.t) / span : 1;
    return [
      a.position[0] + (b.position[0] - a.position[0]) * u,
      a.position[1] + (b.position[1] - a.position[1]) * u,
      a.position[2] + (b.position[2] - a.position[2]) * u,
    ];
  }
  return last.position;
}
