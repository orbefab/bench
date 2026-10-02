import type { Object3D } from "three";

/** The world content group, so Home frames the robots and not the ground. */
let target: Object3D | null = null;

export function setWorldFitTarget(obj: Object3D | null) {
  target = obj;
}

export function worldFitTarget(): Object3D | null {
  return target;
}
