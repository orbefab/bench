/**
 * Movable environment targets. A target is a MuJoCo mocap body: contact
 * does not move it, and its geoms have contype and conaffinity 0 so it
 * does not push a robot either. Rays still hit the geom.
 */

import type {
  WorldError,
  WorldTarget,
  WorldTargetKeyframe,
  WorldVec3,
} from "@sfab-bench/contract";

const ID_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

function finite3(value: unknown): value is WorldVec3 {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

function finite4(value: unknown): value is [number, number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

function schema(message: string): WorldError {
  return { code: "schema", path: "environment.targets", message };
}

function readPath(
  value: unknown,
  id: string
): WorldTargetKeyframe[] | WorldError {
  if (!Array.isArray(value) || value.length === 0) {
    return schema(`target "${id}" path is empty`);
  }
  const path: WorldTargetKeyframe[] = [];
  let previous = Number.NEGATIVE_INFINITY;
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      return schema(`target "${id}" has a path keyframe that is not an object`);
    }
    const row = entry as { t?: unknown; position?: unknown };
    if (typeof row.t !== "number" || !Number.isFinite(row.t) || row.t < 0) {
      return schema(
        `target "${id}" has a path time that is not a finite second`
      );
    }
    if (row.t <= previous) {
      return schema(`target "${id}" path times must increase`);
    }
    if (!finite3(row.position)) {
      return schema(`target "${id}" has a path position that is not metres`);
    }
    previous = row.t;
    path.push({ t: row.t, position: [...row.position] });
  }
  return path;
}

function readOne(value: unknown, seen: Set<string>): WorldTarget | WorldError {
  if (!value || typeof value !== "object") {
    return schema("a target is not an object");
  }
  const row = value as {
    id?: unknown;
    shape?: unknown;
    size?: unknown;
    pose?: unknown;
    path?: unknown;
  };
  if (typeof row.id !== "string" || !ID_RE.test(row.id)) {
    return schema("a target id must start with a letter");
  }
  if (seen.has(row.id)) return schema(`target "${row.id}" is repeated`);
  seen.add(row.id);
  const pose = row.pose as
    | { position?: unknown; rotation?: unknown }
    | undefined;
  if (!pose || !finite3(pose.position) || !finite4(pose.rotation)) {
    return schema(`target "${row.id}" pose is not a position and a quaternion`);
  }
  const position = [...pose.position] as WorldVec3;
  const rotation = [...pose.rotation] as [number, number, number, number];
  let path: WorldTargetKeyframe[] | undefined;
  if (row.path !== undefined) {
    const read = readPath(row.path, row.id);
    if ("code" in read) return read;
    path = read;
  }
  const shared = {
    id: row.id,
    pose: { position, rotation },
    ...(path ? { path } : {}),
  };
  if (row.shape === "box") {
    if (!finite3(row.size) || row.size.some((n) => !(n > 0))) {
      return schema(
        `target "${row.id}" box size must be three positive lengths`
      );
    }
    return { ...shared, shape: "box", size: [...row.size] };
  }
  if (row.shape === "sphere") {
    if (typeof row.size !== "number" || !(row.size > 0)) {
      return schema(`target "${row.id}" sphere size must be a positive radius`);
    }
    return { ...shared, shape: "sphere", size: row.size };
  }
  if (row.shape === "cylinder") {
    const size = row.size as { radius?: unknown; length?: unknown } | undefined;
    if (
      !size ||
      typeof size.radius !== "number" ||
      typeof size.length !== "number" ||
      !(size.radius > 0) ||
      !(size.length > 0)
    ) {
      return schema(
        `target "${row.id}" cylinder size needs a positive radius and length`
      );
    }
    return {
      ...shared,
      shape: "cylinder",
      size: { radius: size.radius, length: size.length },
    };
  }
  return schema(`target "${row.id}" shape is not box, sphere, or cylinder`);
}

/** Absent is no targets. Anything else that is not a list is an error. */
export function readTargets(
  value: unknown
): { ok: true; targets: WorldTarget[] } | { ok: false; error: WorldError } {
  if (value === undefined) return { ok: true, targets: [] };
  if (!Array.isArray(value)) {
    return { ok: false, error: schema("targets is not a list") };
  }
  const seen = new Set<string>();
  const targets: WorldTarget[] = [];
  for (const entry of value) {
    const one = readOne(entry, seen);
    if ("code" in one) return { ok: false, error: one };
    targets.push(one);
  }
  return { ok: true, targets };
}

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
