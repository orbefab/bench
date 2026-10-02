/** A firmware chip, the board it runs as, and the electrical facts it carries. */

import type { BehaviourImpl } from "@sfab-bench/contract";
import { chipSpec } from "@sfab-bench/engine-mcu";
import { chipExposure, type LiveInstance } from "@sfab-bench/parts";

export { boardHostOf } from "@sfab-bench/parts";
export { chipExposure };

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

/** One exposed GPIO: the header name, and the chip pin it reaches. */
export type ExposedGpio = { name: string; chip: string };

/**
 * Header ports the board exposes onto a chip pin the emulator knows,
 * in expose order. Power, reset, and analog-only ports drop out: they
 * are not in the chip's GPIO table. The chip's port and bit stay on
 * `ChipSpec.pins`; this list is only names.
 */
export function gpioPinsOf(
  chipName: string,
  exposure: ReadonlyMap<string, string>
): ExposedGpio[] {
  const pins = chipSpec(chipName)?.pins ?? {};
  const out: ExposedGpio[] = [];
  for (const [name, chip] of exposure) {
    if (pins[chip]) out.push({ name, chip });
  }
  return out;
}

/**
 * GPIO for the board this firmware runs as.
 * A bare chip authors no expose table. Each pin in the chip spec is
 * then its own header name, in that spec's order.
 */
export function boardGpio(
  chipName: string,
  chip: LiveInstance,
  host: LiveInstance
): ExposedGpio[] {
  const exposure = chipExposure(chip, host);
  if (host === chip && exposure.size === 0) {
    const pins = chipSpec(chipName)?.pins ?? {};
    return Object.keys(pins).map((name) => ({ name, chip: name }));
  }
  return gpioPinsOf(chipName, exposure);
}
