// Ported from layered-sim E3 src/harness.ts installAdc @ fc7e8d3.
// avr8js times the conversion. The count is adcCount against the latched rail.

import { adcCount, holdVoltage } from "@sfab-bench/contract";
import {
  type ADCMuxInput,
  ADCMuxInputType,
  ADCReference,
  AVRADC,
  type CPU,
} from "avr8js";
import type { ChipSpec } from "./chips";

/**
 * Internal bandgap, the typical. DS40002061 ADC Characteristics, internal
 * voltage reference: 1.0 V min, 1.1 V typical, 1.2 V max. MUX 14.
 */
export const BANDGAP_V = 1.1;

/**
 * Temperature sensor at 25 °C. DS40002061 Table 24-2, typical case, 314 mV.
 * MUX 8 on the 328P. A constant: drift is omitted. The 32U4 temperature mux
 * is left out of that chip's table, so it does not use this voltage.
 */
export const TEMP_25_V = 0.314;

/**
 * Internal 2.56 V ADC reference. ATmega32U4 datasheet Table 29-7, VINT
 * typical (min 2.4 V, max 2.8 V). The 328P's REFS 11 selects the 1.1 V
 * bandgap instead, so this reference is never chosen for that chip.
 */
export const INTERNAL_2V56_V = 2.56;

export type AnalogSource = {
  voltage: number;
  /** Ohms. Zero makes the sample-and-hold exact. */
  rSource: number;
  /**
   * Header label for a single-ended channel (`A0`, `D4`). Absent keeps
   * `A` plus the channel index, which is what the Nano's expose resolves to.
   */
  mux?: string;
};

export type AdcConversion = {
  /** Header label, `bandgap`, `gnd`, `temp`, or `diff`. */
  mux: string;
  /** `avcc`, `bandgap`, `internal-2v56`, `aref`, or `other`. */
  ref: string;
  vRef: number;
  voltage: number;
  count: number;
  /** Thevenin ohms of a stamped node. 0 on the wire-walk path. */
  rSource: number;
};

export type BoardAdcHooks = {
  /** Board node at the end of the previous 1 ms step. */
  supply: () => number;
  /** AREF net. 0 when that pin is unwired, and the count is then 0. */
  aref: () => number;
  /**
   * Single-ended channel, sampled when the conversion starts. The 328P
   * uses 0–7. The 32U4 also uses 8–13 (MUX5).
   */
  channel: (channel: number) => AnalogSource;
  converted?: (sample: AdcConversion) => void;
};

/**
 * Wire avr8js's ADC. The hook replaces `onADCRead` and schedules
 * `completeADCRead` after `sampleCycles`, which is avr8js's own window
 * (25 ADC clocks on the first conversion, 13 after).
 *
 * AVCC is `supply()` for the whole conversion: the worker latches the
 * board node before the CPU step, so the ADC sees the rail from the end
 * of the previous master step and lags it by at most 1 ms. The internal
 * 1.1 V reference is the bandgap. The 32U4's 2.56 V reference is
 * `INTERNAL_2V56_V`. AREF is the hooked net, or 0.
 */
export function attachBoardAdc(
  cpu: CPU,
  hooks: BoardAdcHooks,
  chip: ChipSpec
): AVRADC {
  const adc = new AVRADC(cpu, chip.adc);
  chip.onAdc?.(cpu);
  const held = new Map<string, number>();
  adc.onADCRead = (input) => {
    const source = sourceOf(input, hooks);
    const prescaler = adc.prescaler;
    const adcClocks = adc.sampleCycles / prescaler;
    const sampleClocks = adcClocks > 13 ? 13.5 : 1.5;
    // One ADC clock is `prescaler` CPU cycles.
    const tSample = (sampleClocks * prescaler) / chip.hz;
    const prev = held.get(source.mux) ?? 0;
    const voltage = holdVoltage(source.voltage, prev, source.rSource, tSample);
    held.set(source.mux, voltage);
    const ref = referenceOf(adc, hooks.supply(), hooks.aref());
    adc.avcc = hooks.supply();
    adc.aref = hooks.aref();
    const count = adcCount(voltage, ref.voltage);
    if (hooks.converted) {
      hooks.converted({
        mux: source.mux,
        ref: ref.name,
        vRef: ref.voltage,
        voltage,
        count,
        rSource: source.rSource,
      });
    }
    cpu.addClockEvent(() => adc.completeADCRead(count), adc.sampleCycles);
  };
  return adc;
}

function sourceOf(
  input: ADCMuxInput,
  hooks: BoardAdcHooks
): { mux: string; voltage: number; rSource: number } {
  switch (input.type) {
    case ADCMuxInputType.SingleEnded: {
      const read = hooks.channel(input.channel);
      return {
        mux: read.mux ?? `A${input.channel}`,
        voltage: read.voltage,
        rSource: read.rSource,
      };
    }
    case ADCMuxInputType.Temperature:
      return { mux: "temp", voltage: TEMP_25_V, rSource: 0 };
    case ADCMuxInputType.Constant:
      if (input.voltage === BANDGAP_V) {
        return { mux: "bandgap", voltage: BANDGAP_V, rSource: 0 };
      }
      return { mux: "gnd", voltage: 0, rSource: 0 };
    default:
      return { mux: "diff", voltage: 0, rSource: 0 };
  }
}

function referenceOf(
  adc: AVRADC,
  avcc: number,
  aref: number
): { name: string; voltage: number } {
  switch (adc.referenceVoltageType) {
    case ADCReference.AVCC:
      return { name: "avcc", voltage: avcc };
    case ADCReference.Internal1V1:
      return { name: "bandgap", voltage: BANDGAP_V };
    case ADCReference.Internal2V56:
      return { name: "internal-2v56", voltage: INTERNAL_2V56_V };
    case ADCReference.AREF:
      return { name: "aref", voltage: aref };
    default:
      return { name: "other", voltage: 0 };
  }
}
