// Ported from layered-sim E3 src/hold.ts @ fc7e8d3. Count is floor(V/Vref·1024).
/** Figure 24-8, sample-and-hold capacitance. Not a live circuit node. */
export const ADC_C_SH = 14e-12;

/**
 * Held voltage after `tSample` seconds from a resistive source.
 * `vPrev` is the previous hold on that channel (0 at reset).
 */
export function holdVoltage(
  vSrc: number,
  vPrev: number,
  rSrc: number,
  tSample: number,
  cSh = ADC_C_SH
): number {
  if (!(rSrc > 0) || !(tSample > 0) || !(cSh > 0)) return vSrc;
  const k = Math.exp(-tSample / (rSrc * cSh));
  return vSrc + (vPrev - vSrc) * k;
}

/**
 * Datasheet conversion. `vRef` is the AVCC node at the sample, not a
 * constant 5 V. Results outside 0..1023 clamp to the ends.
 */
export function adcCount(v: number, vRef: number): number {
  if (!(vRef > 0)) return 0;
  const raw = Math.floor((v / vRef) * 1024);
  if (raw < 0) return 0;
  if (raw > 1023) return 1023;
  return raw;
}

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
