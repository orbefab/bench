/** `comparator@1` param parsing. The element lives in the circuit engine. */
import type { FormParam } from "@sfab-bench/contract";

import { isScalarParam } from "./si";

/**
 * `vHyst` is optional and defaults to 0, the same number the stamp uses
 * when the param is absent. A present value must be finite and >= 0.
 */
export function comparatorFrom(
  params: Record<string, FormParam>,
  overrides: Record<string, number | string | boolean>
): { ok: true; vHyst: number } | { ok: false; error: string } {
  let vHyst: number | undefined;
  const catalog = params.vHyst;
  if (catalog !== undefined && isScalarParam(catalog)) {
    vHyst = typeof catalog === "number" ? catalog : catalog.v;
  }
  if (typeof overrides.vHyst === "number") vHyst = overrides.vHyst;
  if (vHyst === undefined) return { ok: true, vHyst: 0 };
  if (!Number.isFinite(vHyst) || vHyst < 0) {
    return { ok: false, error: "comparator@1 vHyst must be >= 0" };
  }
  return { ok: true, vHyst };
}
