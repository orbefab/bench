/** Host binding. Stamping lives in `@sfab-bench/sim`. */
import { installPlanHost } from "./plan-host";

installPlanHost();

export {
  type AssignedPart,
  assemblyStampOf,
  type BoardStamp,
  type BoardStampOptions,
  boardStampOf,
  CIRCUIT_FORMS,
  type CircuitForm,
  type CircuitInst,
  circuitNumbers,
  connectorPort,
  describeNetlist,
  groundPorts,
  isCircuitForm,
  ldoLaw,
  liveNets,
  type RealizedCircuit,
  railPowerPorts,
  realize,
  type StampedForm,
  type StampedPin,
  type StampedTable,
  stampBoard,
  touches,
} from "@sfab-bench/sim/circuit-stamp";
