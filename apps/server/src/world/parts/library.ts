/** Ported from layered-sim E7 (318b899). */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  type BehaviourImpl,
  BODY_FORMS,
  type BodyImpl,
  type Diagnostic,
  DOMAIN_QUANTITIES,
  FORM_PARAMS,
  PART_FORMAT,
  PART_TYPE_FORMAT,
  type PartFile,
  type PartTypeFile,
  type WorldFileV2,
} from "@sfab-bench/contract";

import { gearTrainErrors } from "../body/gear-train";
import { expandPartType } from "./expand";
import {
  classesOf,
  contentHash,
  makeDiag,
  parsePartRef,
  siValue,
  splitPortRef,
} from "./si";

export type LoadedPart = {
  part: PartFile;
  source: "world" | "library" | "catalog" | "inline";
  path: string;
  sha256: string;
  shadowed?: string;
};

export type LoadedType = {
  type: PartTypeFile;
  source: "world" | "library" | "catalog" | "inline";
  path: string;
  sha256: string;
};

export type Library = {
  worldDir: string;
  worldName: string;
  world: WorldFileV2;
  assetRoot: string;
  parts: Map<string, LoadedPart>;
  types: Map<string, LoadedType>;
};

export type LibraryOptions = {
  catalogDir: string;
  /** Personal library. Omitted means that layer is skipped. Never a home directory. */
  libraryDir?: string;
  assetRoot: string;
};

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

function relPosix(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join("/");
}

function partFile(base: string, id: string): string | null {
  const parsed = parsePartRef(id);
  if (!parsed) return null;
  return path.join(
    base,
    "parts",
    parsed.publisher,
    `${parsed.name}@${parsed.version}.json`
  );
}

function typeFile(base: string, id: string): string {
  return path.join(base, "types", `${id}.json`);
}

function layersForPart(
  worldDir: string,
  opts: LibraryOptions,
  id: string
): { source: LoadedPart["source"]; file: string }[] {
  const layers: { source: LoadedPart["source"]; file: string }[] = [];
  const worldPath = partFile(worldDir, id);
  if (worldPath) layers.push({ source: "world", file: worldPath });
  if (opts.libraryDir) {
    const libPath = partFile(opts.libraryDir, id);
    if (libPath) layers.push({ source: "library", file: libPath });
  }
  const catalogPath = partFile(opts.catalogDir, id);
  if (catalogPath) layers.push({ source: "catalog", file: catalogPath });
  return layers;
}

function layersForType(
  worldDir: string,
  opts: LibraryOptions,
  id: string
): { source: LoadedType["source"]; file: string }[] {
  const layers: { source: LoadedType["source"]; file: string }[] = [
    { source: "world", file: typeFile(worldDir, id) },
  ];
  if (opts.libraryDir) {
    layers.push({ source: "library", file: typeFile(opts.libraryDir, id) });
  }
  layers.push({ source: "catalog", file: typeFile(opts.catalogDir, id) });
  return layers;
}

export function loadPartById(
  worldDir: string,
  opts: LibraryOptions,
  id: string
): LoadedPart | Diagnostic {
  const parsed = parsePartRef(id);
  if (!parsed) {
    return makeDiag({
      severity: "error",
      path: id,
      port: "file",
      quantity: "Part",
      left: id,
      right: "publisher/name@version",
      detail: "part id is not publisher/name@version",
    });
  }
  const layers = layersForPart(worldDir, opts, id);
  const found = layers.find((layer) => existsSync(layer.file));
  if (!found) {
    return makeDiag({
      severity: "error",
      path: id,
      port: "file",
      quantity: "Part",
      left: "missing",
      right: "registry: not found",
      detail: "part not found in project, personal library, or catalog",
    });
  }
  const raw = readJson(found.file) as PartFile;
  if (raw.format !== PART_FORMAT) {
    return makeDiag({
      severity: "error",
      path: id,
      port: "file",
      quantity: "format",
      left: String(raw.format),
      right: PART_FORMAT,
      detail: "part format mismatch",
    });
  }
  if (raw.id !== id) {
    return makeDiag({
      severity: "error",
      path: id,
      port: "file",
      quantity: "Part",
      left: raw.id,
      right: id,
      detail: "part file id does not match the requested id",
    });
  }
  const catalogPath = partFile(opts.catalogDir, id);
  let shadowed: string | undefined;
  if (found.source !== "catalog" && catalogPath && existsSync(catalogPath)) {
    shadowed = relPosix(opts.assetRoot, catalogPath);
  }
  return {
    part: raw,
    source: found.source,
    path: relPosix(opts.assetRoot, found.file),
    sha256: contentHash(raw),
    shadowed,
  };
}

