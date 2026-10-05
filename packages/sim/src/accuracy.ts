/**
 * A document's assembly check, read for a live run (run 7 unit 3c).
 *
 * A stored verdict belongs to the comparison it came from: this parent,
 * these replacements, this observation. It applies to a run only when the
 * run is the one the record's snapshot side measured: the same document
 * apart from its id and its play levels, the same locked parts and types
 * apart from the root, and the same realized levels and snapshots
 * (`runContext`). Any other run, including the document at other levels,
 * shows the record as not applying, with no verdict, and never moves a
 * verdict onto the nearest part.
 *
 * An `over` verdict is an `over-budget` warning at the quantity's path and
 * port, so it shows three ways. It says out of domain when the record's
 * run was, or when a snapshot this run loads is stale or unchecked.
 */

import {
  type AccuracyRow,
  ASSEMBLY_CHECK_FORMAT,
  type AssemblyCheckFile,
  RESOLVED_FIELD_QUANTITY,
  type ResolvedField,
  type RunReport,
  SI_UNIT,
} from "@sfab-bench/contract";
import { contentHash, makeDiag, siValue } from "@sfab-bench/parts";

/**
 * What makes `report`'s run the run a record measured, as a hash: the
 * document without its id and play levels, the lock without the root's
 * own entry, and every path's realized level and snapshot.
 */
export function runContext(document: unknown, report: RunReport): string {
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
    snapshots: byKey(
      report.snapshots.map(({ path, axis, ref }) => ({ path, axis, ref })),
      (row) => `${row.path} ${row.axis}`
    ),
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
 * each criterion over its resolution, when the record is this run's. A
 * record of another format or document is not this document's check.
 */
export function noteAccuracy(
  report: RunReport,
  document: unknown,
  worldRel: string,
  recordRel: string,
  record: unknown
): void {
  const file = record as Partial<AssemblyCheckFile> | null;
  if (file?.format !== ASSEMBLY_CHECK_FORMAT || file.document !== worldRel) {
    return;
  }
  const check = file as AssemblyCheckFile;
  const applies = check.context === runContext(document, report);
  const accuracy = {
    record: recordRel,
    applies,
    inDomain: check.inDomain,
    snapshots: check.children.map((row) => `${row.path} ${row.ref}`),
    rows: applies ? check.rows.map(accuracyRow) : [],
  };
  report.accuracy = accuracy;
  const qualifier = [
    ...(check.inDomain ? [] : ["the check ran outside a snapshot's envelope"]),
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
        amount(n, criterion.ratioTo ? null : row.field);
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

/** `n` to 3 significant digits, in the field's SI unit when it has one. */
export function amount(n: number, field: string | null): string {
  const digits = String(Number(n.toPrecision(3)));
  const quantity =
    field && field in RESOLVED_FIELD_QUANTITY
      ? RESOLVED_FIELD_QUANTITY[field as ResolvedField]
      : null;
  return quantity ? `${digits} ${SI_UNIT[quantity]}` : digits;
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
