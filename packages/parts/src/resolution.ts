/**
 * Resolutions: cited port data saying the smallest difference a part can
 * tell apart in one field at one port (run 7 unit 3b, `docs/formats.md`).
 * A type states them on its ports and templates; a part states its own by
 * port, and one for a field and kind the type also states replaces the
 * type's.
 *
 * Library lint accepts exactly the run 7 vocabulary and nothing else:
 * - `kind` is `precision` or `reader`;
 * - `field` is one the port's domain carries (`voltage` and `current` on
 *   an electrical port, `angle` on a rotational one);
 * - `value` is finite and positive, in the field's unit for an `absolute`
 *   reference and dimensionless for `ratio-to`;
 * - a `ratio-to` reference names `PORT.field` on the same part, in the
 *   same quantity, so the ratio's units cancel;
 * - a `reader` reads a `voltage`: it is judged at its conversions;
 * - conditions are `within-ratings` and `steady@1` (a positive `window`
 *   in seconds, stated once); a `precision` carries `steady@1`, a
 *   `reader` never does;
 * - a source with a title and a reference.
 */

import {
  type Citation,
  type Diagnostic,
  DOMAIN_QUANTITIES,
  type PartFile,
  type PartTypeFile,
  QUANTITY_DIM,
  type Quantity,
  RESOLVED_FIELD_QUANTITY,
  type Resolution,
  type ResolvedField,
  SI_UNIT,
  type SiTagged,
} from "@sfab-bench/contract";

import { dimEqual, isTagged, makeDiag, siValue } from "./si";

const KEYS = new Set([
  "field",
  "kind",
  "value",
  "reference",
  "conditions",
  "source",
]);

/** The port's resolutions: the type's, with the part's replacing by field and kind. */
export function portResolutions(
  type: PartTypeFile,
  part: PartFile,
  port: string
): Resolution[] {
  const own = part.resolution?.[port] ?? [];
  const key = (row: Resolution) => `${row.field} ${row.kind}`;
  const replaced = new Set(own.map(key));
  return [
    ...(type.ports[port]?.resolution ?? []).filter(
      (row) => !replaced.has(key(row))
    ),
    ...own,
  ];
}

/** `quantity` as `PORT.field`, split at its last dot. */
export function splitPortField(
  quantity: string
): { port: string; field: ResolvedField } | null {
  const at = quantity.lastIndexOf(".");
  if (at <= 0) return null;
  const field = quantity.slice(at + 1);
  if (!(field in RESOLVED_FIELD_QUANTITY)) return null;
  return { port: quantity.slice(0, at), field: field as ResolvedField };
}

export function lintResolutions(
  part: PartFile,
  type: PartTypeFile,
  diags: Diagnostic[]
): void {
  for (const port of Object.keys(part.resolution ?? {})) {
    if (type.ports[port]) continue;
    diags.push(
      makeDiag({
        severity: "error",
        code: "schema",
        path: part.id,
        port,
        quantity: "Port",
        left: port,
        right: Object.keys(type.ports).join(","),
        detail: "resolution names a port the type does not have",
      })
    );
  }
  for (const port of Object.keys(type.ports)) {
    const rows = portResolutions(type, part, port);
    const seen = new Set<string>();
    for (const row of rows) {
      const problem = resolutionProblem(type, port, row);
      const key = `${row.field} ${row.kind}`;
      const twice = seen.has(key) ? `two ${key} resolutions` : null;
      seen.add(key);
      const detail = problem ?? twice;
      if (detail === null) continue;
      diags.push(
        makeDiag({
          severity: "error",
          code: "schema",
          path: part.id,
          port,
          quantity: "Resolution",
          left: JSON.stringify(row),
          right: "run 7 resolution vocabulary",
          detail,
        })
      );
    }
  }
}

