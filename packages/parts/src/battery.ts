/** `battery@1` param parsing. The element lives in the circuit engine. */
import type { BatteryParams, FormParam, OcvKnot } from "@sfab-bench/contract";
import { batteryError, ocvAt } from "@sfab-bench/contract";

import { isScalarParam } from "./si";

export type { BatteryParams };
export { ocvAt };

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
