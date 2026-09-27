// Ported from layered-sim E3 src/harness.ts installAdc @ fc7e8d3.
// avr8js times the conversion. The count is adcCount against the latched rail.

import {
  type ADCMuxInput,
  ADCMuxInputType,
  ADCReference,
  AVRADC,
  adcConfig,
  type CPU,
} from "avr8js";

import { adcCount, holdVoltage } from "./circuit/adc";

/** ATmega328P clock. One ADC clock is `prescaler` CPU cycles. */
const CPU_HZ = 16_000_000;

/**
 * Internal bandgap, the typical. DS40002061 ADC Characteristics, internal
 * voltage reference: 1.0 V min, 1.1 V typical, 1.2 V max. MUX 14.
 */
export const BANDGAP_V = 1.1;

/**
 * Temperature sensor at 25 °C. DS40002061 Table 24-2, typical case, 314 mV.
 * MUX 8. A constant: drift is omitted.
 */
export const TEMP_25_V = 0.314;

export type AnalogSource = {
  voltage: number;
  /** Ohms. Zero makes the sample-and-hold exact. */
  rSource: number;
};

export type AdcConversion = {
  /** `A0`–`A7`, `bandgap`, `gnd`, or `temp`. */
  mux: string;
  /** `avcc`, `bandgap`, `aref`, or `other`. */
  ref: string;
  vRef: number;
  voltage: number;
  count: number;
};

export type BoardAdcHooks = {
  /** Board node at the end of the previous 1 ms step. */
  supply: () => number;
  /** AREF net. 0 when that pin is unwired, and the count is then 0. */
  aref: () => number;
  /** Single-ended channel 0–7, sampled when the conversion starts. */
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
 * 1.1 V reference is the bandgap. AREF is the hooked net, or 0.
 */
export function attachBoardAdc(cpu: CPU, hooks: BoardAdcHooks): AVRADC {
  const adc = new AVRADC(cpu, adcConfig);
  const held = new Map<string, number>();
  adc.onADCRead = (input) => {
    const source = sourceOf(input, hooks);
    const prescaler = adc.prescaler;
    const adcClocks = adc.sampleCycles / prescaler;
    const sampleClocks = adcClocks > 13 ? 13.5 : 1.5;
    const tSample = (sampleClocks * prescaler) / CPU_HZ;
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
        mux: `A${input.channel}`,
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
    case ADCReference.AREF:
      return { name: "aref", voltage: aref };
    default:
      return { name: "other", voltage: 0 };
  }
}