export function loadTypeById(
  worldDir: string,
  opts: LibraryOptions,
  id: string
): LoadedType | Diagnostic {
  const layers = layersForType(worldDir, opts, id);
  const found = layers.find((layer) => existsSync(layer.file));
  if (!found) {
    return makeDiag({
      severity: "error",
      path: id,
      port: "file",
      quantity: "PartType",
      left: id,
      right: "not found",
      detail: "part type not found in project, personal library, or catalog",
    });
  }
  const raw = readJson(found.file) as PartTypeFile;
  if (raw.format !== PART_TYPE_FORMAT) {
    return makeDiag({
      severity: "error",
      path: id,
      port: "file",
      quantity: "format",
      left: String(raw.format),
      right: PART_TYPE_FORMAT,
      detail: "part type format mismatch",
    });
  }
  if (raw.id !== id) {
    return makeDiag({
      severity: "error",
      path: id,
      port: "file",
      quantity: "PartType",
      left: raw.id,
      right: id,
      detail: "part type file id does not match the requested id",
    });
  }
  return {
    type: expandPartType(raw),
    source: found.source,
    path: relPosix(opts.assetRoot, found.file),
    sha256: contentHash(raw),
  };
}

function isDiag(value: unknown): value is Diagnostic {
  return Boolean(
    value &&
      typeof value === "object" &&
      "severity" in value &&
      "message" in value
  );
}

function embeddedType(part: PartFile): LoadedType | Diagnostic | null {
  if (typeof part.type === "string") return null;
  const raw = part.type;
  if (raw.format !== PART_TYPE_FORMAT) {
    return makeDiag({
      severity: "error",
      path: part.id,
      port: "type",
      quantity: "format",
      left: String(raw.format),
      right: PART_TYPE_FORMAT,
      detail: "embedded part type format mismatch",
    });
  }
  return {
    type: expandPartType(raw),
    source: "inline",
    path: "inline",
    sha256: contentHash(raw),
  };
}

function childRefs(part: PartFile): string[] {
  const refs: string[] = [];
  const behaviour = part.axes?.behaviour;
  if (!behaviour) return refs;
  for (const cls of classesOf(behaviour)) {
    const slot = behaviour[String(cls) as "0"];
    if (!slot) continue;
    for (const variant of Object.values(slot.variants)) {
      const netlist =
        variant.kind === "composite"
          ? variant.netlist
          : variant.kind === "firmware"
            ? variant.board
            : null;
      if (!netlist) continue;
      for (const inst of Object.values(netlist.instances)) refs.push(inst.part);
    }
  }
  return refs;
}

