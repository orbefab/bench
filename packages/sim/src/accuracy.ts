/**
 * A document's assembly check, read for a live run (run 7 unit 3c).
 *
 * A stored verdict belongs to the comparison it came from: this parent,
 * these replacements, this observation. It applies to a run only when the
 * run is the one the record's snapshot side measured: the same document
 * apart from its id and its play levels, the same locked parts and types
 * apart from the root, the same realized levels, nets and snapshots, and
 * the same bytes in every file the run reads (`runContext`). Any other
 * run, including the document at other levels or with its firmware
 * rebuilt, shows the record as not applying, with no verdict, and never
 * moves a verdict onto the nearest part.
 *
 * An `over` verdict is an `over-budget` warning at the quantity's path and
 * port, so it shows three ways. It says out of domain when the record's
 * run was, or when a snapshot this run loads is stale or unchecked.
 */

import {
  type AccuracyRow,
  ASSEMBLY_CHECK_FORMAT,
  type AssemblyCheckFile,
  type AssemblyValidity,
  type Quantity,
  type RunReport,
  resolvedAmount,
  SI_UNIT,
} from "@sfab-bench/contract";
import { contentHash, makeDiag, siValue } from "@sfab-bench/parts";

/** A file the run reads: its project-relative path and content hash. */
export type RunInput = { file: string; sha256: string };

/**
 * What makes `report`'s run the run a record measured, as a hash: the
 * document without its id and play levels, the lock without the root's
 * own entry, every path's realized level, net level and snapshot, and the
 * files the run reads (`inputs`: firmware images, URDFs and their meshes,
 * level overlays).
 */
export function runContext(
  document: unknown,
  report: RunReport,
  inputs: readonly RunInput[]
): string {
  const doc = structuredClone(document) as {
    id?: string;
    play?: { levels?: unknown };
  };
  const id = doc.id;
  delete doc.id;
  if (doc.play) delete doc.play.levels;
  const byKey = <T>(rows: T[], key: (row: T) => string) =>
    rows.slice().sort((a, b) => key(a).localeCompare(key(b)));
  return contentHash({
    document: doc,
    lock: {
      parts: byKey(
        report.lock.parts
          .filter((row) => row.id !== id)
          .map(({ id, sha256 }) => ({ id, sha256 })),
        (row) => row.id
      ),
      types: byKey(
        report.lock.types.map(({ id, sha256 }) => ({ id, sha256 })),
        (row) => row.id
      ),
      snapshots: byKey(
        (report.lock.snapshots ?? []).map(({ id, sha256 }) => ({
          id,
          sha256,
        })),
        (row) => row.id
      ),
    },
    levels: byKey(
      report.levels.map(({ path, axis, class: level, variant, impl }) => ({
        path,
        axis,
        class: level,
        variant,
        impl,
      })),
      (row) => `${row.path} ${row.axis}`
    ),
    nets: byKey(
      report.nets.map(({ id, domain, level }) => ({ id, domain, level })),
      (row) => row.id
    ),
    snapshots: byKey(
      report.snapshots.map(({ path, axis, ref }) => ({ path, axis, ref })),
      (row) => `${row.path} ${row.axis}`
    ),
    inputs: byKey([...inputs], (row) => row.file),
  });
}

/** The record file for a document's part id: `checks/<publisher>/<name>@<version>.json`. */
export function recordPathFor(partId: string): string | null {
  const at = partId.match(/^([^/]+)\/([^@/]+)@([^/]+)$/);
  if (!at) return null;
  return `checks/${at[1]}/${at[2]}@${at[3]}.json`;
}

/**
 * Add `record`'s accuracy to `report`, and an `over-budget` warning for
 * each criterion over its resolution, when the record is this run's
 * (`context` is `runContext` of this run). A record of another format or
 * document, or one missing what the card reads, is not this document's
 * check.
 */
