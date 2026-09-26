/**
 * Shared world geometry and the errors a run reports. Metres,
 * right-handed, Z-up. Rotation is a unit quaternion, scalar first
 * `[w, x, y, z]`. Identity is `[1, 0, 0, 0]`.
 *
 * Part numbers live in the catalog files the server resolves. This
 * module does not carry them.
 */

/** Metres, [x, y, z]. */
export type WorldVec3 = [number, number, number];

/** Unit quaternion, scalar first: [w, x, y, z]. */
export type WorldQuat = [number, number, number, number];

/**
 * Body frame. `position` is the origin in metres. `rotation` takes that
 * frame onto the world. Boxes are centered on this origin: rest one on
 * the ground by setting z to half its height.
 */
export type WorldPose = {
  position: WorldVec3;
  rotation: WorldQuat;
};

/**
 * Full edge lengths in metres. The box is centered on `pose`.
 */
export type WorldBox = {
  id: string;
  shape: "box";
  pose: WorldPose;
  size: WorldVec3;
};

export type WorldSphere = {
  id: string;
  shape: "sphere";
  pose: WorldPose;
  /** Radius in metres. */
  size: number;
};

export type WorldCylinder = {
  id: string;
  shape: "cylinder";
  pose: WorldPose;
  /** Radius and length in metres. Length is along the cylinder's local +Z. */
  size: { radius: number; length: number };
};

export type WorldPrimitive = WorldBox | WorldSphere | WorldCylinder;

/**
 * A STEP prop. The run does not load it: the shape is checked and the
 * file is not asked to exist.
 */
export type WorldStepProp = {
  id: string;
  /** Relative path to a `.step` or `.stp` file. */
  step: string;
  pose: WorldPose;
};

export const WORLD_ERROR_CODES = [
  "schema",
  "missing-file",
  "mesh-format",
] as const;

export type WorldErrorCode = (typeof WORLD_ERROR_CODES)[number];

export type WorldError = {
  code: WorldErrorCode;
  /** Dotted JSON path. Empty when the value is not an object at all. */
  path: string;
  message: string;
};
