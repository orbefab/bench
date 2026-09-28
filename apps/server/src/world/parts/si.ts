/** Ported from layered-sim E7 (318b899). */

import { createHash } from "node:crypto";

import {
  type AxisLevel,
  type AxisName,
  DIM_KEYS,
  type Diagnostic,
  type Dim,
  type FormParam,
  type LevelClass,
  type LevelSpec,
  QUANTITY_DIM,
  type Quantity,
  type Range,
  SI_UNIT,
  type SiNumber,
  type SiTagged,
} from "@sfab-bench/contract";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = sortValue(src[key]);
    return out;
  }
  return value;
}

export function makeDiag(
  d: Omit<Diagnostic, "message"> & { detail: string }
): Diagnostic {
  const message = `${d.path} port ${d.port} quantity ${d.quantity}: ${d.detail} (${d.left} vs ${d.right})`;
  return { ...d, message };
}

export function isLevelClass(n: unknown): n is LevelClass {
  return n === 0 || n === 1 || n === 2 || n === 3;
}

export function isTagged(n: SiNumber): n is SiTagged {
  return typeof n === "object" && n !== null && "v" in n;
}

export function siValue(n: SiNumber): number {
  return isTagged(n) ? n.v : n;
}

/** A form param that is one number. An open-circuit table is not. */
export function isScalarParam(value: FormParam): value is SiNumber {
  return !Array.isArray(value);
}

export function dimEqual(a: Dim, b: Dim): boolean {
  return DIM_KEYS.every((k) => (a[k] ?? 0) === (b[k] ?? 0));
}

export function formatDim(d: Dim): string {
  const parts = DIM_KEYS.filter((k) => (d[k] ?? 0) !== 0).map(
    (k) => `${k}^${d[k]}`
  );
  return parts.length ? parts.join("·") : "1";
}

export function formatSi(n: number, q: Quantity): string {
  return `${n} ${SI_UNIT[q]}`;
}

const PART_REF = /^([a-z0-9-]+)\/([a-z0-9-]+)@(\d+\.\d+\.\d+)$/;

export function parsePartRef(
  id: string
): { publisher: string; name: string; version: string } | null {
  const m = PART_REF.exec(id);
  if (!m?.[1] || !m[2] || !m[3]) return null;
  return { publisher: m[1], name: m[2], version: m[3] };
}

export function splitPortRef(
  ref: string
): { inst: string; port: string } | null {
  const i = ref.lastIndexOf(".");
  if (i <= 0 || i === ref.length - 1) return null;
  return { inst: ref.slice(0, i), port: ref.slice(i + 1) };
}

/** The class a rule asks for, and the variant when the rule names one. */
export type AxisRequest = {
  class: LevelClass;
  variant?: string;
};

export function specAxes(
  spec: LevelSpec
): Partial<Record<AxisName, AxisRequest>> {
  if (typeof spec === "number") {
    const request = classRequest(spec);
    return {
      behaviour: request,
      body: { ...request },
      visual: { ...request },
    };
  }
  const out: Partial<Record<AxisName, AxisRequest>> = {};
  for (const axis of ["behaviour", "body", "visual"] as const) {
    const value = spec[axis];
    if (value === undefined) continue;
    out[axis] = axisRequest(value);
  }
  return out;
}

function classRequest(value: unknown): AxisRequest {
  if (!isLevelClass(value)) {
    throw new Error(`level class ${String(value)} is not 0..3`);
  }
  return { class: value };
}

function axisRequest(value: AxisLevel): AxisRequest {
  if (typeof value === "number") return classRequest(value);
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.variant !== "string" ||
    value.variant === ""
  ) {
    throw new Error("a variant rule needs a class and a variant name");
  }
  return { ...classRequest(value.class), variant: value.variant };
}

export function classesOf(
  map: Partial<Record<string, unknown>> | undefined
): LevelClass[] {
  if (!map) return [];
  const out: LevelClass[] = [];
  for (const k of ["0", "1", "2", "3"] as const) {
    if (map[k]) out.push(Number(k) as LevelClass);
  }
  return out;
}

export function numericRange(
  range: Range | undefined
): [number, number] | null {
  if (!range) return null;
  return [siValue(range[0]), siValue(range[1])];
}

export function formatRange(range: [number, number], q: Quantity): string {
  return `[${range[0]}, ${range[1]}] ${SI_UNIT[q]}`;
}

export function expectedDim(q: Quantity): string {
  return formatDim(QUANTITY_DIM[q]);
}
