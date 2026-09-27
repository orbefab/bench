/** Ported from layered-sim E5 gears.ts (c34b085): the rigid-gear collapse. */

import type { GearTrain } from "@sfab-bench/contract";

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

type Walk = {
  ratios: Map<string, number>;
  errors: string[];
};

/**
 * Rigid gears, power-balanced:
 *   J_out = Σ n² J,   B_out = Σ n² B,   τ_out = Σ |n| τ
 * with n = ω_shaft / ω_output. Exact when every mesh is a holonomic
 * constraint and the loss torque is (1−η)·N·τ_em at the output.
 */
export function collapse(train: GearTrain): CollapsedHinge {
  const walked = walk(train);
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
  const walked = walk(train);
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

/** Each failure names the part and the shaft or mesh. */
export function gearTrainErrors(partId: string, train: GearTrain): string[] {
  return walk(train).errors.map((error) => `${partId} ${error}`);
}

function walk(train: GearTrain): Walk {
  const errors: string[] = [];
  const names = new Set<string>();
  for (const shaft of train.shafts) {
    if (names.has(shaft.name)) {
      errors.push(`shaft ${shaft.name}: duplicate name`);
    }
    names.add(shaft.name);
  }
  train.meshes.forEach((mesh, index) => {
    const label = meshLabel(mesh, index);
    if (!positiveInt(mesh.teethDriver) || !positiveInt(mesh.teethDriven)) {
      errors.push(`mesh ${label}: teeth must be positive integers`);
    }
    if (!names.has(mesh.driver)) {
      errors.push(`mesh ${label}: shaft ${mesh.driver} is not in the train`);
    }
    if (!names.has(mesh.driven)) {
      errors.push(`mesh ${label}: shaft ${mesh.driven} is not in the train`);
    }
    if (mesh.driver !== "" && mesh.driver === mesh.driven) {
      errors.push(`mesh ${label}: names one shaft twice`);
    }
  });
  if (!names.has(train.output)) {
    errors.push(`output shaft ${train.output} is missing`);
  }
  if (!names.has(train.input)) {
    errors.push(`input shaft ${train.input} is missing`);
  }
  if (errors.length > 0) return { ratios: new Map(), errors: unique(errors) };

  const ratios = new Map<string, number>([[train.output, 1]]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const mesh of train.meshes) {
      const driven = ratios.get(mesh.driven);
      if (driven === undefined) continue;
      const next = driven * (mesh.teethDriven / mesh.teethDriver);
      const have = ratios.get(mesh.driver);
      if (have === undefined) {
        ratios.set(mesh.driver, next);
        grew = true;
        continue;
      }
      const scale = Math.max(1, Math.abs(have), Math.abs(next));
      if (Math.abs(have - next) > 1e-9 * scale) {
        errors.push(`shaft ${mesh.driver}: reached twice at different ratios`);
      }
    }
  }
  for (const shaft of train.shafts) {
    if (!ratios.has(shaft.name)) {
      errors.push(`shaft ${shaft.name}: not reached from ${train.output}`);
    }
  }
  return { ratios, errors: unique(errors) };
}

function meshLabel(
  mesh: { driver: string; driven: string },
  index: number
): string {
  const driver = mesh.driver || "?";
  const driven = mesh.driven || "?";
  return `${index}:${driver}→${driven}`;
}

function positiveInt(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function unique(errors: string[]): string[] {
  return [...new Set(errors)];
}
