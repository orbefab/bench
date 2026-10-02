/** Brownout numbers from the ATmega328P chip part, not from a code constant. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ResetLimits } from "@sfab-bench/sim";

type ChipParams = {
  brownoutAssertVoltage: number;
  brownoutReleaseVoltage: number;
  resetHoldS: number;
};

const params = (
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(
          "../../catalog/parts/sfab/atmega328p@1.0.0.json",
          import.meta.url
        )
      ),
      "utf8"
    )
  ) as {
    axes: {
      behaviour: {
        "1": { variants: { avr8js: { params: ChipParams } } };
      };
    };
  }
).axes.behaviour["1"].variants.avr8js.params;

/** Falling threshold, from the chip's `brownoutAssertVoltage`. */
export const BOD_ASSERT_V = params.brownoutAssertVoltage;
/** Rising threshold, from the chip's `brownoutReleaseVoltage`. */
export const BOD_RELEASE_V = params.brownoutReleaseVoltage;
/** `resetHoldS` in milliseconds, rounded so the step compare stays exact. */
export const RESET_HOLD_MS = Math.round(params.resetHoldS * 1000);

export const BROWNOUT_LIMITS: ResetLimits = {
  assertV: BOD_ASSERT_V,
  releaseV: BOD_RELEASE_V,
  holdMs: RESET_HOLD_MS,
};
