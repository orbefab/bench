/** Ported from layered-sim E7 (318b899). */

import { existsSync } from "node:fs";

import type {
  Diagnostic,
  LockFile,
  RunReport,
  WorldFileV2,
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

  const lock = buildLock(lib);
  const sibling = lockPathFor(worldFile);
  if (existsSync(sibling))
    diagnostics.push(...verifyLock(lib, readLock(sibling)));

  const lint = lintLibrary(lib);
  if (
    lint.some((diag) => diag.severity === "error") ||
    diagnostics.some((d) => d.severity === "error")
  ) {
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
    return { ...empty, world: lib.world, diagnostics, lock };
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
  });
  return {
    world: lib.world,
    resolved: resolved.instances,
    nets,
    wires,
    diagnostics,
    report: built.report,
    lock,
  };
}
