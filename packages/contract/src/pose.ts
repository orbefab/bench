import type { Pose, Vec3 } from "./layered";

/** `v` turned by the unit quaternion `q` (`[w, x, y, z]`). */
export function rotateVec(q: Pose["rotation"], v: Vec3): Vec3 {
  const [w, x, y, z] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

/**
 * A child's pose in its parent's frame, taken into the frame the parent
 * sits in: the child is turned by the parent's rotation, then moved by
 * the parent's position.
 */
export function composePose(parent: Pose, child: Pose): Pose {
  const [aw, ax, ay, az] = parent.rotation;
  const [bw, bx, by, bz] = child.rotation;
  const turned = rotateVec(parent.rotation, child.position);
  return {
    position: [
      parent.position[0] + turned[0],
      parent.position[1] + turned[1],
      parent.position[2] + turned[2],
    ],
    rotation: [
      aw * bw - ax * bx - ay * by - az * bz,
      aw * bx + ax * bw + ay * bz - az * by,
      aw * by - ax * bz + ay * bw + az * bx,
      aw * bz + ax * by - ay * bx + az * bw,
    ],
  };
}
