/** Ported from layered-sim E7 (318b899). */

import {
  AXES,
  type AxisName,
  type Diagnostic,
  type LockFile,
  RUN_REPORT_FORMAT,
  type RunReport,
  type SnapshotFile,
} from "@sfab-bench/contract";

import type { LiveInstance } from "./levels";
import type { LiveNet } from "./nets";
import { canonicalJson } from "./si";

const NO_SNAPSHOT =
  "no snapshot used; selected levels are authored forms, firmware, or composites";

export function buildReport(input: {
  world: string;
  seed: number;
  lock: LockFile;
  instances: LiveInstance[];
  nets: LiveNet[];
  diags: Diagnostic[];
  /** Snapshots the resolved levels actually run. */
  ran?: {
    path: string;
    axis?: AxisName;
    ref: string;
    quality: string;
    error?: SnapshotFile["error"];
  }[];
}): { report: RunReport; json: string } {
  const levels = [];
  const notSimulated = [];
  const snapshots = [];
  const foreign = [];
  const buses = [];
  const instances = [...input.instances].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  );
  for (const inst of instances) {
    if (inst.foreign) {
      foreign.push({
        path: inst.path,
        part: inst.part.id,
        qualityCap: "Q1" as const,
      });
    }
    if (inst.type.buses) {
      for (const [name, bus] of Object.entries(inst.type.buses)) {
        buses.push({
          path: inst.path,
          name,
          protocol: bus.protocol,
          ports: [...bus.ports].sort(),
        });
      }
    }
    for (const axis of AXES) {
      const resolved = inst.axes[axis];
      levels.push({
        path: inst.path,
        part: inst.part.id,
        type: inst.type.id,
        axis,
        class: resolved.class,
        variant: resolved.variant,
        impl: resolved.label,
        reason: resolved.reason,
        source: resolved.source,
      });
      const effects = [...resolved.omits];
      if (inst.foreign && axis === "behaviour") {
        effects.push(
          "foreign part: coupled only at event boundaries; snapshot quality capped at Q1"
        );
      }
      notSimulated.push({
        path: inst.path,
        axis,
        class: resolved.class,
        effects,
      });
      const impl = resolved.impl as { kind?: string; ref?: string } | null;
      if (impl?.kind === "snapshot" && impl.ref) {
        snapshots.push({
          path: inst.path,
          axis,
          ref: impl.ref,
          quality: inst.foreign ? "Q1" : "unrated",
        });
      }
    }
  }
  for (const row of input.ran ?? []) {
    snapshots.push({
      path: row.path,
      axis: row.axis ?? "behaviour",
      ref: row.ref,
      quality: row.quality,
      ...(row.error !== undefined ? { error: row.error } : {}),
      envelope: [],
    });
  }
  snapshots.sort((a, b) => {
    const ka = `${a.path}|${a.ref}`;
    const kb = `${b.path}|${b.ref}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  buses.sort((a, b) => {
    const ka = `${a.path}|${a.name}`;
    const kb = `${b.path}|${b.name}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  foreign.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const report: RunReport = {
    format: RUN_REPORT_FORMAT,
    world: input.world,
    seed: input.seed,
    rngDraws: 0,
    lock: {
      parts: input.lock.parts.map((part) => ({
        id: part.id,
        version: part.version,
        sha256: part.sha256,
        source: part.source,
      })),
      types: input.lock.types.map((type) => ({
        id: type.id,
        sha256: type.sha256,
        source: type.source,
      })),
      ...(input.lock.snapshots && input.lock.snapshots.length > 0
        ? {
            snapshots: input.lock.snapshots.map((row) => ({
              id: row.id,
              sha256: row.sha256,
              source: row.source,
            })),
          }
        : {}),
    },
    levels,
    nets: input.nets.map((net) => ({
      id: net.id,
      domain: net.domain,
      ports: net.ports.map((port) => port.full),
      level: net.level,
      reason: net.reason,
    })),
    buses,
    warnings: input.diags.filter((d) => d.severity === "warning"),
    errors: input.diags.filter((d) => d.severity === "error"),
    snapshots,
    snapshotQuality: snapshots.length ? "see snapshots" : NO_SNAPSHOT,
    notSimulated,
    foreign,
    engines: [],
  };
  return { report, json: `${canonicalJson(report)}\n` };
}
