/** Piecewise-linear table interpolation. Parsing the file lives in `@sfab-bench/parts`. */
import type { TableLaw } from "@sfab-bench/contract";

/** Segment whose knots bracket `amps`. Ends extrapolate. */
export function segmentIndex(iAxis: readonly number[], amps: number): number {
  const last = iAxis.length - 2;
  if (amps <= (iAxis[0] ?? 0)) return 0;
  if (amps >= (iAxis[iAxis.length - 1] ?? 0)) return last;
  let k = 0;
  while (k < last && amps >= (iAxis[k + 1] ?? 0)) k++;
  return k;
}

/** `v = voc − r·i` on segment `k`. `r` is ohms. */
export function segmentThevenin(
  volts: readonly number[],
  iAxis: readonly number[],
  k: number
): { r: number; voc: number } {
  const i0 = iAxis[k] ?? 0;
  const i1 = iAxis[k + 1] ?? i0;
  const v0 = volts[k] ?? 0;
  const v1 = volts[k + 1] ?? v0;
  const di = i1 - i0;
  const r = di === 0 ? 0 : (v0 - v1) / di;
  return { r, voc: v0 + r * i0 };
}

export function tableVoltage(law: TableLaw, amps: number): number {
  const volts = law.vAxis;
  const k = segmentIndex(law.iAxis, amps);
  const { r, voc } = segmentThevenin(volts, law.iAxis, k);
  return voc - r * amps;
}
