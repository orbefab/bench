/** Host binding. Stamping lives in `@sfab-bench/sim`. */
import {
  type AssignedPart,
  type BoardStamp,
  type BoardStampOptions,
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
  assemblyStampOf as simAssemblyStampOf,
  boardStampOf as simBoardStampOf,
  stampBoard,
  touches,
} from "@sfab-bench/sim/circuit-stamp";

import { nodeStampEnv } from "./plan-host";

export type {
  AssignedPart,
  BoardStamp,
  BoardStampOptions,
  CircuitForm,
  CircuitInst,
  RealizedCircuit,
  StampedForm,
  StampedPin,
  StampedTable,
};
export {
  CIRCUIT_FORMS,
  circuitNumbers,
  connectorPort,
  describeNetlist,
  groundPorts,
  isCircuitForm,
  ldoLaw,
  liveNets,
  railPowerPorts,
  realize,
  stampBoard,
  touches,
};

export function boardStampOf(
  partId: string,
  variant: string,
  opts?: BoardStampOptions
): BoardStamp {
  return simBoardStampOf(partId, variant, opts, nodeStampEnv);
}

export function assemblyStampOf(
  partId: string,
  variant: string,
  opts?: BoardStampOptions
): BoardStamp {
  return simAssemblyStampOf(partId, variant, opts, nodeStampEnv);
}
