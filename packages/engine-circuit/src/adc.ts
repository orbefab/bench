// Ported from layered-sim E3 src/hold.ts @ fc7e8d3. Count is floor(V/Vref·1024).
import { adcCount, holdVoltage } from "@sfab-bench/contract";

export { ADC_C_SH, adcCount, holdVoltage } from "@sfab-bench/contract";

/** Sample-and-hold, then the conversion against the AVCC node. */
export function adcReading(
  vSrc: number,
  vRef: number,
  rSrc: number,
  tSample: number,
  vPrev = 0
): number {
  return adcCount(holdVoltage(vSrc, vPrev, rSrc, tSample), vRef);
}
