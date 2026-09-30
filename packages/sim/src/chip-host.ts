/** A firmware chip, the board it runs as, and the electrical facts it carries. */

import {
  ATMEGA328P_16MHZ_MIN_V,
  type BehaviourImpl,
} from "@sfab-bench/contract";
import { behaviourNetlist, type LiveInstance } from "@sfab-bench/parts";

import { chipFacts } from "./power-path";

export type FirmwareBehaviour = Extract<BehaviourImpl, { kind: "firmware" }>;

/**
 * What the run knows about a chip, read from the resolved chip part's firmware
 * variant. `railVoltage` picks the board's power input, `resetFraction` is
 * V_RST / VCC, and `minOperatingVoltage` opens the SOA band above the
 * brownout level. A variant that carries no rail or reset fraction is an
 * unknown chip.
 */
export type ChipFacts = {
  railVoltage: number;
  resetFraction: number;
  minOperatingVoltage: number | null;
};

export function chipFactsOf(behaviour: FirmwareBehaviour): ChipFacts | null {
  const { railVoltage, resetFraction, minOperatingVoltage } = behaviour;
  if (typeof railVoltage !== "number" || typeof resetFraction !== "number") {
    // The single-part boards carry no facts until they become composites.
    const legacy = chipFacts(behaviour.chip);
    return legacy
      ? { ...legacy, minOperatingVoltage: ATMEGA328P_16MHZ_MIN_V }
      : null;
  }
  return {
    railVoltage,
    resetFraction,
    minOperatingVoltage:
      typeof minOperatingVoltage === "number" ? minOperatingVoltage : null,
  };
}

/**
 * The instance a firmware part runs as.
 *
 * A firmware chip that is a netlist child runs as its parent's board; a
 * firmware part that is not a child is its own board. A child means the parent
 * is a composite whose `expose` reaches one of the chip's ports: the header
 * ports are the parent's, so the board id, the pins, the power input and the
 * `VIN` and `VBUS` ports are the parent's too. A scene wires its parts
 * and exposes none of them, so a board in a scene stays its own board.
 */
export function boardHostOf(
  chip: LiveInstance,
  byPath: ReadonlyMap<string, LiveInstance>,
  rootPath: string
): LiveInstance {
  const dot = chip.path.lastIndexOf(".");
  const parent = byPath.get(dot < 0 ? rootPath : chip.path.slice(0, dot));
  if (!parent || parent === chip) return chip;
  const behaviour = parent.axes.behaviour.impl as BehaviourImpl | null;
  const netlist = behaviourNetlist(parent.part, behaviour);
  if (!netlist) return chip;
  const child = chip.path.slice(dot + 1);
  const exposed = Object.values(netlist.expose).some((target) =>
    target.startsWith(`${child}.`)
  );
  return exposed ? parent : chip;
}
