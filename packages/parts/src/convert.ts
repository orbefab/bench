/**
 * Write a root part and its lock from a v2 world. Pure over `Store`.
 */

import type { WorldFileV2 } from "@sfab-bench/contract";

import {
  assetDir,
  chooseRootPartId,
  partFilePath,
  worldToPart,
} from "./document";
import { loadWorldV2 } from "./load";
import type { LibraryOptions } from "./library";
import { lockPathFor, writeLock } from "./lock";
import { basename } from "./path";

export type ConvertedDocument = {
  partId: string;
  partFile: string;
  lockFile: string;
};

function worldStem(worldFile: string): string {
  return basename(worldFile).replace(/\.world\.json$/i, "").replace(/\.json$/i, "");
}

/**
 * Read `worldFile`, write the root part under the project's `parts/`,
 * and write one lock beside that part.
 */
export function convertWorldFile(
  worldFile: string,
  opts: LibraryOptions
): ConvertedDocument {
  const project = assetDir(worldFile);
  const raw = JSON.parse(opts.store.readText(worldFile)) as WorldFileV2;
  if (raw.version !== 2) {
    throw new Error(`world version is not 2 (${String(raw.version)})`);
  }
  const taken = (id: string) => {
    const projectFile = partFilePath(project, id);
    const catalogFile = partFilePath(opts.catalogDir, id);
    return (
      (!!projectFile && opts.store.exists(projectFile)) ||
      (!!catalogFile && opts.store.exists(catalogFile))
    );
  };
  const partId = chooseRootPartId(worldStem(worldFile), taken);
  const partFile = partFilePath(project, partId);
  if (!partFile) throw new Error(`bad root part id ${partId}`);
  const part = worldToPart(raw, partId);
  opts.store.writeText(partFile, `${JSON.stringify(part, null, 2)}\n`);
  const loaded = loadWorldV2(partFile, { ...opts, assetRoot: project });
  if (!loaded.lock || !loaded.world) {
    const message = loaded.diagnostics.map((diag) => diag.message).join("; ");
    throw new Error(message || "converted part did not load");
  }
  const lockFile = lockPathFor(partFile);
  writeLock(opts.store, lockFile, loaded.lock);
  return { partId, partFile, lockFile };
}
