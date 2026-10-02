import type { FormParam, SiNumber } from "@sfab-bench/contract";

import { isScalarParam } from "./si";

/**
 * A form's scalar params as the run reads them: the variant's, then the
 * instance's numeric overrides on top. A table param is never overridden
 * and never listed here.
 *
 * With `known` (a form's declared params), both layers are narrowed to
 * those keys, and the instance may set a known key the variant leaves out.
 * Without it the variant lists every scalar it has and the instance may
 * only override one of them.
 */
export function mergeFormParams(
  variant: Record<string, FormParam>,
  instance: Record<string, number | string | boolean>,
  known?: Partial<Record<string, unknown>>
): Record<string, SiNumber> {
  const out: Record<string, SiNumber> = {};
  for (const [key, value] of Object.entries(variant)) {
    if (known && !Object.hasOwn(known, key)) continue;
    if (isScalarParam(value)) out[key] = value;
  }
  for (const [key, value] of Object.entries(instance)) {
    if (typeof value !== "number") continue;
    if (known ? Object.hasOwn(known, key) : Object.hasOwn(out, key)) {
      out[key] = value;
    }
  }
  return out;
}
