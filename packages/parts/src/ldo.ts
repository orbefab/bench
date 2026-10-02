/** `ldo-regulator@1` param parsing. The element lives in the circuit engine. */
import {
  type DropoutKnot,
  type FormParam,
  type LdoParams,
  ldoError,
} from "@sfab-bench/contract";

import { isScalarParam } from "./si";

export type { DropoutKnot, LdoParams };

function scalar(
  override: number | string | boolean | undefined,
  value: FormParam | undefined
): number | undefined {
  if (override !== undefined) {
    return typeof override === "number" && Number.isFinite(override)
      ? override
      : undefined;
  }
  if (value === undefined || !isScalarParam(value)) return undefined;
  const n = typeof value === "number" ? value : value.v;
  return Number.isFinite(n) ? n : undefined;
}

function readDropout(
  value: FormParam | undefined
): readonly DropoutKnot[] | null {
  if (!Array.isArray(value) || value.length < 1) return null;
  const knots: DropoutKnot[] = [];
  for (const row of value) {
    if (!Array.isArray(row) || row.length !== 2) return null;
    const amps = row[0];
    const volts = row[1];
    if (typeof amps !== "number" || typeof volts !== "number") return null;
    knots.push([amps, volts]);
  }
  return knots;
}

/** Catalog params plus instance number overrides. `dropout` is not overridden. */
export function ldoFrom(
  params: Record<string, FormParam>,
  overrides: Record<string, number | string | boolean>
): { ok: true; params: LdoParams } | { ok: false; error: string } {
  const dropout = readDropout(params.dropout);
  if (!dropout) {
    return {
      ok: false,
      error: "ldo-regulator@1 dropout must be [amps, volts] knots",
    };
  }
  const vOut = scalar(overrides.vOut, params.vOut);
  const iGround = scalar(overrides.iGround, params.iGround);
  const iLimit = scalar(overrides.iLimit, params.iLimit);
  if (vOut === undefined || iGround === undefined || iLimit === undefined) {
    return {
      ok: false,
      error: "ldo-regulator@1 needs vOut, iGround, and iLimit",
    };
  }
  const hasR = overrides.rOut !== undefined || params.rOut !== undefined;
  const rOut = hasR ? scalar(overrides.rOut, params.rOut) : 0;
  if (rOut === undefined) {
    return { ok: false, error: "ldo-regulator@1 rOut must be a resistance" };
  }
  const built: LdoParams = { vOut, dropout, iGround, iLimit, rOut };
  const error = ldoError(built);
  if (error) return { ok: false, error };
  return { ok: true, params: built };
}
