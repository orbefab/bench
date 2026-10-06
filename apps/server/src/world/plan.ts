/** Host binding. The planner lives in `@sfab-bench/sim`. */
import {
  type PlanResult,
  type RunBoard,
  type RunBox,
  type RunLevel,
  type RunMotor,
  type RunPart,
  type RunPin,
  type RunPlan,
  type RunRobot,
  type RunSupply,
  planWorld as simPlanWorld,
  WORLD_V1_MESSAGE,
} from "@sfab-bench/sim/plan";

import { nodePlanEnv } from "./plan-host";

export type { RunRanger } from "@sfab-bench/sim/ranger";
export { catalogRoot } from "./plan-host";
export type {
  PlanResult,
  RunBoard,
  RunBox,
  RunLevel,
  RunMotor,
  RunPart,
  RunPin,
  RunPlan,
  RunRobot,
  RunSupply,
};
export { WORLD_V1_MESSAGE };

export function planWorld(
  project: string,
  worldRel: string,
  options: { context?: boolean } = {}
): PlanResult {
  return simPlanWorld(project, worldRel, nodePlanEnv, options);
}