export function noteAccuracy(
  report: RunReport,
  context: string,
  worldRel: string,
  recordRel: string,
  record: unknown
): void {
  if (!isCheck(record) || record.document !== worldRel) return;
  const applies = record.context === context;
  const accuracy = {
    record: recordRel,
    applies,
    inDomain: record.inDomain,
    domain: record.inDomain ? [] : domainLines(record),
    snapshots: record.children.map((row) => `${row.path} ${row.ref}`),
    rows: applies ? record.rows.map(accuracyRow) : [],
  };
  report.accuracy = accuracy;
  const qualifier = [
    ...accuracy.domain,
    ...report.snapshots
      .filter((row) => row.stale || row.unchecked)
      .map(
        (row) =>
          `${row.path} ${row.ref} is ${row.stale ? "stale" : "unchecked"}`
      ),
  ];
  for (const row of accuracy.rows) {
    for (const criterion of row.criteria) {
      if (criterion.verdict !== "over") continue;
      const shown = (n: number) =>
        resolvedAmount(n, criterion.ratioTo ? null : row.field);
      report.warnings.push(
        makeDiag({
          severity: "warning",
          code: "over-budget",
          path: row.path,
          port: row.port,
          quantity: row.field,
          left: `${criterion.metric} ${shown(criterion.value ?? Number.NaN)}`,
          right: `${criterion.kind} ${shown(criterion.threshold)} from ${criterion.from}`,
          detail: `over its resolution by ${shown(criterion.by)}, with ${accuracy.snapshots.join(", ")} as snapshots (${recordRel})${qualifier.length ? `; out of domain: ${qualifier.join("; ")}` : ""}`,
        })
      );
    }
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isList = (value: unknown, row: (item: unknown) => boolean) =>
  Array.isArray(value) && value.every(row);

/** An object whose `keys` are all strings. */
const strings =
  (...keys: string[]) =>
  (item: unknown) =>
    isObject(item) && keys.every((key) => typeof item[key] === "string");

/** A verdict the check stated: within, over by a number, or none with why. */
const stated = (item: Record<string, unknown>) =>
  item.verdict === "within" ||
  (item.verdict === "over" && typeof item.by === "number") ||
  (item.verdict === "none" && typeof item.reason === "string");

/** An `@2` record with everything the card and the warning read. */
function isCheck(record: unknown): record is AssemblyCheckFile {
  if (!isObject(record) || record.format !== ASSEMBLY_CHECK_FORMAT) {
    return false;
  }
  const domain = record.domain;
  const validity = (side: unknown) =>
    isObject(side) &&
    isList(
      side.envelope,
      strings("path", "ref", "port", "quantity", "range")
    ) &&
    isList(side.stale, strings("path", "ref")) &&
    isList(side.unchecked, strings("path", "ref", "reason")) &&
    isList(side.degraded, strings("path", "code", "port"));
  const criterion = (item: unknown) =>
    isObject(item) &&
    typeof item.threshold === "number" &&
    isObject(item.reference) &&
    isList(item.conditions, isObject) &&
    isList(item.metrics, isObject) &&
    isObject(item.coverage) &&
    isObject(item.coverage.excluded) &&
    stated(item);
  const row = (item: unknown) =>
    isObject(item) &&
    typeof item.quantity === "string" &&
    item.quantity.split(".").length >= 3 &&
    isList(item.metrics, isObject) &&
    isList(item.criteria, criterion);
  return (
    typeof record.document === "string" &&
    typeof record.context === "string" &&
    typeof record.inDomain === "boolean" &&
    isObject(domain) &&
    validity(domain.detailed) &&
    validity(domain.snapshot) &&
    isList(record.children, strings("path", "ref")) &&
    isList(record.rows, row)
  );
}

/** Why the record's own run was out of domain, from its `domain`. */
function domainLines(record: AssemblyCheckFile): string[] {
  const lines = (side: string, validity: AssemblyValidity) => [
    ...validity.envelope.map((row) => {
      const unit = SI_UNIT[row.quantity as Quantity];
      return `the check's ${side} side took ${row.path} ${row.port} ${row.quantity.toLowerCase()} outside ${row.range}${unit ? ` ${unit}` : ""}`;
    }),
    ...validity.stale.map(
      (row) => `${row.path} ${row.ref} was stale on the check's ${side} side`
    ),
    ...validity.unchecked.map(
      (row) =>
        `${row.path} ${row.ref} was unchecked on the check's ${side} side (${row.reason})`
    ),
    ...validity.degraded.map(
      (row) =>
        `${row.path}${row.port ? ` port ${row.port}` : ""} ran degraded (${row.code}) on the check's ${side} side`
    ),
  ];
  const all = [
    ...lines("detailed", record.domain.detailed),
    ...lines("snapshot", record.domain.snapshot),
  ];
  return all.length > 0 ? [...new Set(all)] : ["the check ran out of domain"];
}

function accuracyRow(row: AssemblyCheckFile["rows"][number]): AccuracyRow {
  const at = row.quantity.lastIndexOf(".");
  const port = row.quantity.lastIndexOf(".", at - 1);
  const metric = (name: string) =>
    row.metrics.find((item) => item.metric === name)?.value ?? Number.NaN;
  return {
    quantity: row.quantity,
    path: row.quantity.slice(0, port),
    port: row.quantity.slice(port + 1, at),
    field: row.quantity.slice(at + 1),
    gap: { max: metric("step-max"), rms: metric("step-rms") },
    criteria: row.criteria.map((criterion) => {
      const steady = criterion.conditions.find(
        (condition) => condition.kind === "steady@1"
      );
      const judged = criterion.metrics[0];
      const verdict =
        criterion.verdict === "over"
          ? { verdict: "over" as const, by: criterion.by }
          : criterion.verdict === "none"
            ? { verdict: "none" as const, reason: criterion.reason }
            : { verdict: "within" as const };
      return {
        kind: criterion.kind,
        from: criterion.from,
        threshold: criterion.threshold,
        ...(criterion.reference.kind === "ratio-to"
          ? { ratioTo: criterion.reference.quantity }
          : {}),
        ...(steady?.kind === "steady@1"
          ? { window: siValue(steady.window) }
          : {}),
        metric:
          judged?.metric ??
          (criterion.kind === "precision" ? "settled-max" : "event-max"),
        ...(judged ? { value: judged.value } : {}),
        coverage: criterion.coverage,
        ...verdict,
      };
    }),
  };
}
