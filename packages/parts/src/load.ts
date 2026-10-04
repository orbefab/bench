/** Ported from layered-sim E7 (318b899). */

import {
  AXES,
  type BehaviourImpl,
  type BodyImpl,
  DEFAULT_TIMESTEP_S,
  type Diagnostic,
  type LevelClass,
  type LockFile,
  type LockSnapshot,
  MAX_STEPS_PER_MS,
  type PartFile,
  ROOT_PATH,
  type RunReport,
  type SnapshotFile,
  SUPPLY_FORMS,
  stepsPerMs,
} from "@sfab-bench/contract";
import { checkWorld } from "./check";
import type { RunRoot } from "./document";
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

function isSupply(inst: LiveInstance): boolean {
  const behaviour = inst.axes.behaviour.impl as {
    kind?: string;
    form?: string;
  } | null;
  return (
    behaviour?.kind === "form" &&
    !!behaviour.form &&
    (SUPPLY_FORMS as readonly string[]).includes(behaviour.form)
  );
}

function behaviourImpl(
  part: PartFile,
  level: LevelClass
): BehaviourImpl | null {
  const slot = part.axes?.behaviour?.[String(level) as "0"];
  const impl = slot?.variants[slot.default];
  return impl ?? null;
}

/**
 * Smallest class distance from `requested`. On a tie, the more detailed
 * class. A snapshot does not express a port outside its branch, so it
 * is not a candidate once this scene drives such a port.
 */
function nearestExpressing(
  part: PartFile,
  requested: LevelClass
): LevelClass | null {
  const available = Object.keys(part.axes?.behaviour ?? {})
    .map((key) => Number(key))
    .filter(
      (level): level is LevelClass =>
        level === 0 || level === 1 || level === 2 || level === 3
    );
  let best: LevelClass | null = null;
  let dist = Number.POSITIVE_INFINITY;
  for (const level of available) {
    const impl = behaviourImpl(part, level);
    if (!impl || impl.kind === "snapshot") continue;
    const gap = Math.abs(level - requested);
    if (gap < dist || (gap === dist && best !== null && level > best)) {
      best = level;
      dist = gap;
    }
  }
  return best;
}

/**
 * A branch snapshot does not expose a port the scene drives with a
 * supply. The second resolve runs the nearest level that can.
 */
function nearestFallback(
  instances: LiveInstance[],
  nets: LiveNet[],
  worldDir: string,
  opts: LoadOptions
): Map<string, LevelClass> {
  const supplies = new Set(instances.filter(isSupply).map((inst) => inst.path));
  const out = new Map<string, LevelClass>();
  if (supplies.size === 0) return out;
  for (const inst of instances) {
    const behaviour = inst.axes.behaviour.impl as {
      kind?: string;
      ref?: string;
    } | null;
    if (behaviour?.kind !== "snapshot" || !behaviour.ref) continue;
    const chosen = inst.axes.behaviour.class;
    if (chosen === null) continue;
    const driven: string[] = [];
    for (const [port, decl] of Object.entries(inst.type.ports)) {
      if (decl.role === "ground") continue;
      const net = nets.find((item) =>
        item.ports.some((end) => end.path === inst.path && end.port === port)
      );
      if (!net) continue;
      if (net.ports.some((end) => supplies.has(end.path))) driven.push(port);
    }
    if (driven.length === 0) continue;
    const found = loadSnapshot(worldDir, opts, behaviour.ref, inst.type);
    const params = found.loaded?.file.params as
      | { across?: unknown }
      | undefined;
    const across = Array.isArray(params?.across)
      ? params.across.filter((item): item is string => typeof item === "string")
      : null;
    if (!across) continue;
    if (driven.every((port) => across.includes(port))) continue;
    const next = nearestExpressing(inst.part, chosen);
    if (next === null || next === chosen) continue;
    out.set(inst.path, next);
  }
  return out;
}

