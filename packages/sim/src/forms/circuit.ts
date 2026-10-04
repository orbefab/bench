/**
 * Circuit form stamps. Moved from `elementOf` (layered-sim A2b).
 */
import type { BehaviourImpl, FormId } from "@sfab-bench/contract";
import { FORM_PARAMS } from "@sfab-bench/contract";
import {
  BridgeDriver,
  Capacitor,
  Comparator,
  CurrentLoad,
  DcWinding,
  Diode,
  type DiodeParams,
  LawTable,
  LdoRegulator,
  PmosChannel,
  Potentiometer,
  PtcFuseElement,
  type PtcFuseParams,
  Resistor,
} from "@sfab-bench/engine-circuit";
import { mergeFormParams, siValue } from "@sfab-bench/parts";

import type { AssignedPart } from "../circuit-stamp";
import type { FormAdapter, StampedElements } from "./types";

function need(part: AssignedPart, port: string): string {
  const node = part.nodes[port];
  if (!node) throw new Error(`${part.path} has no ${port} node`);
  return node;
}

function needNum(part: AssignedPart, key: string): number {
  const value = part.params[key];
  if (!(typeof value === "number" && Number.isFinite(value))) {
    throw new Error(`${part.path} is missing ${key}`);
  }
  return value;
}

/** Same numbers `circuitNumbers` published for a circuit form. */
export function parseCircuitParams(
  behaviour: BehaviourImpl,
  params: Record<string, number | string | boolean>
): Record<string, number> | null {
  if (behaviour.kind !== "form") return null;
  const form = FORM_PARAMS[behaviour.form as FormId];
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(
    mergeFormParams(behaviour.params, params, form.params)
  )) {
    out[key] = siValue(value);
  }
  return out;
}

function stampResistor(part: AssignedPart): StampedElements {
  const a = need(part, "A");
  const b = need(part, "B");
  return {
    elements: [new Resistor(part.path, a, b, needNum(part, "R"))],
    capacitive: false,
  };
}

function stampTable(part: AssignedPart): StampedElements {
  const law = part.table?.law;
  if (!law) throw new Error(`${part.path} table is missing its law`);
  return {
    elements: [
      new LawTable(
        part.path,
        need(part, law.across[0]),
        need(part, law.across[1]),
        law
      ),
    ],
    capacitive: false,
  };
}

function stampPtc(part: AssignedPart): StampedElements {
  const params: PtcFuseParams = {
    rCold: needNum(part, "rCold"),
    rHot: needNum(part, "rHot"),
    iHold: needNum(part, "iHold"),
    iTrip: needNum(part, "iTrip"),
    tripPower: needNum(part, "tripPower"),
    tau: needNum(part, "tau"),
    uReset: needNum(part, "uReset"),
  };
  return {
    elements: [
      new PtcFuseElement(part.path, need(part, "A"), need(part, "B"), params),
    ],
    capacitive: false,
  };
}

function stampPmos(
  part: AssignedPart,
  assigned: readonly AssignedPart[]
): StampedElements {
  const gate = part.nodes.G;
  // A net's name is its first port. `t1.G` sorts first on the gate net,
  // so that string is also a wired gate. Unwired is the same string
  // with no other part on it.
  const shared =
    gate !== undefined &&
    assigned.some(
      (other) =>
        other.path !== part.path && Object.values(other.nodes).includes(gate)
    );
  if (!gate || (gate === `${part.path}.G` && !shared)) {
    throw new Error(`${part.path}: pmos-switch@1 has no gate net`);
  }
  const source = need(part, "S");
  const drain = need(part, "D");
  const diode: DiodeParams = {
    Is: needNum(part, "Is"),
    N: needNum(part, "N"),
    Rs: part.params.Rs ?? 0,
    tempC: 25,
  };
  return {
    elements: [
      new PmosChannel(
        part.path,
        source,
        drain,
        gate,
        needNum(part, "rds"),
        needNum(part, "vth")
      ),
      new Diode(`${part.path}#d`, drain, source, diode),
    ],
    capacitive: false,
  };
}

function stampCapacitor(part: AssignedPart): StampedElements {
  const a = need(part, "A");
  const b = need(part, "B");
  const esr = part.params.esr ?? 0;
  const c = needNum(part, "C");
  if (esr > 0) {
    const mid = `${part.path}#j`;
    return {
      elements: [
        new Resistor(`${part.path}#esr`, a, mid, esr),
        new Capacitor(part.path, mid, b, c),
      ],
      capacitive: true,
    };
  }
  return {
    elements: [new Capacitor(part.path, a, b, c)],
    capacitive: true,
  };
}

