/** Ported from layered-sim E7 (318b899). */

import { existsSync } from "node:fs";

import type {
  BehaviourImpl,
  Diagnostic,
  LockFile,
  LockSnapshot,
  RunReport,
  type SnapshotFile,
  WorldFileV2,
} from "@sfab-bench/contract";
import { snapshotRefOf } from "../power-path";
import { sourceBoundsOf, sourceOutside } from "../snapshot-law";
import { type LoadedSnapshot, loadSnapshot } from "../snapshot-load";
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

export type LoadOptions = LibraryOptions;

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
  /** Instance paths whose class-1 USB feed matches the captured port. */
  snapshotRuns: string[];
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
    if (existsSync(sibling)) {
      diagnostics.push(...verifyLock(lib, readLock(sibling)));
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
  const snapshotRuns: string[] = [];
  const ran: {
    path: string;
    ref: string;
    quality: string;
    error: LoadedSnapshot["file"]["error"];
    provenance: RunReport["snapshots"][number]["provenance"];
  }[] = [];
  for (const inst of resolved.instances) {
    const ref = behaviourSnapshot(inst);
    if (!ref) continue;
    let type = null;
    try {
      type = typeOf(lib, inst.part);
    } catch {
      type = null;
    }
    const found = loadSnapshot(lib.worldDir, opts, ref, type);
    diagnostics.push(...found.diagnostics);
    if (!found.loaded) continue;
    const feed = feedOf(inst, resolved.instances, nets);
    if (feed?.type.id === "usb-a-port") {
      const port = portNumbers(feed);
      const bounds = sourceBoundsOf(found.loaded.file);
      const covered =
        port !== null &&
        bounds !== null &&
        !sourceOutside(bounds, port.rs, port.ilimit);
      if (covered) {
        if (!snapshots.some((row) => row.id === found.loaded?.id)) {
          snapshots.push(found.loaded);
        }
        snapshotRuns.push(inst.path);
        ran.push({
          path: inst.path,
          ref,
          quality: found.loaded.quality,
          error: found.loaded.file.error,
          provenance: provenanceOf(found.loaded.file),
        });
      } else {
        diagnostics.push(
          makeDiag({
            severity: "warning",
            path: inst.path,
            port: "5V",
            quantity: "Resistance",
            left: port ? `${port.rs} Ω, ${port.ilimit} A` : feed.type.id,
            right: bounds
              ? `${bounds.resistance[0]} Ω, ${bounds.currentLimit[0]} A`
              : "captured port",
            detail: `snapshot ${ref} does not cover this usb-a-port; ideal terminal`,
          })
        );
      }
    } else if (feed) {
      diagnostics.push(
        makeDiag({
          severity: "warning",
          path: inst.path,
          port: "5V",
          quantity: "Voltage",
          left: feed.type.id,
          right: "usb-a-port",
          detail: `snapshot ${ref} does not cover this feed; ideal terminal`,
        })
      );
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
  if (existsSync(sibling)) {
    diagnostics.push(...verifyLock(lib, readLock(sibling), pins));
  }

  diagnostics.push(
    ...checkWorld(resolved.instances, nets, wires, opts.assetRoot)
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

function behaviourSnapshot(inst: LiveInstance): string | null {
  const impl = inst.axes.behaviour.impl as BehaviourImpl | null;
  if (impl?.kind !== "firmware") return null;
  return snapshotRefOf(impl.boardCircuit ?? null);
}

function feedOf(
  inst: LiveInstance,
  instances: LiveInstance[],
  nets: LiveNet[]
): LiveInstance | null {
  const net = nets.find((item) =>
    item.ports.some((port) => port.path === inst.path && port.port === "5V")
  );
  if (!net) return null;
  for (const port of net.ports) {
    if (port.path === inst.path) continue;
    const other = instances.find((item) => item.path === port.path);
    if (!other) continue;
    if (
      other.type.id === "usb-a-port" ||
      other.type.id === "bench-supply-cv-cc"
    ) {
      return other;
    }
  }
  return null;
}

function portNumbers(
  inst: LiveInstance
): { rs: number; ilimit: number } | null {
  const impl = inst.axes.behaviour.impl as BehaviourImpl | null;
  if (impl?.kind !== "form") return null;
  const rs = overridden(impl.params?.Rs, inst.params.Rs);
  const ilimit = overridden(impl.params?.Ilimit, inst.params.Ilimit);
  if (rs === null || ilimit === null) return null;
  return { rs, ilimit };
}

function overridden(form: unknown, instance: unknown): number | null {
  const raw = typeof instance === "number" ? instance : form;
  if (typeof raw === "number") return raw;
  if (raw && typeof raw === "object" && "v" in raw) {
    const v = (raw as { v: unknown }).v;
    return typeof v === "number" ? v : null;
  }
  return null;
}