export type LoadResult = {
  /** Null when the file did not load. */
  run: RunRoot | null;
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
    run: null,
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
    rules = compileRules(lib.run);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    diagnostics.push(
      makeDiag({
        severity: "error",
        code: "schema",
        path: lib.worldName,
        port: "levels",
        quantity: "Level",
        left: message,
        right: "behaviour, body, visual",
        detail: message,
      })
    );
    return { ...empty, run: lib.run, diagnostics, lock: buildLock(lib) };
  }

  for (const typeId of Object.keys(lib.run.play.levels.types ?? {})) {
    const known =
      lib.types.has(typeId) || typeFileExists(lib.worldDir, opts, typeId);
    if (!known) {
      diagnostics.push(
        makeDiag({
          severity: "error",
          // A bad level rule, like a bad variant: the run's "not found" is
          // not a missing file.
          code: "bad-params",
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
  const lintErrors = lint.filter((diag) => diag.severity === "error");
  if (diagnostics.some((d) => d.severity === "error")) {
    const lock = buildLock(lib);
    const sibling = lockPathFor(worldFile);
    if (opts.store.exists(sibling)) {
      diagnostics.push(...verifyLock(lib, readLock(opts.store, sibling)));
    }
    return {
      ...empty,
      run: lib.run,
      diagnostics: [...diagnostics, ...lint],
      lock,
    };
  }

  let resolved: ReturnType<typeof resolveLevels>;
  try {
    resolved = resolveLevels(lib, rules);
    const first = buildNets(resolved.instances, lib.run.play.levels.nets);
    const nearer = nearestFallback(
      resolved.instances,
      first.nets,
      lib.worldDir,
      opts
    );
    if (nearer.size > 0) {
      const again = resolveLevels(lib, rules, nearer);
      resolved = {
        ...again,
        missing: [...resolved.missing, ...again.missing],
        unresolved: [...resolved.unresolved, ...again.unresolved],
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    diagnostics.push(
      makeDiag({
        severity: "error",
        code: "schema",
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
      run: lib.run,
      diagnostics,
      lock: buildLock(lib),
    };
  }

  const bad = new Set(lintErrors.map((diag) => diag.path));
  const idle = resolved.instances.filter(
    (inst) =>
      inst.path !== ROOT_PATH && (bad.has(inst.part.id) || bad.has(inst.path))
  );
  const idlePaths = new Set(idle.map((inst) => inst.path));
  const dropped = (path: string) =>
    idlePaths.has(path) ||
    [...idlePaths].some((idlePath) => path.startsWith(`${idlePath}.`));
  if (idle.length > 0) {
    resolved = {
      ...resolved,
      instances: resolved.instances.filter((inst) => !dropped(inst.path)),
    };
  }
  const used = new Set<string>();
  for (const inst of idle) {
    const diag = lintErrors.find(
      (item) => item.path === inst.part.id || item.path === inst.path
    );
    if (!diag) continue;
    used.add(diag.path);
    diagnostics.push({ ...diag, path: inst.path });
  }
  for (const diag of lintErrors) {
    if (!used.has(diag.path)) diagnostics.push(diag);
  }
  diagnostics.push(...lint.filter((diag) => diag.severity !== "error"));
  const seenMissing = new Set<string>();
  for (const miss of resolved.missing) {
    if (seenMissing.has(miss.path)) continue;
    seenMissing.add(miss.path);
    diagnostics.push(
      makeDiag({
        severity: "error",
        code: "missing-file",
        path: miss.path,
        port: "part",
        quantity: "Part",
        left: miss.partId,
        right: "library",
        detail: `part ${miss.partId} is not in the library`,
      })
    );
  }

  const seenRef = new Set<string>();
  for (const row of resolved.unresolved) {
    const key = `${row.path}\0${row.param}`;
    if (seenRef.has(key)) continue;
    seenRef.add(key);
    diagnostics.push(
      makeDiag({
        severity: "error",
        code: "bad-params",
        path: row.path,
        port: row.param,
        quantity: "Param",
        left: row.ref,
        right: "parent param",
        detail: `param ${row.param} forwards $param ${row.ref}, which the parent instance does not set`,
      })
    );
  }

  diagnostics.push(...shadowWarnings(lib));
  for (const inst of resolved.instances) {
    for (const axis of AXES) {
      const miss = inst.axes[axis].variantMiss;
      if (!miss) continue;
      diagnostics.push(
        makeDiag({
          severity: "error",
          code: "bad-params",
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
          code: "schema",
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

  const { nets, wires, broken } = buildNets(
    resolved.instances,
    lib.run.play.levels.nets
  );
  diagnostics.push(...broken);
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
        if (type && file.partType !== type.id) {
          diagnostics.push(
            makeDiag({
              severity: "error",
              code: "snapshot",
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
      if (ask.axis === "behaviour" && found.loaded.file.form !== "table@1") {
        // A behaviour snapshot in any other form runs as that form, with
        // the file's params: the run dispatches on the form, not on
        // where its numbers came from.
        const file = found.loaded.file;
        const wrong =
          file.axis !== "behaviour"
            ? `snapshot ${ask.ref} is a ${file.axis} snapshot`
            : type && file.partType !== type.id
              ? `snapshot ${ask.ref} partType ${file.partType} is not ${type.id}`
              : null;
        if (wrong) {
          diagnostics.push(
            makeDiag({
              severity: "error",
              code: "snapshot",
              path: inst.path,
              port: "behaviour",
              quantity: "Form",
              left: file.form,
              right: type?.id ?? "-",
              detail: wrong,
            })
          );
          continue;
        }
        const selected = inst.axes.behaviour;
        inst.axes.behaviour = {
          ...selected,
          impl: formOfSnapshot(file, selected.impl as BehaviourImpl),
        };
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
  const step = lib.run.play.timestep;
  if (typeof step === "number" && stepsPerMs(step) === null) {
    diagnostics.push({
      severity: "warning",
      code: "timestep-unsupported",
      path: ROOT_PATH,
      port: "play",
      quantity: "Time",
      left: String(step),
      right: String(DEFAULT_TIMESTEP_S),
      message: `play.timestep ${step} s is not 1 ms divided by a whole number up to ${MAX_STEPS_PER_MS}; the run steps 1 ms`,
    });
  }
  const built = buildReport({
    world: lib.worldName,
    seed: lib.run.play.seed,
    lock,
    instances: resolved.instances,
    nets,
    diags: diagnostics,
    ran,
  });
  return {
    run: lib.run,
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
  file: LoadedSnapshot["file"],
  variant: BehaviourImpl
): BehaviourImpl {
  const params: Record<string, number> = {};
  for (const [key, value] of Object.entries(file.params)) {
    if (typeof value === "number") params[key] = value;
  }
  return { kind: "form", form: file.form, params, omits: variant.omits };
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
