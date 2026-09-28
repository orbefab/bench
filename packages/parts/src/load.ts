/** Ported from layered-sim E7 (318b899). */

import {
  AXES,
  type BehaviourImpl,
  type BodyImpl,
  type Diagnostic,
  type LockFile,
  type LockSnapshot,
  type RunReport,
  type SnapshotFile,
  SUPPLY_FORMS,
  type WorldFileV2,
} from "@sfab-bench/contract";
import { checkWorld } from "./check";
import {
  compileRules,
  type LevelRules,
  type LiveInstance,
  resolveLevels,
} from "./levels";
import {
  type LibraryOptions,
  lintLibrary,
  loadLibrary,
  shadowWarnings,
  typeFileExists,
  typeOf,
} from "./library";
import { buildLock, lockPathFor, readLock, verifyLock } from "./lock";
import { buildNets, type LiveNet, type Wire } from "./nets";
import { buildReport } from "./report";
import { makeDiag } from "./si";
import { type LoadedSnapshot, loadSnapshot } from "./snapshot-load";

export type LoadOptions = LibraryOptions;

/**
 * Power-input groups at class 1 whose VIN net has a supply. The branch
 * snapshot cannot regulate, so the second resolve runs class 2.
 */
function vinFallbackPaths(
  instances: LiveInstance[],
  nets: LiveNet[]
): Set<string> {
  const supplies = new Set<string>();
  for (const inst of instances) {
    const behaviour = inst.axes.behaviour.impl as {
      kind?: string;
      form?: string;
    } | null;
    if (
      behaviour?.kind !== "form" ||
      !behaviour.form ||
      !(SUPPLY_FORMS as readonly string[]).includes(behaviour.form)
    ) {
      continue;
    }
    supplies.add(inst.path);
  }
  const out = new Set<string>();
  if (supplies.size === 0) return out;
  for (const inst of instances) {
    if (inst.type.id !== "power-input") continue;
    if (inst.axes.behaviour.class !== 1) continue;
    const net = nets.find((item) =>
      item.ports.some((port) => port.path === inst.path && port.port === "VIN")
    );
    if (!net) continue;
    if (net.ports.some((port) => supplies.has(port.path))) out.add(inst.path);
  }
  return out;
}

export type LoadResult = {
  world: WorldFileV2 | null;
  resolved: LiveInstance[];
  nets: LiveNet[];
  /** Wires as written in the part netlists, before nets merge them. */
  wires: Wire[];
  diagnostics: Diagnostic[];
  report: RunReport | null;
  lock: LockFile | null;
  /** Snapshots an instance actually runs. Others stay off the lock. */
  snapshots: LoadedSnapshot[];
  /** Path, axis and ref of each snapshot the resolved levels run. */
  snapshotRuns: { path: string; axis: "behaviour" | "body"; ref: string }[];
};