/** Why `row` is not a resolution run 7 can read, or null. */
function resolutionProblem(
  type: PartTypeFile,
  port: string,
  row: Resolution
): string | null {
  if (!row || typeof row !== "object") return "not an object";
  const extra = Object.keys(row).filter((key) => !KEYS.has(key));
  if (extra.length) return `unknown key ${extra.join(", ")}`;
  const decl = type.ports[port];
  const fields = fieldsOf(decl?.domain);
  if (!fields.includes(row.field)) {
    return `field ${String(row.field)} is not one a ${decl?.domain} port carries (${fields.join(", ")})`;
  }
  if (row.kind !== "precision" && row.kind !== "reader") {
    return `kind ${String(row.kind)} is not precision or reader`;
  }
  if (row.kind === "reader" && row.field !== "voltage") {
    return "a reader is judged at its conversions, which read a voltage";
  }
  const reference = row.reference as { kind?: unknown; quantity?: unknown };
  let unit: Quantity;
  if (reference?.kind === "absolute" && Object.keys(reference).length === 1) {
    unit = RESOLVED_FIELD_QUANTITY[row.field];
  } else if (reference?.kind === "ratio-to") {
    if (Object.keys(reference).length !== 2) {
      return "ratio-to takes a quantity and nothing else";
    }
    const target =
      typeof reference.quantity === "string"
        ? splitPortField(reference.quantity)
        : null;
    if (!target || !type.ports[target.port]) {
      return `ratio-to ${String(reference.quantity)} is not PORT.field on this part`;
    }
    if (
      RESOLVED_FIELD_QUANTITY[target.field] !==
      RESOLVED_FIELD_QUANTITY[row.field]
    ) {
      return `ratio-to ${reference.quantity} is not a ${RESOLVED_FIELD_QUANTITY[row.field]}, so the ratio is not dimensionless`;
    }
    if (target.port === port && target.field === row.field) {
      return "ratio-to names the field itself";
    }
    unit = "Dimensionless";
  } else {
    return `reference ${JSON.stringify(row.reference)} is not absolute or ratio-to`;
  }
  const valueProblem = siProblem(row.value, unit, "value");
  if (valueProblem) return valueProblem;
  const conditions = row.conditions ?? [];
  if (!Array.isArray(conditions)) return "conditions is not a list";
  let steady = false;
  for (const condition of conditions) {
    if (condition?.kind === "within-ratings") {
      if (Object.keys(condition).length !== 1) {
        return "within-ratings takes no settings";
      }
      continue;
    }
    if (condition?.kind === "steady@1") {
      if (steady) return "steady@1 is stated twice";
      if (Object.keys(condition).length !== 2) {
        return "steady@1 takes a window and nothing else";
      }
      const windowProblem = siProblem(condition.window, "Time", "window");
      if (windowProblem) return windowProblem;
      steady = true;
      continue;
    }
    return `condition ${JSON.stringify(condition)} is not within-ratings or steady@1`;
  }
  if (row.kind === "precision" && !steady) {
    return "a precision is judged on settled samples: it needs steady@1";
  }
  if (row.kind === "reader" && steady) {
    return "a reader is judged at its conversions, not on settled samples";
  }
  if (!citation(row.source)) return "no source with a title and a ref";
  return null;
}

function fieldsOf(domain: string | undefined): ResolvedField[] {
  const quantities: readonly Quantity[] = domain
    ? [
        ...(DOMAIN_QUANTITIES[domain as "electrical"]?.across ?? []),
        ...(DOMAIN_QUANTITIES[domain as "electrical"]?.through ?? []),
      ]
    : [];
  return (Object.keys(RESOLVED_FIELD_QUANTITY) as ResolvedField[]).filter(
    (field) => quantities.includes(RESOLVED_FIELD_QUANTITY[field])
  );
}

/** Why `value` is not one finite positive `quantity`, or null. */
function siProblem(
  value: unknown,
  quantity: Quantity,
  name: string
): string | null {
  if (typeof value !== "number" && !isTagged(value as never)) {
    return `${name} is not a number`;
  }
  if (isTagged(value as never)) {
    const tag = value as SiTagged;
    if (tag.q !== quantity || !dimEqual(tag.d ?? {}, QUANTITY_DIM[quantity])) {
      return `${name} is tagged ${String(tag.q)}, not ${quantity}`;
    }
    if (tag.unit !== undefined && tag.unit !== SI_UNIT[quantity]) {
      return `${name} unit ${tag.unit} is not ${SI_UNIT[quantity]}`;
    }
  }
  const n = siValue(value as number);
  if (!Number.isFinite(n) || n <= 0) {
    return `${name} ${n} is not finite and positive`;
  }
  return null;
}

function citation(source: Citation | undefined): boolean {
  return (
    typeof source?.title === "string" &&
    source.title.trim() !== "" &&
    typeof source.ref === "string" &&
    source.ref.trim() !== ""
  );
}
