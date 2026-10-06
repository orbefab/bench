/** A firmware chip, the board it runs as, and the electrical facts it carries. */

import type { BehaviourImpl, ChipClock } from "@sfab-bench/contract";
import type { AvrPinParams } from "@sfab-bench/engine-circuit";
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
 * brownout level. The brownout levels, the reset hold and the pin drive
 * (`avr-pin@1`) are the variant's params. A variant that lacks any of them
 * does not run: the run names what is missing, it does not guess.
 */
export type ChipFacts = {
  railVoltage: number;
  resetFraction: number;
  minOperatingVoltage: number | null;
  brownoutVoltage: number;
  brownoutAssertVoltage: number;
  brownoutReleaseVoltage: number;
  resetHoldS: number;
  pin: AvrPinParams;
};

const CHIP_PARAMS = [
  "brownoutVoltage",
  "brownoutAssertVoltage",
  "brownoutReleaseVoltage",
  "resetHoldS",
  "roh",
  "rol",
  "rpu",
  "rLeak",
] as const;

/** The facts the variant lacks, by the name it would carry them under. */
export function missingChipFacts(behaviour: FirmwareBehaviour): string[] {
  const params = behaviour.params ?? {};
  return [
    ...(["railVoltage", "resetFraction"] as const).filter(
      (key) => typeof behaviour[key] !== "number"
    ),
    ...CHIP_PARAMS.filter((key) => typeof params[key] !== "number"),
  ];
}

export function chipFactsOf(behaviour: FirmwareBehaviour): ChipFacts | null {
  const { railVoltage, resetFraction, minOperatingVoltage } = behaviour;
  if (typeof railVoltage !== "number" || typeof resetFraction !== "number") {
    return null;
  }
  if (missingChipFacts(behaviour).length > 0) return null;
  // Every key is a number: `missingChipFacts` found none absent.
  const at = (key: (typeof CHIP_PARAMS)[number]) =>
    behaviour.params?.[key] as number;
  return {
    railVoltage,
    resetFraction,
    minOperatingVoltage:
      typeof minOperatingVoltage === "number" ? minOperatingVoltage : null,
    brownoutVoltage: at("brownoutVoltage"),
    brownoutAssertVoltage: at("brownoutAssertVoltage"),
    brownoutReleaseVoltage: at("brownoutReleaseVoltage"),
    resetHoldS: at("resetHoldS"),
    pin: { roh: at("roh"), rol: at("rol"), rpu: at("rpu"), rLeak: at("rLeak") },
  };
}

/** One exposed GPIO: the header name, and the chip pin it reaches. */
export type ExposedGpio = { name: string; chip: string };

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

/**
 * Header ports the board exposes onto a chip pin the emulator knows,
 * in expose order. Power, reset, and analog-only ports drop out: they
 * are not in the chip's GPIO table. The chip's port and bit stay on
 * `ChipSpec.pins`; this list is only names.
 */
function gpioPinsOf(
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

/**
 * The board's reset port: the header port the board exposes onto the
 * chip's `resetPort` (`RST` on the Pro Micro, `RESET` on the Nano and the
 * Uno). A chip that is its own board keeps its own name. Null when the
 * chip has no reset port or the board does not bring it out.
 */
export function boardResetPort(
  resetPort: string | undefined,
  chip: LiveInstance,
  host: LiveInstance,
  exposure: ReadonlyMap<string, string>
): string | null {
  if (!resetPort) return null;
  if (host === chip) return resetPort;
  for (const [name, pin] of exposure) if (pin === resetPort) return name;
  return null;
}
