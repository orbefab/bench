/** `battery@1` param parsing. The element lives in the circuit engine. */
import type { BatteryParams, FormParam, OcvKnot } from "@sfab-bench/contract";
import { ocvAt } from "@sfab-bench/contract";

import { isScalarParam } from "./si";

export type { BatteryParams };
export { ocvAt };

function batteryError(params: BatteryParams): string | null {
  const knots = params.ocv;
  const first = knots[0];
  const last = knots[knots.length - 1];
  if (!first || !last || knots.length < 2) {
    return "battery@1 ocv needs at least two knots";
  }
  if (first[0] !== 0 || last[0] !== 1) {
    return "battery@1 ocv must run from soc 0 to soc 1";
  }
  if (!Number.isFinite(first[1]) || first[1] < 0) {
    return "battery@1 ocv voltage must be finite and >= 0";
  }
  for (let i = 1; i < knots.length; i++) {
    const prev = knots[i - 1];
    const knot = knots[i];
    if (!prev || !knot) return "battery@1 ocv needs at least two knots";
    if (!(knot[0] > prev[0])) return "battery@1 ocv soc must increase";
    if (!(knot[1] >= prev[1])) {
      return "battery@1 ocv voltage must not fall as soc rises";
    }
    if (!Number.isFinite(knot[1]) || knot[1] < 0) {
      return "battery@1 ocv voltage must be finite and >= 0";
    }
  }
  if (!(params.rInternal >= 0) || !Number.isFinite(params.rInternal)) {
    return "battery@1 rInternal must be >= 0";
  }
  if (!(params.capacity > 0) || !Number.isFinite(params.capacity)) {
    return "battery@1 capacity must be positive";
  }
  if (
    !(params.soc0 >= 0) ||
    !(params.soc0 <= 1) ||
    !Number.isFinite(params.soc0)
  ) {
    return "battery@1 soc0 must be from 0 to 1";
  }
  if (params.vCutoff !== undefined && !Number.isFinite(params.vCutoff)) {
    return "battery@1 vCutoff must be finite";
  }
  return null;
}

function readOcv(value: FormParam | undefined): readonly OcvKnot[] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const knots: OcvKnot[] = [];
  for (const row of value) {
    if (!Array.isArray(row) || row.length !== 2) return null;
    const soc = row[0];
    const volts = row[1];
    if (typeof soc !== "number" || typeof volts !== "number") return null;
    knots.push([soc, volts]);
  }
  return knots;
}

function scalar(
  override: number | string | boolean | undefined,
  value: FormParam | undefined
): number | undefined {
  if (override !== undefined) {
    return typeof override === "number" && Number.isFinite(override)
      ? override
      : undefined;
  }
  if (!value || !isScalarParam(value)) return undefined;
  const n = typeof value === "number" ? value : value.v;
  return Number.isFinite(n) ? n : undefined;
}

/** Catalog params plus instance number overrides. `ocv` is not overridden. */
export function batteryFrom(
  params: Record<string, FormParam>,
  overrides: Record<string, number | string | boolean>
): { ok: true; params: BatteryParams } | { ok: false; error: string } {
  const ocv = readOcv(params.ocv);
  if (!ocv) {
    return { ok: false, error: "battery@1 ocv must be [soc, volts] knots" };
  }
  const rInternal = scalar(overrides.rInternal, params.rInternal);
  const capacity = scalar(overrides.capacity, params.capacity);
  const soc0 = scalar(overrides.soc0, params.soc0);
  if (rInternal === undefined || capacity === undefined || soc0 === undefined) {
    return {
      ok: false,
      error: "battery@1 needs rInternal, capacity, and soc0",
    };
  }
  const hasCutoff =
    overrides.vCutoff !== undefined || params.vCutoff !== undefined;
  const vCutoff = hasCutoff
    ? scalar(overrides.vCutoff, params.vCutoff)
    : undefined;
  if (hasCutoff && vCutoff === undefined) {
    return { ok: false, error: "battery@1 vCutoff must be a voltage" };
  }
  const built: BatteryParams = {
    ocv,
    rInternal,
    capacity,
    soc0,
    ...(vCutoff !== undefined ? { vCutoff } : {}),
  };
  const error = batteryError(built);
  if (error) return { ok: false, error };
  return { ok: true, params: built };
}