function stampLdo(part: AssignedPart): StampedElements {
  if (!part.ldo) throw new Error(`${part.path} is missing its regulator law`);
  return {
    elements: [
      new LdoRegulator(
        part.path,
        need(part, "IN"),
        need(part, "OUT"),
        need(part, "GND"),
        part.ldo
      ),
    ],
    capacitive: false,
  };
}

function stampComparator(part: AssignedPart): StampedElements {
  return {
    elements: [
      new Comparator(
        part.path,
        need(part, "P"),
        need(part, "N"),
        need(part, "OUT"),
        need(part, "VP"),
        need(part, "VN"),
        part.params.vHyst ?? 0
      ),
    ],
    capacitive: false,
  };
}

/** `dc-motor@1`: the winding. The run holds its shaft speed each master step. */
function stampWinding(part: AssignedPart): StampedElements {
  return {
    elements: [
      new DcWinding(
        part.path,
        need(part, "A"),
        need(part, "B"),
        needNum(part, "R"),
        part.params.L ?? 0,
        needNum(part, "K")
      ),
    ],
    capacitive: false,
  };
}

/**
 * Knee of the control's quiescent draw, volts. Below it the draw falls
 * with the supply, the way a board's own load does.
 */
export const CONTROL_KNEE_V = 1;

/**
 * `servo-control@1`: the averaged bridge on `M+`/`M-` and the quiescent
 * draw on `V+`. The run sets the bridge ratio from the pulse and the
 * latched sense ratio.
 */
function stampServoControl(part: AssignedPart): StampedElements {
  const vp = need(part, "V+");
  const gnd = need(part, "GND");
  const quiescent = new CurrentLoad(`${part.path}#q`, vp, gnd, CONTROL_KNEE_V);
  quiescent.amps = needNum(part, "quiescent");
  return {
    elements: [
      new BridgeDriver(
        part.path,
        vp,
        gnd,
        need(part, "M+"),
        need(part, "M-"),
        need(part, "sense")
      ),
      quiescent,
    ],
    capacitive: false,
  };
}

/** `potentiometer@1`: the track and the wiper. The run holds the wiper each master step. */
function stampPotentiometer(part: AssignedPart): StampedElements {
  return {
    elements: [
      new Potentiometer(
        part.path,
        need(part, "A"),
        need(part, "W"),
        need(part, "B"),
        needNum(part, "R")
      ),
    ],
    capacitive: false,
  };
}

function diodeOf(part: AssignedPart): Diode {
  const params: DiodeParams = {
    Is: needNum(part, "Is"),
    N: needNum(part, "N"),
    Rs: part.params.Rs ?? 0,
    tempC: 25,
  };
  return new Diode(part.path, need(part, "A"), need(part, "K"), params);
}

/** The trailing branch of the old chain. Any form it does not know is a diode. */
export function stampDiode(part: AssignedPart): StampedElements {
  return { elements: [diodeOf(part)], capacitive: false };
}

/** The same diode, its forward current recorded under the LED's path. */
function stampLed(part: AssignedPart): StampedElements {
  const diode = diodeOf(part);
  return {
    elements: [diode],
    capacitive: false,
    led: { path: part.path, diode },
  };
}

function circuit(
  id: string,
  stamp: FormAdapter["stamp"],
  ports?: readonly string[],
  supply?: Pick<FormAdapter, "power" | "unpowered">
): FormAdapter {
  return {
    id,
    stamp,
    parse: parseCircuitParams,
    ...(ports ? { ports } : {}),
    ...supply,
  };
}

export const circuitAdapters: FormAdapter[] = [
  circuit("resistor@1", stampResistor),
  circuit("capacitor@1", stampCapacitor),
  circuit("diode@1", stampDiode, ["A", "K"]),
  circuit("led@1", stampLed, ["A", "K"]),
  circuit("ptc-fuse@1", stampPtc),
  circuit("pmos-switch@1", stampPmos),
  // Unpowered, the regulator's output is open: its reverse path is in the
  // parts' omits.
  circuit("ldo-regulator@1", stampLdo, undefined, {
    power: { from: "IN", to: ["OUT"] },
  }),
  // Unpowered, both output rails are `VN`: the output sits at its
  // negative rail whatever the inputs.
  circuit("comparator@1", stampComparator, undefined, {
    power: { from: "VP", to: ["OUT"] },
    unpowered: (part) =>
      part.nodes.VN === undefined
        ? null
        : { ...part, nodes: { ...part.nodes, VP: part.nodes.VN } },
  }),
  circuit("dc-motor@1", stampWinding, ["A", "B"]),
  circuit("servo-control@1", stampServoControl, [
    "V+",
    "GND",
    "M+",
    "M-",
    "sense",
  ]),
  circuit("potentiometer@1", stampPotentiometer, ["A", "W", "B"]),
  { id: "table@1", stamp: stampTable },
];
