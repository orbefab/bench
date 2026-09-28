/** `ldo-regulator@1` param parsing. The element lives in the circuit engine. */
import type { DropoutKnot, FormParam, LdoParams } from "@sfab-bench/contract";

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

function ldoError(params: LdoParams): string | null {
  if (!Number.isFinite(params.vOut))
    return "ldo-regulator@1 vOut must be finite";
  if (!(params.iLimit > 0) || !Number.isFinite(params.iLimit)) {
    return "ldo-regulator@1 iLimit must be positive";
  }
  if (!(params.iGround >= 0) || !Number.isFinite(params.iGround)) {
    return "ldo-regulator@1 iGround must be >= 0";
  }
  if (!(params.rOut >= 0) || !Number.isFinite(params.rOut)) {
    return "ldo-regulator@1 rOut must be >= 0";
  }
  const knots = params.dropout;
  const first = knots[0];
  if (!first) return "ldo-regulator@1 dropout needs a knot";
  if (
    !Number.isFinite(first[0]) ||
    !Number.isFinite(first[1]) ||
    first[1] < 0
  ) {
    return "ldo-regulator@1 dropout knots must be finite, volts >= 0";
  }
  for (let i = 1; i < knots.length; i++) {
    const prev = knots[i - 1];
    const knot = knots[i];
    if (!prev || !knot) return "ldo-regulator@1 dropout needs a knot";
    if (!(knot[0] > prev[0])) {
      return "ldo-regulator@1 dropout current must increase";
    }
    if (!(knot[1] >= prev[1])) {
      return "ldo-regulator@1 dropout voltage must not fall as current rises";
    }
    if (!Number.isFinite(knot[1]) || knot[1] < 0) {
      return "ldo-regulator@1 dropout knots must be finite, volts >= 0";
    }
  }
  return null;
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
