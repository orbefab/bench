/**
 * The snapshots resolved instances run, one way for every caller: a world
 * load and a board or assembly stamp. Each snapshot is read, shaped,
 * checked against the type and axis that run it, and linted. A
 * behaviour snapshot in any form but `table@1` becomes that form, with
 * the file's params and `bind`. A snapshot that cannot run is diagnostics
 * on the instance that asked for it, and that instance only.
 */

import type {
  BehaviourImpl,
  BodyImpl,
  Diagnostic,
  RunReport,
  SiNumber,
  SnapshotFile,
} from "@sfab-bench/contract";
import type { LiveInstance } from "./levels";
import { type Library, type LibraryOptions, typeOf } from "./library";
import { makeDiag } from "./si";
import { type LoadedSnapshot, loadSnapshot } from "./snapshot-load";

export type SnapshotRun = {
  path: string;
  axis: "behaviour" | "body";
  ref: string;
};

/** A run report row for a snapshot an instance runs. */
export type SnapshotRan = SnapshotRun & {
  quality: string;
  error: SnapshotFile["error"];
  provenance: RunReport["snapshots"][number]["provenance"];
  bounds: SnapshotFile["envelope"]["bounds"];
};

export type SnapshotResolution = {
  /** Each snapshot file run, once. */
  snapshots: LoadedSnapshot[];
  runs: SnapshotRun[];
  ran: SnapshotRan[];
  diagnostics: Diagnostic[];
};

/**
 * Loads the snapshots `instances` select and rewrites each non-table
 * behaviour snapshot's impl to its form in place.
 */
export function resolveSnapshots(
  lib: Library,
  opts: LibraryOptions,
  instances: LiveInstance[]
): SnapshotResolution {
  const out: SnapshotResolution = {
    snapshots: [],
    runs: [],
    ran: [],
    diagnostics: [],
  };
  for (const inst of instances) {
    for (const ask of snapshotAsks(inst)) {
      let type = null;
      try {
        type = typeOf(lib, inst.part);
      } catch {
        type = null;
      }
      const found = loadSnapshot(lib.worldDir, opts, ask.ref, type, {
        axis: ask.axis,
      });
      // The file's rows name the snapshot; the instance is what idles.
      out.diagnostics.push(
        ...found.diagnostics.map((diag) => ({ ...diag, path: inst.path }))
      );
      if (!found.loaded) continue;
      const file = found.loaded.file;
      if (ask.axis === "body" && file.form !== "hinge@1") {
        out.diagnostics.push(
          makeDiag({
            severity: "error",
            code: "snapshot",
            path: inst.path,
            port: "body",
            quantity: "Form",
            left: file.form,
            right: "hinge@1",
            detail: `snapshot ${ask.ref} is not a body hinge`,
          })
        );
        continue;
      }
      if (ask.axis === "behaviour" && file.form !== "table@1") {
        // Any other form runs as that form, with the file's params: the
        // run dispatches on the form, not on where its numbers came from.
        const selected = inst.axes.behaviour;
        inst.axes.behaviour = {
          ...selected,
          impl: formOfSnapshot(file, selected.impl as BehaviourImpl),
        };
      }
      if (!out.snapshots.some((row) => row.id === found.loaded?.id)) {
        out.snapshots.push(found.loaded);
      }
      out.runs.push({ path: inst.path, axis: ask.axis, ref: ask.ref });
      out.ran.push({
        path: inst.path,
        axis: ask.axis,
        ref: ask.ref,
        quality: inst.foreign ? "Q1" : found.loaded.quality,
        error: file.error,
        provenance: provenanceOf(file),
        bounds: file.envelope.bounds,
      });
    }
  }
  return out;
}

function provenanceOf(
  file: SnapshotFile
): RunReport["snapshots"][number]["provenance"] {
  const source = file.provenance;
  return {
    source: source.source,
    ...(source.from
      ? {
          from: {
            part: source.from.part,
            level: source.from.level,
            hash: source.from.hash,
          },
        }
      : {}),
    ...(source.fixture ? { fixture: source.fixture.ref } : {}),
    ...(source.tool
      ? { tool: { name: source.tool.name, version: source.tool.version } }
      : {}),
  };
}

/** A non-table behaviour snapshot as the form variant it stands for. */
function formOfSnapshot(
  file: SnapshotFile,
  variant: BehaviourImpl
): BehaviourImpl {
  // A number or a tagged SI number, as the linter accepts; the form reads
  // either. Strings and arrays are table data, not form params.
  const params: Record<string, SiNumber> = {};
  for (const [key, value] of Object.entries(file.params)) {
    const tagged = value as unknown as { v?: unknown } | null;
    if (
      typeof value === "number" ||
      (tagged && typeof tagged === "object" && typeof tagged.v === "number")
    ) {
      params[key] = value as unknown as SiNumber;
    }
  }
  return {
    kind: "form",
    form: file.form,
    params,
    ...(file.bind ? { bind: { ...file.bind } } : {}),
    omits: variant.omits,
  };
}

/** Snapshots this instance's selected behaviour and body run. */
function snapshotAsks(inst: LiveInstance): Omit<SnapshotRun, "path">[] {
  const asks: Omit<SnapshotRun, "path">[] = [];
  const impl = inst.axes.behaviour.impl as BehaviourImpl | null;
  if (impl?.kind === "snapshot") {
    asks.push({ ref: impl.ref, axis: "behaviour" });
  }
  const body = inst.axes.body.impl as BodyImpl | null;
  if (body?.kind === "snapshot") {
    asks.push({ ref: body.ref, axis: "body" });
  }
  return asks;
}