export function loadLibrary(
  worldFile: string,
  opts: LibraryOptions
): { library: Library | null; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const worldDir = path.dirname(worldFile);
  // The file stem, not the folder: two worlds in one folder, and a copy
  // of the folder keeps the same name.
  const worldName = path.basename(worldFile).replace(/\.json$/, "");
  let world: WorldFileV2;
  try {
    world = readJson(worldFile) as WorldFileV2;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    diagnostics.push(
      makeDiag({
        severity: "error",
        path: worldName,
        port: "load",
        quantity: "Part",
        left: message,
        right: "world.json",
        detail: "world file did not parse",
      })
    );
    return { library: null, diagnostics };
  }
  if (world.version !== 2) {
    diagnostics.push(
      makeDiag({
        severity: "error",
        path: worldName,
        port: "version",
        quantity: "Part",
        left: String(world.version),
        right: "2",
        detail: "world version is not 2",
      })
    );
    return { library: null, diagnostics };
  }

  const parts = new Map<string, LoadedPart>();
  const types = new Map<string, LoadedType>();
  const queue: { id: string | null; inline: PartFile | null }[] = [];
  if (typeof world.root.part === "string") {
    queue.push({ id: world.root.part, inline: null });
  } else {
    queue.push({ id: null, inline: world.root.part });
  }

  while (queue.length) {
    const next = queue.shift();
    if (!next) break;
    let loaded: LoadedPart;
    if (next.inline) {
      if (next.inline.format !== PART_FORMAT) {
        diagnostics.push(
          makeDiag({
            severity: "error",
            path: next.inline.id,
            port: "file",
            quantity: "format",
            left: String(next.inline.format),
            right: PART_FORMAT,
            detail: "inline part format mismatch",
          })
        );
        continue;
      }
      loaded = {
        part: next.inline,
        source: "inline",
        path: "inline",
        sha256: contentHash(next.inline),
      };
    } else if (next.id) {
      if (parts.has(next.id)) continue;
      const found = loadPartById(worldDir, opts, next.id);
      if (isDiag(found)) {
        diagnostics.push(found);
        continue;
      }
      loaded = found;
    } else {
      continue;
    }
    if (parts.has(loaded.part.id)) continue;
    parts.set(loaded.part.id, loaded);

    const embedded = embeddedType(loaded.part);
    if (isDiag(embedded)) {
      diagnostics.push(embedded);
    } else if (embedded) {
      types.set(embedded.type.id, embedded);
    } else if (typeof loaded.part.type === "string") {
      if (!types.has(loaded.part.type)) {
        const found = loadTypeById(worldDir, opts, loaded.part.type);
        if (isDiag(found)) diagnostics.push(found);
        else types.set(found.type.id, found);
      }
    }
    for (const ref of childRefs(loaded.part)) {
      if (!parts.has(ref)) queue.push({ id: ref, inline: null });
    }
  }

  if (diagnostics.length) return { library: null, diagnostics };
  return {
    library: {
      worldDir,
      worldName,
      world,
      assetRoot: opts.assetRoot,
      parts,
      types,
    },
    diagnostics,
  };
}

export function typeOf(lib: Library, part: PartFile): PartTypeFile {
  if (typeof part.type !== "string") return expandPartType(part.type);
  const loaded = lib.types.get(part.type);
  if (!loaded) throw new Error(`type ${part.type} missing for ${part.id}`);
  return loaded.type;
}

export function typeFileExists(
  worldDir: string,
  opts: LibraryOptions,
  id: string
): boolean {
  return layersForType(worldDir, opts, id).some((layer) =>
    existsSync(layer.file)
  );
}

export function lintLibrary(lib: Library): Diagnostic[] {
  const diags: Diagnostic[] = [];
  for (const loaded of lib.parts.values()) {
    const part = loaded.part;
    let type: PartTypeFile;
    try {
      type = typeOf(lib, part);
    } catch (err) {
      diags.push(
        makeDiag({
          severity: "error",
          path: part.id,
          port: "type",
          quantity: "PartType",
          left: typeof part.type === "string" ? part.type : "inline",
          right: err instanceof Error ? err.message : "missing",
          detail: "part type did not resolve",
        })
      );
      continue;
    }
    if (part.ratings) {
      for (const port of Object.keys(part.ratings)) {
        if (!type.ports[port]) {
          diags.push(
            makeDiag({
              severity: "error",
              path: part.id,
              port,
              quantity: "Port",
              left: port,
              right: Object.keys(type.ports).join(","),
              detail: "rating names a port the type does not have",
            })
          );
        }
      }
    }
    for (const [name, port] of Object.entries(type.ports)) {
      if (!DOMAIN_QUANTITIES[port.domain]) {
        diags.push(
          makeDiag({
            severity: "error",
            path: part.id,
            port: name,
            quantity: "Domain",
            left: String(port.domain),
            right: "electrical|rotational|translational|thermal|mount",
            detail: "unknown port domain",
          })
        );
      }
      if (port.domain === "electrical" && !port.role) {
        diags.push(
          makeDiag({
            severity: "error",
            path: part.id,
            port: name,
            quantity: "Role",
            left: "missing",
            right: "power|ground|logic|analog",
            detail: "electrical port needs a role",
          })
        );
      }
    }
    if (type.buses) {
      for (const [bus, decl] of Object.entries(type.buses)) {
        for (const port of decl.ports) {
          if (!type.ports[port]) {
            diags.push(
              makeDiag({
                severity: "error",
                path: part.id,
                port,
                quantity: "Port",
                left: port,
                right: bus,
                detail: "bus names a port the type does not have",
              })
            );
          }
        }
      }
    }
    lintAxes(part, diags);
  }
  for (const loaded of lib.parts.values()) lintNetlist(lib, loaded.part, diags);
  return diags;
}

