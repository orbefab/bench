/** A firmware chip, the board it runs as, and the electrical facts it carries. */

import { arduinoPinBit, type BehaviourImpl } from "@sfab-bench/contract";

export { boardHostOf, chipExposure } from "@sfab-bench/parts";

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
    return null;
  }
  return {
    railVoltage,
    resetFraction,
    minOperatingVoltage:
      typeof minOperatingVoltage === "number" ? minOperatingVoltage : null,
  };
}

/**
 * The 20 wire bits as chip pins: each Arduino header name that the board
 * exposes from its chip is that bit's pin.
 */
export function wireOf(
  exposure: ReadonlyMap<string, string>
): (string | null)[] {
  const wire: (string | null)[] = Array.from({ length: 20 }, () => null);
  for (const [port, pin] of exposure) {
    const bit = arduinoPinBit(port);
    if (bit !== undefined) wire[bit] = pin;
  }
  return wire;
}
