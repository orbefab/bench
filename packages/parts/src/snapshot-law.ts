/** Ported from layered-sim E4 (fd10742). Parsing half of a port-pair table. */
import type { SnapshotFile, TableLaw } from "@sfab-bench/contract";

export type { TableLaw };

export type SnapshotEnvelope = {
  /** Every numeric pair in `envelope.bounds`, keyed as in the file. */
  bounds: Record<string, [number, number]>;
  /** Through-current bound on `across[0]`. */
  current: [number, number];
};

export function tableLawOf(snap: SnapshotFile): TableLaw | null {
  const across = pairNames(snap.params.across);
  const iSense = snap.params.iSense;
  const iAxis = numList(snap.params.iAxis);
  const vAxis = numList(snap.params.vAxis);
  if (!across || (iSense !== 1 && iSense !== -1) || !iAxis || !vAxis) {
    return null;
  }
  if (iAxis.length < 2 || iAxis.length !== vAxis.length) return null;
  return { across, iSense, iAxis, vAxis };
}

export function envelopeOf(snap: SnapshotFile): SnapshotEnvelope | null {
  const law = tableLawOf(snap);
  if (!law) return null;
  const bounds: Record<string, [number, number]> = {};
  for (const [key, value] of Object.entries(snap.envelope.bounds)) {
    const parsed = pair(value);
    if (parsed) bounds[key] = parsed;
  }
  const current = bounds[`${law.across[0]}.current`];
  if (!current) return null;
  return { bounds, current };
}

function pair(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const lo = num(value[0]);
  const hi = num(value[1]);
  if (lo === null || hi === null) return null;
  return [lo, hi];
}

function pairNames(value: unknown): [string, string] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const p = value[0];
  const m = value[1];
  if (typeof p !== "string" || typeof m !== "string" || !p || !m) return null;
  return [p, m];
}

function numList(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: number[] = [];
  for (const item of value) {
    if (typeof item !== "number") return null;
    out.push(item);
  }
  return out;
}

function num(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && "v" in value) {
    const v = (value as { v: unknown }).v;
    return typeof v === "number" ? v : null;
  }
  return null;
}

const EDGE = 1e-9;

function outsideRange(range: [number, number], value: number): boolean {
  return value < range[0] - EDGE || value > range[1] + EDGE;
}

/** True when the point sits outside the envelope, past a 1 nA / 1 nV edge. */
export function outsideEnvelope(env: SnapshotEnvelope, amps: number): boolean {
  return amps < env.current[0] - EDGE || amps > env.current[1] + EDGE;
}

/**
 * First envelope key whose observed value sits outside.
 * Keys that were not observed are skipped. Source bounds are included
 * when the caller observed them.
 */
export function boundOutside(
  env: SnapshotEnvelope,
  observed: Readonly<Record<string, number>>
): { key: string; value: number; range: [number, number] } | null {
  const keys = Object.keys(observed).sort();
  for (const key of keys) {
    const range = env.bounds[key];
    if (!range) continue;
    const value = observed[key] ?? 0;
    if (outsideRange(range, value)) return { key, value, range };
  }
  return null;
}
