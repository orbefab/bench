/** Shared gear walk. The rigid collapse lives in the body engine. */

import type { GearTrain } from "./layered";

export type GearWalk = {
  ratios: Map<string, number>;
  errors: string[];
};

/** Shared with the body's collapse so a bad train fails the same way. */
export function walkGearTrain(train: GearTrain): GearWalk {
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