export function loadWorldV2(worldFile: string, opts: LoadOptions): LoadResult {
  const empty: LoadResult = {
    world: null,
    resolved: [],
    nets: [],
    wires: [],
    diagnostics: [],
    report: null,
    lock: null,
    snapshots: [],
    snapshotRuns: [],
  };
  const loaded = loadLibrary(worldFile, opts);
  if (!loaded.library) {
    return { ...empty, diagnostics: loaded.diagnostics };
  }
  const lib = loaded.library;
  const diagnostics: Diagnostic[] = [];

  let rules: LevelRules;
  try {
    rules = compileRules(lib.world);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    diagnostics.push(
      makeDiag({
        severity: "error",
        path: lib.worldName,
        port: "levels",
        quantity: "Level",
        left: message,
        right: "behaviour, body, visual",
        detail: message,
      })
    );
    return { ...empty, world: lib.world, diagnostics, lock: buildLock(lib) };
  }

  for (const typeId of Object.keys(lib.world.run.levels.types ?? {})) {
    const known =
      lib.types.has(typeId) || typeFileExists(lib.worldDir, opts, typeId);
    if (!known) {
      diagnostics.push(
        makeDiag({
          severity: "error",
          path: "run.levels.types",
          port: typeId,
          quantity: "PartType",
          left: typeId,
          right: "not found",
          detail: `type rule names unknown type ${typeId}`,
        })
      );
    }
  }

  const lint = lintLibrary(lib);
  if (
    lint.some((diag) => diag.severity === "error") ||
    diagnostics.some((d) => d.severity === "error")
  ) {
    const lock = buildLock(lib);
    const sibling = lockPathFor(worldFile);
    if (opts.store.exists(sibling)) {
      diagnostics.push(...verifyLock(lib, readLock(opts.store, sibling)));
    }
    return {
      ...empty,
      world: lib.world,
      diagnostics: [...diagnostics, ...lint],
      lock,
    };
  }

  let resolved: ReturnType<typeof resolveLevels>;
  try {
    resolved = resolveLevels(lib, rules);
    const first = buildNets(resolved.instances, lib.world.run.levels.nets);
    const vin = vinFallbackPaths(resolved.instances, first.nets);
    if (vin.size > 0) resolved = resolveLevels(lib, rules, vin);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    diagnostics.push(
      makeDiag({
        severity: "error",
        path: lib.worldName,
        port: "load",
        quantity: "Part",
        left: message,
        right: "resolved",
        detail: message,
      })
    );
    return {
      ...empty,
      world: lib.world,
      diagnostics,
      lock: buildLock(lib),
    };
  }

  diagnostics.push(...shadowWarnings(lib));
  for (const inst of resolved.instances) {
    for (const axis of AXES) {
      const miss = inst.axes[axis].variantMiss;
      if (!miss) continue;
      diagnostics.push(
        makeDiag({
          severity: "error",
          path: inst.path,
          port: axis,
          quantity: "Level",
          left: miss,
          right: String(inst.axes[axis].requested),
          detail: `class ${inst.axes[axis].requested} variant ${miss} is not on this part`,
        })
      );
    }
  }
  for (const rulePath of Object.keys(rules.paths)) {
    if (!resolved.appliedPaths.has(rulePath)) {
      diagnostics.push(
        makeDiag({
          severity: "error",
          path: rulePath,
          port: "*",
          quantity: "Level",
          left: rulePath,
          right: "no instance",
          detail: "path rule names an instance that was not expanded",
        })
      );
    }
  }

  const { nets, wires } = buildNets(
    resolved.instances,
    lib.world.run.levels.nets
  );
  const snapshots: LoadedSnapshot[] = [];
  const snapshotRuns: LoadResult["snapshotRuns"] = [];
  const ran: {
    path: string;
    axis: "behaviour" | "body";
    ref: string;
    quality: string;
    error: LoadedSnapshot["file"]["error"];
    provenance: RunReport["snapshots"][number]["provenance"];
  }[] = [];
  for (const inst of resolved.instances) {
    for (const ask of snapshotAsks(inst)) {
      let type = null;
      try {
        type = typeOf(lib, inst.part);
      } catch {
        type = null;
      }
      const found = loadSnapshot(lib.worldDir, opts, ask.ref, type);
      diagnostics.push(...found.diagnostics);
      if (!found.loaded) continue;
      if (ask.axis === "body") {
        const file = found.loaded.file;
        if (file.form !== "hinge@1" || file.axis !== "body") {
          diagnostics.push(
            makeDiag({
              severity: "error",
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
        if (type && file.partType !== type.id) {
          diagnostics.push(
            makeDiag({
              severity: "error",
              path: inst.path,
              port: "body",
              quantity: "PartType",
              left: file.partType,
              right: type.id,
              detail: `snapshot ${ask.ref} partType ${file.partType} is not ${type.id}`,
            })
          );
          continue;
        }
      }
      remember(snapshots, found.loaded);
      snapshotRuns.push({
        path: inst.path,
        axis: ask.axis,
        ref: ask.ref,
      });
      ran.push({
        path: inst.path,
        axis: ask.axis,
        ref: ask.ref,
        quality: inst.foreign ? "Q1" : found.loaded.quality,
        error: found.loaded.file.error,
        provenance: provenanceOf(found.loaded.file),
      });
    }
  }

  const pins: LockSnapshot[] = snapshots.map((row) => ({
    id: row.id,
    sha256: row.sha256,
    source: row.source,
    path: row.path,
  }));
  const lock = buildLock(lib, pins);
  const sibling = lockPathFor(worldFile);
  if (opts.store.exists(sibling)) {
    diagnostics.push(...verifyLock(lib, readLock(opts.store, sibling), pins));
  }

  diagnostics.push(
    ...checkWorld(resolved.instances, nets, wires, opts.assetRoot, opts.store)
  );
  const built = buildReport({
    world: lib.worldName,
    seed: lib.world.run.seed,
    lock,
    instances: resolved.instances,
    nets,
    diags: diagnostics,
    ran,
  });
  return {
    world: lib.world,
    resolved: resolved.instances,
    nets,
    wires,
    diagnostics,
    report: built.report,
    lock,
    snapshots,
    snapshotRuns,
  };
}

function provenanceOf(
  file: SnapshotFile
): RunReport["snapshots"][number]["provenance"] {
  const source = file.provenance;
  return {
    source: source.source,
    ...(source.from
      ? { from: { part: source.from.part, level: source.from.level } }
      : {}),
    ...(source.fixture ? { fixture: source.fixture.ref } : {}),
    ...(source.tool
      ? { tool: { name: source.tool.name, version: source.tool.version } }
      : {}),
  };
}

function remember(rows: LoadedSnapshot[], loaded: LoadedSnapshot): void {
  if (!rows.some((row) => row.id === loaded.id)) rows.push(loaded);
}

type SnapshotAsk = {
  ref: string;
  axis: "behaviour" | "body";
};

/** Snapshots this instance's selected behaviour and body run. */
function snapshotAsks(inst: LiveInstance): SnapshotAsk[] {
  const asks: SnapshotAsk[] = [];
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
