/** A form's `bind`: the form's port → the part's port. */
import { FORM_PARAMS, type FormId, type PortDecl } from "@sfab-bench/contract";

/**
 * Why a bind cannot run, one sentence per entry: a key the form does not
 * stamp, a value the part does not declare, or a part port bound twice. A
 * form with no port list stamps the part's own ports and reads no bind.
 */
export function bindProblems(
  form: string,
  bind: Record<string, string>,
  ports: Record<string, PortDecl>,
  partType: string
): { key: string; value: string; reason: string }[] {
  const stamped = FORM_PARAMS[form as FormId]?.ports;
  if (!stamped) {
    return Object.entries(bind).map(([key, value]) => ({
      key,
      value,
      reason: `bind ${key} → ${value}: ${form} stamps the part's own ports and reads no bind`,
    }));
  }
  const out: { key: string; value: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(bind)) {
    const reason = !stamped.includes(key)
      ? `bind ${key} → ${value}: ${form} stamps no port ${key} (it stamps ${stamped.join(", ")})`
      : !ports[value]
        ? `bind ${key} → ${value}: ${value} is not on ${partType}`
        : seen.has(value)
          ? `bind ${key} → ${value}: ${value} is bound twice`
          : null;
    seen.add(value);
    if (reason) out.push({ key, value, reason });
  }
  return out;
}
