/** Ported from layered-sim E4 (fd10742). Diode-law table evaluated as a Thevenin segment. */
import type { SnapshotFile } from "@sfab-bench/contract";

/** `5V.voltage` at `supplyRef`, shifted by `supplyAffine · (supply − supplyRef)`. */
export type TableLaw = {
  iAxis: readonly number[];
  vAxis: readonly number[];
  supplyRef: number;
  supplyAffine: number;
};

export type SnapshotEnvelope = {
  supply: [number, number];
  current: [number, number];
};

export function tableLawOf(snap: SnapshotFile): TableLaw | null {
  const iAxis = snap.params.iAxis;
  const vAxis = snap.params.vAxis;
  const supplyRef = snap.params.supplyRef;
  const supplyAffine = snap.params.supplyAffine;
  if (!Array.isArray(iAxis) || !Array.isArray(vAxis)) return null;
  if (iAxis.length < 2 || iAxis.length !== vAxis.length) return null;
  if (typeof supplyRef !== "number" || typeof supplyAffine !== "number") {
    return null;
  }
  return { iAxis, vAxis, supplyRef, supplyAffine };
}

export function envelopeOf(snap: SnapshotFile): SnapshotEnvelope | null {
  const supply = pair(snap.envelope.bounds["supply.voltage"]);
  const current = pair(snap.envelope.bounds["5V.current"]);
  if (!supply || !current) return null;
  return { supply, current };
}

function pair(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const lo = num(value[0]);
  const hi = num(value[1]);
  if (lo === null || hi === null) return null;
  return [lo, hi];
}

function num(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && "v" in value) {
    const v = (value as { v: unknown }).v;
    return typeof v === "number" ? v : null;
  }
  return null;
}

/** Voltage axis at `supply`, after the affine shift. */
export function shiftedVoltage(law: TableLaw, supply: number): number[] {
  const delta = law.supplyAffine * (supply - law.supplyRef);
  return law.vAxis.map((v) => v + delta);
}

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

export function tableVoltage(
  law: TableLaw,
  supply: number,
  amps: number
): number {
  const volts = shiftedVoltage(law, supply);
  const k = segmentIndex(law.iAxis, amps);
  const { r, voc } = segmentThevenin(volts, law.iAxis, k);
  return voc - r * amps;
}

const EDGE = 1e-9;

/** True when the point sits outside the envelope, past a 1 nA / 1 nV edge. */
export function outsideEnvelope(
  env: SnapshotEnvelope,
  supply: number,
  amps: number
): boolean {
  if (supply < env.supply[0] - EDGE || supply > env.supply[1] + EDGE) {
    return true;
  }
  if (amps < env.current[0] - EDGE || amps > env.current[1] + EDGE) {
    return true;
  }
  return false;
}
