/** Ported from layered-sim E4 (fd10742). One port-pair table, as a segment. */
import type { SnapshotFile } from "@sfab-bench/contract";

/**
 * `vAxis` is `V(across[0]) − V(across[1])`.
 * `iAxis` is current into `across[0]` when `iSense` is 1, and current
 * out of that port when `iSense` is -1. A source's output is negative
 * under the port convention, so a feed table stores the delivered
 * current with `iSense: -1` and keeps those knots positive.
 */
export type TableLaw = {
  across: readonly [string, string];
  iSense: 1 | -1;
  iAxis: readonly number[];
  vAxis: readonly number[];
  /** Present together. The named input's voltage shifts `vAxis`. */
  supplyPort?: string;
  supplyRef?: number;
  supplyAffine?: number;
};

/** `feed` replaces a Thevenin source. `branch` is a two-terminal law. */
export type TableUse = "feed" | "branch";

export type SnapshotEnvelope = {
  /** Every numeric pair in `envelope.bounds`, keyed as in the file. */
  bounds: Record<string, [number, number]>;
  /** Through-current bound on `across[0]`. */
  current: [number, number];
  /** Supply-port voltage bound. Null when the table has no supply term. */
  supply: [number, number] | null;
};

/** The feeding port the table was captured through. A point range is one value. */
export type SourceBounds = {
  /** Envelope prefix, for example `supply`. */
  port: string;
  resistance: [number, number];
  currentLimit: [number, number];
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
  const supplyPort = snap.params.supplyPort;
  const supplyRef = snap.params.supplyRef;
  const supplyAffine = snap.params.supplyAffine;
  const mentioned =
    supplyPort !== undefined ||
    supplyRef !== undefined ||
    supplyAffine !== undefined;
  if (!mentioned) {
    return { across, iSense, iAxis, vAxis };
  }
  if (
    typeof supplyPort !== "string" ||
    supplyPort.length === 0 ||
    typeof supplyRef !== "number" ||
    typeof supplyAffine !== "number"
  ) {
    return null;
  }
  return {
    across,
    iSense,
    iAxis,
    vAxis,
    supplyPort,
    supplyRef,
    supplyAffine,
  };
}

/** Feed replacement when the envelope names a source resistance and limit. */
export function tableUseOf(snap: SnapshotFile): TableUse | null {
  if (!tableLawOf(snap)) return null;
  return sourceBoundsOf(snap) ? "feed" : "branch";
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
  if (!law.supplyPort) return { bounds, current, supply: null };
  const supply = bounds[`${law.supplyPort}.voltage`];
  if (!supply) return null;
  return { bounds, current, supply };
}

/** Series resistance and current limit of the port the capture swept. */
export function sourceBoundsOf(snap: SnapshotFile): SourceBounds | null {
  const bounds = snap.envelope?.bounds;
  if (!bounds) return null;
  let port: string | null = null;
  let resistance: [number, number] | null = null;
  let currentLimit: [number, number] | null = null;
  for (const [key, value] of Object.entries(bounds)) {
    const parsed = pair(value);
    if (!parsed) continue;
    const resistanceName = suffix(key, ".resistance");
    const limitName = suffix(key, ".currentLimit");
    if (resistanceName !== null) {
      if (port !== null && port !== resistanceName) return null;
      port = resistanceName;
      resistance = parsed;
    } else if (limitName !== null) {
      if (port !== null && port !== limitName) return null;
      port = limitName;
      currentLimit = parsed;
    }
  }
  if (!port || !resistance || !currentLimit) return null;
  return { port, resistance, currentLimit };
}

/** True when this port is not the one the snapshot was captured through. */
export function sourceOutside(
  bounds: SourceBounds,
  resistance: number,
  currentLimit: number
): boolean {
  return (
    outsideRange(bounds.resistance, resistance) ||
    outsideRange(bounds.currentLimit, currentLimit)
  );
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

function suffix(key: string, tail: string): string | null {
  return key.endsWith(tail) ? key.slice(0, -tail.length) : null;
}

/** Voltage axis at `supply`, after the affine shift. No term copies `vAxis`. */
export function shiftedVoltage(law: TableLaw, supply: number): number[] {
  if (law.supplyRef === undefined || law.supplyAffine === undefined) {
    return [...law.vAxis];
  }
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

function outsideRange(range: [number, number], value: number): boolean {
  return value < range[0] - EDGE || value > range[1] + EDGE;
}

/** True when the point sits outside the envelope, past a 1 nA / 1 nV edge. */
export function outsideEnvelope(
  env: SnapshotEnvelope,
  supply: number,
  amps: number
): boolean {
  if (
    env.supply &&
    (supply < env.supply[0] - EDGE || supply > env.supply[1] + EDGE)
  ) {
    return true;
  }
  if (amps < env.current[0] - EDGE || amps > env.current[1] + EDGE) {
    return true;
  }
  return false;
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