function lintAxes(part: PartFile, diags: Diagnostic[]): void {
  for (const axis of ["behaviour", "body", "visual"] as const) {
    const map = part.axes?.[axis];
    if (!map) continue;
    for (const cls of classesOf(map)) {
      const slot = map[String(cls) as "0"];
      if (!slot) continue;
      if (!slot.variants[slot.default]) {
        diags.push(
          makeDiag({
            severity: "error",
            path: part.id,
            port: axis,
            quantity: "Level",
            left: slot.default,
            right: Object.keys(slot.variants).join(","),
            detail: `class ${cls} default variant is missing`,
          })
        );
      }
      if (axis === "behaviour") {
        for (const [name, variant] of Object.entries(slot.variants)) {
          lintBehaviour(part.id, name, variant as BehaviourImpl, diags);
        }
      }
      if (axis === "body") {
        for (const [name, variant] of Object.entries(slot.variants)) {
          lintBody(part.id, name, variant as BodyImpl, diags);
        }
      }
    }
  }
}

function lintBehaviour(
  partId: string,
  name: string,
  variant: BehaviourImpl,
  diags: Diagnostic[]
): void {
  if (!Array.isArray(variant.omits)) {
    diags.push(
      makeDiag({
        severity: "error",
        path: partId,
        port: name,
        quantity: "Level",
        left: "missing omits",
        right: "string[]",
        detail: "level must declare what it omits",
      })
    );
  }
  if (variant.kind === "form" && isBodyForm(variant.form)) {
    diags.push(
      makeDiag({
        severity: "error",
        path: partId,
        port: name,
        quantity: "Form",
        left: variant.form,
        right: "body",
        detail: `${variant.form} is a body-axis form`,
      })
    );
    return;
  }
  if (variant.kind !== "form") return;
  const form = FORM_PARAMS[variant.form];
  if (!form) {
    diags.push(
      makeDiag({
        severity: "error",
        path: partId,
        port: name,
        quantity: "Form",
        left: variant.form,
        right: Object.keys(FORM_PARAMS).join(","),
        detail: "unknown model form",
      })
    );
    return;
  }
  const optional = new Set(form.optional ?? []);
  for (const key of Object.keys(form.params)) {
    if (optional.has(key)) continue;
    if (variant.params[key] === undefined) {
      diags.push(
        makeDiag({
          severity: "error",
          path: partId,
          port: name,
          quantity: String(form.params[key]),
          left: "missing",
          right: key,
          detail: `form ${variant.form} is missing param ${key}`,
        })
      );
    }
  }
  if (variant.form === "ptc-fuse@1") {
    const cold = variant.params.rCold;
    const hot = variant.params.rHot;
    if (
      cold !== undefined &&
      hot !== undefined &&
      !(siValue(hot) > siValue(cold))
    ) {
      diags.push(
        makeDiag({
          severity: "error",
          path: partId,
          port: name,
          quantity: "Resistance",
          left: String(siValue(hot)),
          right: String(siValue(cold)),
          detail: "ptc-fuse@1 needs rHot greater than rCold",
        })
      );
    }
  }
  for (const key of Object.keys(variant.params)) {
    if (!form.params[key]) {
      diags.push(
        makeDiag({
          severity: "error",
          path: partId,
          port: name,
          quantity: "Form",
          left: key,
          right: Object.keys(form.params).join(","),
          detail: `form ${variant.form} has unknown param ${key}`,
        })
      );
    }
  }
}

function isBodyForm(form: string): boolean {
  return (BODY_FORMS as readonly string[]).includes(form);
}

