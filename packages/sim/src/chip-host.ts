/** A firmware chip, the board it runs as, and the electrical facts it carries. */

import type { BehaviourImpl, ChipClock } from "@sfab-bench/contract";
import { chipSpec } from "@sfab-bench/engine-mcu";
import { chipExposure, type LiveInstance } from "@sfab-bench/parts";

export { boardHostOf } from "@sfab-bench/parts";

/** The chip's datasheet name and clock. Null when the registry lacks it. */
export function chipClock(chip: string): ChipClock | null {
  const spec = chipSpec(chip);
  return spec ? { label: spec.label, hz: spec.hz } : null;
}
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
/**
 * ADC channel to the header name that reaches that chip pin.
 *
 * The map is the board's expose, not a fixed A0–A7 table. An empty expose
 * is a bare chip: the label is the chip pin name (`PC0`, `PF7`). A channel
 * the board does not bring out is absent, and the run reads 0 V there.
 */
export function adcHeaderLabels(
  chipName: string,
  exposure: ReadonlyMap<string, string>
): Record<number, string> {
  const adcPins = chipSpec(chipName)?.adcPins ?? {};
  const labels: Record<number, string> = {};
  for (const [key, chipPin] of Object.entries(adcPins)) {
    const channel = Number(key);
    if (!Number.isInteger(channel)) continue;
    if (exposure.size === 0) {
      labels[channel] = chipPin;
      continue;
    }
    for (const [name, pin] of exposure) {
      if (pin === chipPin) {
        labels[channel] = name;
        break;
      }
    }
  }
  return labels;
}

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
