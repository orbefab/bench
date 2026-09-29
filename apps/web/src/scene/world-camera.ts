/**
 * The stage camera, read and set from outside the canvas. A part tab
 * restores this when it is focused. Absent until the canvas binds it.
 */

export type WorldCameraPose = {
  position: [number, number, number];
  target: [number, number, number];
};

let readPose: (() => WorldCameraPose | null) | null = null;
let writePose: ((pose: WorldCameraPose) => void) | null = null;
let pending: WorldCameraPose | null = null;

export function bindWorldCamera(
  read: (() => WorldCameraPose | null) | null,
  write: ((pose: WorldCameraPose) => void) | null
) {
  readPose = read;
  writePose = write;
  if (pending && write) {
    write(pending);
  }
}

export function captureWorldCamera(): WorldCameraPose | null {
  return readPose?.() ?? null;
}

/** Held until the stage fits, so a reload does not overwrite the pose. */
export function restoreWorldCamera(pose: WorldCameraPose | null) {
  pending = pose;
  if (pose) writePose?.(pose);
}

export function takePendingWorldCamera(): WorldCameraPose | null {
  const pose = pending;
  pending = null;
  return pose;
}

export function applyWorldCamera(pose: WorldCameraPose) {
  writePose?.(pose);
}