function lintBody(
  partId: string,
  name: string,
  variant: BodyImpl,
  diags: Diagnostic[]
): void {
  const raw = variant as { kind?: string; form?: string };
  if (raw.kind === "form") {
    const form = raw.form ?? "form";
    diags.push(
      makeDiag({
        severity: "error",
        path: partId,
        port: name,
        quantity: "Form",
        left: form,
        right: "body",
        detail: `${form} is a behaviour form on the body axis`,
      })
    );
    return;
  }
  if (variant.kind !== "gear-train") return;
  for (const message of gearTrainErrors(partId, variant)) {
    diags.push(
      makeDiag({
        severity: "error",
        path: partId,
        port: name,
        quantity: "GearTrain",
        left: message,
        right: "gear-train",
        detail: message,
      })
    );
  }
}

function partAt(
  lib: Library,
  instances: Record<string, { part: string }>,
  instPath: string
): PartFile | null {
  const dot = instPath.indexOf(".");
  const head = dot === -1 ? instPath : instPath.slice(0, dot);
  const row = instances[head];
  if (!row) return null;
  const loaded = lib.parts.get(row.part);
  if (!loaded) return null;
  if (dot === -1) return loaded.part;
  const behaviour = loaded.part.axes?.behaviour;
  if (!behaviour) return null;
  const rest = instPath.slice(dot + 1);
  for (const slot of Object.values(behaviour)) {
    if (!slot) continue;
    for (const variant of Object.values(slot.variants)) {
      const netlist =
        variant.kind === "composite"
          ? variant.netlist
          : variant.kind === "firmware"
            ? (variant.board ?? null)
            : null;
      if (!netlist) continue;
      const found = partAt(lib, netlist.instances, rest);
      if (found) return found;
    }
  }
  return null;
}

function lintNetlist(lib: Library, part: PartFile, diags: Diagnostic[]): void {
  const behaviour = part.axes?.behaviour;
  if (!behaviour) return;
  let parentType: PartTypeFile;
  try {
    parentType = typeOf(lib, part);
  } catch {
    return;
  }
  for (const cls of classesOf(behaviour)) {
    const slot = behaviour[String(cls) as "0"];
    if (!slot) continue;
    for (const variant of Object.values(slot.variants)) {
      const netlist =
        variant.kind === "composite"
          ? variant.netlist
          : variant.kind === "firmware"
            ? variant.board
            : null;
      if (!netlist) continue;
      const { instances, wires, expose } = netlist;
      for (const [outer, inner] of Object.entries(expose)) {
        if (!parentType.ports[outer]) {
          diags.push(
            makeDiag({
              severity: "error",
              path: part.id,
              port: outer,
              quantity: "Port",
              left: outer,
              right: inner,
              detail: "expose names an outer port the type does not have",
            })
          );
        }
        const ref = splitPortRef(inner);
        const childFile = ref ? partAt(lib, instances, ref.inst) : null;
        if (!ref || !childFile) {
          diags.push(
            makeDiag({
              severity: "error",
              path: part.id,
              port: outer,
              quantity: "Port",
              left: inner,
              right: "instance.port",
              detail: "expose target is not an instance port",
            })
          );
          continue;
        }
        const childType = typeOf(lib, childFile);
        if (!childType.ports[ref.port]) {
          diags.push(
            makeDiag({
              severity: "error",
              path: part.id,
              port: ref.port,
              quantity: "Port",
              left: inner,
              right: "missing",
              detail: "expose target port does not exist",
            })
          );
        }
      }
      for (const [a, b] of wires) {
        for (const end of [a, b]) {
          const ref = splitPortRef(end);
          if (!ref || !partAt(lib, instances, ref.inst)) {
            diags.push(
              makeDiag({
                severity: "error",
                path: part.id,
                port: end,
                quantity: "Port",
                left: end,
                right: "missing instance",
                detail:
                  "netlist wire names an instance that is not in the composite",
              })
            );
          }
        }
      }
    }
  }
}

export function shadowWarnings(lib: Library): Diagnostic[] {
  const diags: Diagnostic[] = [];
  for (const loaded of lib.parts.values()) {
    if (!loaded.shadowed) continue;
    diags.push(
      makeDiag({
        severity: "warning",
        path: loaded.part.id,
        port: "file",
        quantity: "Part",
        left: loaded.path,
        right: loaded.shadowed,
        detail: "project part shadows a catalog part",
      })
    );
  }
  return diags;
}
