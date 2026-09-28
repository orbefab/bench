/** Gear-train checks. The walk is shared with the body engine. */

import {
  type GearTrain,
  type GearWalk,
  walkGearTrain,
} from "@sfab-bench/contract";

export type { GearWalk };
export { walkGearTrain };

/** Each failure names the part and the shaft or mesh. */
export function gearTrainErrors(partId: string, train: GearTrain): string[] {
  return walkGearTrain(train).errors.map((error) => `${partId} ${error}`);
}
