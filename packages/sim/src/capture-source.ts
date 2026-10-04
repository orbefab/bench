/**
 * Where a capture reads its source: the project, then the catalog, the
 * way a world load resolves them. Every capture runner (sweep, group,
 * hinge) reads parts, types and fixtures through one of these, and
 * freshness recomputes a capture's signature in the same order, so a
 * capture is fresh in the project it was taken from.
 */
import type { PartFile, PartTypeFile } from "@sfab-bench/contract";
import {
  type LibraryOptions,
  loadPartById,
  loadTypeById,
  type Store,
} from "@sfab-bench/parts";

export type CaptureSource = {
  catalogDir: string;
  store: Store;
  join(...parts: string[]): string;
  /** The world-layer root a stamp and a load read first. */
  worldDir: string;
  lib: LibraryOptions;
  /** The part, and whether the project's file is the one read. */
  part(id: string): { part: PartFile; inProject: boolean } | null;
  /** The type, and whether the project's file is the one read. */
  type(id: string): { type: PartTypeFile; inProject: boolean } | null;
  /** A part's type: inline, or by id. */
  typeOf(part: PartFile): PartTypeFile | null;
  /** The project's fixture file when it has one, else the catalog's. */
  fixture(id: string): string;
};

/**
 * `projectDir` absent reads the catalog alone: the CLI's catalog capture.
 */
export function captureSource(
  catalogDir: string,
  projectDir: string | undefined,
  files: { store: Store; join(...parts: string[]): string }
): CaptureSource {
  const worldDir = projectDir ?? catalogDir;
  const lib: LibraryOptions = {
    store: files.store,
    catalogDir,
    assetRoot: worldDir,
  };
  const type = (
    id: string
  ): { type: PartTypeFile; inProject: boolean } | null => {
    const found = loadTypeById(worldDir, lib, id);
    if (!("type" in found)) return null;
    return {
      type: found.type as PartTypeFile,
      inProject: projectDir !== undefined && found.source === "world",
    };
  };
  return {
    catalogDir,
    store: files.store,
    join: files.join,
    worldDir,
    lib,
    part(id) {
      const found = loadPartById(worldDir, lib, id);
      if (!("part" in found)) return null;
      return {
        part: found.part,
        inProject: projectDir !== undefined && found.source === "world",
      };
    },
    type,
    typeOf(part) {
      return typeof part.type === "string"
        ? (type(part.type)?.type ?? null)
        : part.type;
    },
    fixture(id) {
      const name = `${id}.fixture.json`;
      if (projectDir) {
        const own = files.join(projectDir, "fixtures", name);
        if (files.store.exists(own)) return own;
      }
      return files.join(catalogDir, "fixtures", name);
    },
  };
}
