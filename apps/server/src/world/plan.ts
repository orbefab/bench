/** Host binding. The planner lives in `@sfab-bench/sim`. */
import { installPlanHost } from "./plan-host";

installPlanHost();

export {
  type PlanResult,
  planWorld,
  type RunBoard,
  type RunBox,
  type RunLevel,
  type RunMotor,
  type RunPart,
  type RunPin,
  type RunPlan,
  type RunRobot,
  type RunSupply,
  WORLD_V1_MESSAGE,
} from "@sfab-bench/sim/plan";
export type { RunRanger } from "@sfab-bench/sim/ranger";
export { catalogRoot } from "./plan-host";
