/** Ported from layered-sim E5 gears.ts (c34b085): the rigid-gear collapse. */

import type { GearTrain } from "@sfab-bench/contract";
import { walkGearTrain } from "@sfab-bench/parts";

export type CollapsedHinge = {
  /** Σ n² J, kg·m². */
  armature: number;
  /** Σ n² B, N·m·s/rad. */
  damping: number;
  /** Σ |n| τ, N·m. Coulomb reflects with the speed ratio, not its square. */
  frictionloss: number;
  /** |ω_input / ω_output|. */
  ratio: number;
};

export type ReflectionRow = {
  name: string;
  speedRatio: number;
  inertia: number;
  reflectedInertia: number;
  reflectedDamping: number;
  reflectedFriction: number;
};

/**
 * Rigid gears, power-balanced:
 *   J_out = Σ n² J,   B_out = Σ n² B,   τ_out = Σ |n| τ
 * with n = ω_shaft / ω_output. Exact when every mesh is a holonomic
 * constraint and the loss torque is (1−η)·N·τ_em at the output.
 */
export function collapse(train: GearTrain): CollapsedHinge {
  const walked = walkGearTrain(train);
  if (walked.errors.length > 0) {
    throw new Error(walked.errors.join("; "));
  }
  let armature = 0;
  let damping = 0;
  let frictionloss = 0;
  for (const shaft of train.shafts) {
    const n = walked.ratios.get(shaft.name) ?? 0;
    armature += n * n * shaft.inertia;
    damping += n * n * shaft.damping;
    frictionloss += Math.abs(n) * shaft.frictionloss;
  }
  return {
    armature,
    damping,
    frictionloss,
    ratio: walked.ratios.get(train.input) ?? 0,
  };
}

export function reflection(train: GearTrain): ReflectionRow[] {
  const walked = walkGearTrain(train);
  if (walked.errors.length > 0) {
    throw new Error(walked.errors.join("; "));
  }
  return train.shafts.map((shaft) => {
    const n = walked.ratios.get(shaft.name) ?? 0;
    return {
      name: shaft.name,
      speedRatio: n,
      inertia: shaft.inertia,
      reflectedInertia: n * n * shaft.inertia,
      reflectedDamping: n * n * shaft.damping,
      reflectedFriction: Math.abs(n) * shaft.frictionloss,
    };
  });
}
