/** Ported from layered-sim E7 (318b899). */

import { createHash } from "node:crypto";

import {
  type AxisName,
  DIM_KEYS,
  type Diagnostic,
  type Dim,
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

export function specAxes(
  spec: LevelSpec
): Partial<Record<AxisName, LevelClass>> {
  if (typeof spec === "number") {
    if (!isLevelClass(spec)) {
      throw new Error(`level class ${String(spec)} is not 0..3`);
    }
    return { behaviour: spec, body: spec, visual: spec };
  }
  const out: Partial<Record<AxisName, LevelClass>> = {};
  for (const axis of ["behaviour", "body", "visual"] as const) {
    const v = spec[axis];
    if (v === undefined) continue;
    if (!isLevelClass(v)) {
      throw new Error(`level class ${String(v)} is not 0..3`);
    }
    out[axis] = v;
  }
  return out;
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
