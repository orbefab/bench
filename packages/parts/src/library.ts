/** Ported from layered-sim E7 (318b899). */

import {
  type BehaviourImpl,
  BODY_FORMS,
  type BodyImpl,
  type Diagnostic,
  DOMAIN_QUANTITIES,
  FORM_PARAMS,
  GROUND_PART_ID,
  isParamRef,
  LEVEL_OVERLAY_FORMAT,
  type LevelOverlayFile,
  type Netlist,
  PART_FORMAT,
  PART_TYPE_FORMAT,
  type PartFile,
  type PartTypeFile,
  TARGET_PART_ID,
} from "@sfab-bench/contract";

import { batteryFrom } from "./battery";
import { bindProblems } from "./bind";
import { PIN_MAP_FIELD, pinMapRefusal, pinMapSource } from "./board-host";
import { comparatorFrom } from "./comparator";
import {
  assetDir,
  environmentKind,
  importedRun,
  isPartFile,
  type RunRoot,
  runRootOf,
} from "./document";
import { expandPartType } from "./expand";
import { gearTrainErrors } from "./gear-train";
import { ldoFrom } from "./ldo";
import { declaredQuantity } from "./params";
import { basename, join, relative, sep } from "./path";
import { collectPartPorts, type PortLevel, type PortWorld } from "./ports";
import {
  classesOf,
  contentHash,
  isScalarParam,
  makeDiag,
  parsePartRef,
  siValue,
  splitPortRef,
} from "./si";
import type { Store } from "./store";

export type LoadedPart = {
  part: PartFile;
  source: "world" | "library" | "catalog" | "inline";
  path: string;
  sha256: string;
  shadowed?: string;
  /** The project's level overlay merged into `part`. `sha256` stays the library file's. */
  overlay?: { path: string; sha256: string; added: OverlayVariant[] };
};

/** One variant the overlay merge added to a library part. */
export type OverlayVariant = { axis: string; level: string; variant: string };

export type LoadedType = {
  type: PartTypeFile;
  source: "world" | "library" | "catalog" | "inline";
  path: string;
  sha256: string;
};

export type Library = {
  worldDir: string;
  worldName: string;
  /** Play, stage, ground, and targets read off the open part. */
  run: RunRoot;
  assetRoot: string;
  parts: Map<string, LoadedPart>;
  types: Map<string, LoadedType>;
};

export type LibraryOptions = {
  store: Store;
  catalogDir: string;
  /** Personal library. Omitted means that layer is skipped. Never a home directory. */
  libraryDir?: string;
  assetRoot: string;
};

function readJson(store: Store, file: string): unknown {
  return JSON.parse(store.readText(file)) as unknown;
}

function relPosix(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}

function partFile(base: string, id: string): string | null {
  const parsed = parsePartRef(id);
  if (!parsed) return null;
  return join(
    base,
    "parts",
    parsed.publisher,
    `${parsed.name}@${parsed.version}.json`
  );
}

function typeFile(base: string, id: string): string {
  return join(base, "types", `${id}.json`);
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
      code: "schema",
      path: id,
      port: "file",
      quantity: "Part",
      left: id,
      right: "publisher/name@version",
      detail: "part id is not publisher/name@version",
    });
  }
  const layers = layersForPart(worldDir, opts, id);
  const found = layers.find((layer) => opts.store.exists(layer.file));
  if (!found) {
    return makeDiag({
      severity: "error",
      code: "missing-file",
      path: id,
      port: "file",
      quantity: "Part",
      left: "missing",
      right: "registry: not found",
      detail: "part not found in project, personal library, or catalog",
    });
  }
  const raw = readJson(opts.store, found.file) as PartFile;
  if (raw.format !== PART_FORMAT) {
    return makeDiag({
      severity: "error",
      code: "schema",
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
      code: "schema",
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
  if (
    found.source !== "catalog" &&
    catalogPath &&
    opts.store.exists(catalogPath)
  ) {
    shadowed = relPosix(opts.assetRoot, catalogPath);
  }
  const sha256 = contentHash(raw);
  let overlay: LoadedPart["overlay"];
  if (found.source !== "world") {
    const file = overlayFile(worldDir, id);
    if (file && opts.store.exists(file)) {
      const merged = mergeOverlay(raw, readJson(opts.store, file), id);
      if (isDiag(merged)) return merged;
      overlay = {
        path: relPosix(opts.assetRoot, file),
        sha256: merged.sha256,
        added: merged.added,
      };
    }
  }
  return {
    part: raw,
    source: found.source,
    path: relPosix(opts.assetRoot, found.file),
    sha256,
    shadowed,
    ...(overlay ? { overlay } : {}),
  };
}

function overlayFile(base: string, id: string): string | null {
  const parsed = parsePartRef(id);
  if (!parsed) return null;
  return join(
    base,
    "overlays",
    parsed.publisher,
    `${parsed.name}@${parsed.version}.levels.json`
  );
}

const OVERLAY_AXES = ["behaviour", "body", "visual"] as const;

/**
 * Adds the overlay's variants to `part` in place. A name the library
 * already has is an error, not an override. A level the library lacks
 * gets its first variant, by name, as the default.
 */
function mergeOverlay(
  part: PartFile,
  rawOverlay: unknown,
  id: string
): { sha256: string; added: OverlayVariant[] } | Diagnostic {
  const added: OverlayVariant[] = [];
  const bad = (left: string, detail: string) =>
    makeDiag({
      severity: "error",
      code: "schema",
      path: id,
      port: "overlay",
      quantity: "Levels",
      left,
      right: "sfab.level-overlay@1",
      detail,
    });
  const overlay = rawOverlay as LevelOverlayFile;
  if (overlay?.format !== LEVEL_OVERLAY_FORMAT) {
    return bad(String(overlay?.format), "level overlay format mismatch");
  }
  if (overlay.part !== id) {
    return bad(String(overlay.part), "level overlay names another part");
  }
  part.axes = part.axes ?? {};
  const axes = part.axes as Record<
    string,
    Record<string, { default: string; variants: Record<string, unknown> }>
  >;
  for (const axis of OVERLAY_AXES) {
    const levels = overlay.axes?.[axis];
    if (!levels) continue;
    for (const [level, add] of Object.entries(levels)) {
      const names = Object.keys(add.variants ?? {}).sort();
      if (names.length === 0) continue;
      const map = axes[axis] ?? {};
      axes[axis] = map;
      const slot = map[level];
      if (!slot) {
        const first = names[0] as string;
        map[level] = { default: first, variants: {} };
      }
      const target = map[level] as { variants: Record<string, unknown> };
      for (const name of names) {
        if (name in target.variants) {
          return bad(
            `${axis} ${level} ${name}`,
            `level overlay variant ${name} clashes with a variant of ${id} ${axis} level ${level}`
          );
        }
        target.variants[name] = (add.variants as Record<string, unknown>)[name];
        added.push({ axis, level, variant: name });
      }
    }
  }
  return { sha256: contentHash(rawOverlay as object), added };
}

export function loadTypeById(
  worldDir: string,
  opts: LibraryOptions,
  id: string
): LoadedType | Diagnostic {
  const layers = layersForType(worldDir, opts, id);
  const found = layers.find((layer) => opts.store.exists(layer.file));
  if (!found) {
    return makeDiag({
      severity: "error",
      code: "missing-file",
      path: id,
      port: "file",
      quantity: "PartType",
      left: id,
      right: "not found",
      detail: "part type not found in project, personal library, or catalog",
    });
  }
  const raw = readJson(opts.store, found.file) as PartTypeFile;
  if (raw.format !== PART_TYPE_FORMAT) {
    return makeDiag({
      severity: "error",
      code: "schema",
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
      code: "schema",
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
      code: "schema",
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
      const netlist = variant.kind === "composite" ? variant.netlist : null;
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
  // Parts live under `<project>/parts/`. A root part file sits there;
  // the project directory is what relative URDF and firmware paths use.
  const worldDir = assetDir(worldFile);
  // The file stem, not the folder: two worlds in one folder, and a copy
  // of the folder keeps the same name.
  const worldName = basename(worldFile).replace(/\.json$/, "");
  let raw: unknown;
  try {
    raw = readJson(opts.store, worldFile);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    diagnostics.push(
      makeDiag({
        severity: "error",
        code: "schema",
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
  // The open part, pinned from these bytes. A level edit loads a
  // sibling temp file; looking the id up again would hash the copy
  // still on disk. A `.world.json` import unwraps back to the scene
  // and pins nothing extra, so an existing world lock still matches.
  let opened: PartFile | null = null;
  let run: RunRoot;
  if (isPartFile(raw)) {
    const kindOf = (id: string) => {
      if (id === GROUND_PART_ID) return "ground" as const;
      if (id === TARGET_PART_ID) return "target" as const;
      const found = loadPartById(worldDir, opts, id);
      if (isDiag(found)) return "other" as const;
      return environmentKind(found.part);
    };
    run = runRootOf(raw, kindOf);
    opened = raw;
  } else {
    const imported = importedRun(raw, (id) =>
      id === GROUND_PART_ID
        ? "ground"
        : id === TARGET_PART_ID
          ? "target"
          : "other"
    );
    if (!imported.ok) {
      diagnostics.push(
        makeDiag({
          severity: "error",
          code: "schema",
          path: worldName,
          port: imported.port,
          quantity: "Part",
          left: imported.left,
          right: imported.port === "version" ? "2" : "part",
          detail:
            imported.port === "version"
              ? "world version is not 2"
              : "world file did not convert",
        })
      );
      return { library: null, diagnostics };
    }
    run = imported.run;
  }

  const parts = new Map<string, LoadedPart>();
  const types = new Map<string, LoadedType>();
  const queue: { id: string | null; inline: PartFile | null; root: boolean }[] =
    [];
  const stagePart = run.stage.part;
  const openedIsStage =
    opened !== null && typeof stagePart === "string" && stagePart === opened.id;
  if (openedIsStage && opened) {
    queue.push({ id: null, inline: opened, root: true });
  } else if (typeof stagePart === "string") {
    queue.push({ id: stagePart, inline: null, root: true });
  } else {
    queue.push({ id: null, inline: stagePart, root: true });
  }
  if (opened && !openedIsStage) {
    queue.push({ id: null, inline: opened, root: false });
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
            code: "schema",
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
        // A missing child is an idle instance. Only a missing root part
        // refuses the library, because that is the open document.
        if (next.root || found.code !== "missing-file") {
          diagnostics.push(found);
        }
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
      if (!parts.has(ref)) queue.push({ id: ref, inline: null, root: false });
    }
  }

  if (diagnostics.length) return { library: null, diagnostics };
  for (const slot of run.slots) {
    const found = parts.get(slot.part);
    if (!found) continue;
    const type = found.part.type;
    slot.type = typeof type === "string" ? type : type.id;
  }
  return {
    library: {
      worldDir,
      worldName,
      run,
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

/** Ports of a part: type, expose, then bubbled free nets. */
export function partPorts(
  lib: Library,
  partId: string,
  spec?: PortLevel
): ReturnType<typeof collectPartPorts> {
  return collectPartPorts(worldOf(lib), partId, spec);
}

function worldOf(lib: Library): PortWorld {
  return {
    part(id) {
      return lib.parts.get(id)?.part ?? null;
    },
    typePorts(part) {
      try {
        return typeOf(lib, part).ports;
      } catch {
        return null;
      }
    },
  };
}

export function typeFileExists(
  worldDir: string,
  opts: LibraryOptions,
  id: string
): boolean {
  return layersForType(worldDir, opts, id).some((layer) =>
    opts.store.exists(layer.file)
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
          code: "missing-file",
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
              code: "schema",
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
            code: "schema",
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
            code: "schema",
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
                code: "schema",
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
    lintAxes(part, type, diags);
  }
  for (const loaded of lib.parts.values()) {
    lintNetlist(lib, loaded.part, diags);
    lintPinMap(lib, loaded.part, diags);
  }
  return diags;
}

function lintAxes(
  part: PartFile,
  type: PartTypeFile,
  diags: Diagnostic[]
): void {
  lintLevelPorts(part, diags);
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
            code: "schema",
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
          lintBehaviour(part.id, name, variant as BehaviourImpl, type, diags);
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

/**
 * Every composite level of a part exposes the same ports, so a level change
 * keeps the wires that reach it. The first composite variant, by class, is
 * the reference.
 */
function lintLevelPorts(part: PartFile, diags: Diagnostic[]): void {
  const map = part.axes?.behaviour;
  if (!map) return;
  let first: { at: string; ports: string[] } | null = null;
  for (const cls of classesOf(map)) {
    const slot = map[String(cls) as "0"];
    if (!slot) continue;
    for (const [name, variant] of Object.entries(slot.variants)) {
      const impl = variant as BehaviourImpl;
      if (impl.kind !== "composite") continue;
      const at = `${cls}/${name}`;
      const ports = Object.keys(impl.netlist.expose).sort();
      if (!first) {
        first = { at, ports };
        continue;
      }
      const ref = first;
      const lacks = ref.ports.filter((port) => !ports.includes(port));
      const adds = ports.filter((port) => !ref.ports.includes(port));
      if (lacks.length === 0 && adds.length === 0) continue;
      const differ = [
        ...(lacks.length > 0 ? [`lacks ${lacks.join(", ")}`] : []),
        ...(adds.length > 0 ? [`adds ${adds.join(", ")}`] : []),
      ].join("; ");
      diags.push(
        makeDiag({
          severity: "warning",
          code: "level-ports",
          path: part.id,
          port: "expose",
          quantity: "Level",
          left: at,
          right: ref.at,
          detail: `level ${at} exposes other ports than ${ref.at}: ${differ}`,
        })
      );
    }
  }
}

function lintBehaviour(
  partId: string,
  name: string,
  variant: BehaviourImpl,
  type: PartTypeFile,
  diags: Diagnostic[]
): void {
  if (!Array.isArray(variant.omits)) {
    diags.push(
      makeDiag({
        severity: "error",
        code: "schema",
        path: partId,
        port: name,
        quantity: "Level",
        left: "missing omits",
        right: "string[]",
        detail: "level must declare what it omits",
      })
    );
  }
  if (variant.kind === "firmware") {
    const retired = ["board", "boardCircuit"].filter(
      (field) => field in variant
    );
    if (retired.length > 0) {
      diags.push(
        makeDiag({
          severity: "error",
          code: "schema",
          path: partId,
          port: name,
          quantity: "Level",
          left: retired.join(", "),
          right: "composite",
          detail: `firmware variant field ${retired.join(", ")} is retired: a board is a composite of a chip part and its board parts (docs/formats.md)`,
        })
      );
    }
  }
  if (variant.kind === "form" && isBodyForm(variant.form)) {
    diags.push(
      makeDiag({
        severity: "error",
        code: "schema",
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
        code: "schema",
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
  for (const row of bindProblems(
    variant.form,
    variant.bind ?? {},
    type.ports,
    type.id
  )) {
    diags.push(
      makeDiag({
        severity: "error",
        code: "schema",
        path: partId,
        port: name,
        quantity: "Form",
        left: row.key,
        right: row.value,
        detail: row.reason,
      })
    );
  }
  const optional = new Set(form.optional ?? []);
  const tables = new Set(form.tables ?? []);
  for (const key of form.tables ?? []) {
    if (variant.params[key] === undefined) {
      diags.push(
        makeDiag({
          severity: "error",
          code: "bad-params",
          path: partId,
          port: name,
          quantity: "Form",
          left: "missing",
          right: key,
          detail: `form ${variant.form} is missing param ${key}`,
        })
      );
    }
  }
  for (const key of Object.keys(form.params)) {
    if (optional.has(key)) continue;
    if (variant.params[key] === undefined) {
      diags.push(
        makeDiag({
          severity: "error",
          code: "bad-params",
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
      isScalarParam(cold) &&
      isScalarParam(hot) &&
      !(siValue(hot) > siValue(cold))
    ) {
      diags.push(
        makeDiag({
          severity: "error",
          code: "bad-params",
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
  if (variant.form === "battery@1") {
    const built = batteryFrom(variant.params, {});
    if (!built.ok) {
      diags.push(
        makeDiag({
          severity: "error",
          code: "bad-params",
          path: partId,
          port: name,
          quantity: "Form",
          left: variant.form,
          right: "ocv",
          detail: built.error,
        })
      );
    }
  }
  if (variant.form === "ldo-regulator@1") {
    const built = ldoFrom(variant.params, {});
    if (!built.ok) {
      diags.push(
        makeDiag({
          severity: "error",
          code: "bad-params",
          path: partId,
          port: name,
          quantity: "Form",
          left: variant.form,
          right: "dropout",
          detail: built.error,
        })
      );
    }
  }
  if (variant.form === "comparator@1") {
    const built = comparatorFrom(variant.params, {});
    if (!built.ok) {
      diags.push(
        makeDiag({
          severity: "error",
          code: "bad-params",
          path: partId,
          port: name,
          quantity: "Voltage",
          left: variant.form,
          right: "vHyst",
          detail: built.error,
        })
      );
    }
  }
  for (const key of Object.keys(variant.params)) {
    if (!form.params[key] && !tables.has(key)) {
      diags.push(
        makeDiag({
          severity: "error",
          code: "bad-params",
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
        code: "schema",
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
        code: "bad-params",
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
      const netlist = variant.kind === "composite" ? variant.netlist : null;
      if (!netlist) continue;
      const found = partAt(lib, netlist.instances, rest);
      if (found) return found;
    }
  }
  return null;
}

/**
 * A child param that is an object must be `{ "$param": name }`, and the
 * parent part must declare `name`: a form or firmware param of its own, or
 * one it forwards to a child that declares the param it is given to.
 */
function lintParamRefs(
  lib: Library,
  part: PartFile,
  instances: Netlist["instances"],
  diags: Diagnostic[]
): void {
  const partById = (id: string) => lib.parts.get(id)?.part ?? null;
  for (const [id, child] of Object.entries(instances)) {
    for (const [key, value] of Object.entries(child.params ?? {})) {
      if (typeof value !== "object" || value === null) continue;
      if (!isParamRef(value)) {
        diags.push(
          makeDiag({
            severity: "error",
            code: "bad-params",
            path: part.id,
            port: `${id}.${key}`,
            quantity: "Param",
            left: JSON.stringify(value),
            right: "value or $param",
            detail: `param ${key} is an object that is not { "$param": name }`,
          })
        );
        continue;
      }
      if (declaredQuantity(part, value.$param, partById)) continue;
      diags.push(
        makeDiag({
          severity: "error",
          code: "bad-params",
          path: part.id,
          port: `${id}.${key}`,
          quantity: "Param",
          left: value.$param,
          right: "declared param",
          detail: `param ${key} forwards $param ${value.$param}, which ${part.id} does not declare (${child.part} needs to declare ${key})`,
        })
      );
    }
  }
}

/**
 * A firmware level of a part that also has a composite level runs as its
 * own board, so it names the composite whose expose is its pin map
 * (`pinMapFrom`). The reference must resolve, and its instance must run the
 * same chip. A part with no composite level is a bare chip and names none.
 */
function lintPinMap(lib: Library, part: PartFile, diags: Diagnostic[]): void {
  const behaviour = part.axes?.behaviour;
  if (!behaviour) return;
  const slots = classesOf(behaviour).flatMap((cls) => {
    const slot = behaviour[String(cls) as "0"];
    return slot ? Object.entries(slot.variants) : [];
  });
  for (const [name, impl] of slots) {
    if (impl.kind !== "firmware") continue;
    const ref = impl.pinMapFrom;
    const fail = (detail: string) =>
      diags.push(
        makeDiag({
          severity: "error",
          code: "schema",
          path: part.id,
          port: name,
          quantity: "Level",
          left: ref ? `${ref.class}/${ref.variant}/${ref.instance}` : "missing",
          right: PIN_MAP_FIELD,
          detail,
        })
      );
    const refusal = pinMapRefusal(part, impl);
    if (refusal) {
      fail(refusal);
      continue;
    }
    const source = ref ? pinMapSource(part, ref) : null;
    if (!ref || !source || "error" in source) continue;
    const child = lib.parts.get(source.netlist.instances[ref.instance].part);
    if (!child) continue;
    const chips = classesOf(child.part.axes?.behaviour ?? {}).flatMap((cls) =>
      Object.values(
        child.part.axes?.behaviour?.[String(cls) as "0"]?.variants ?? {}
      ).flatMap((variant) =>
        variant.kind === "firmware" ? [variant.chip] : []
      )
    );
    if (!chips.includes(impl.chip)) {
      fail(
        `pinMapFrom: ${ref.instance} runs chip ${chips.join(", ") || "none"}, not ${impl.chip}`
      );
    }
  }
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
      const netlist = variant.kind === "composite" ? variant.netlist : null;
      if (!netlist) continue;
      const { instances, wires, expose } = netlist;
      lintParamRefs(lib, part, instances, diags);
      const typed = Object.keys(parentType.ports).length > 0;
      for (const [outer, inner] of Object.entries(expose)) {
        if (typed && !parentType.ports[outer]) {
          diags.push(
            makeDiag({
              severity: "error",
              code: "schema",
              path: part.id,
              port: outer,
              quantity: "Port",
              left: outer,
              right: inner,
              detail: "expose names an outer port the type does not have",
            })
          );
        }
        if (!typed && outer.includes(".")) {
          diags.push(
            makeDiag({
              severity: "error",
              code: "schema",
              path: part.id,
              port: outer,
              quantity: "Port",
              left: outer,
              right: inner,
              detail: "a port name cannot contain a dot",
            })
          );
        }
        const ref = splitPortRef(inner);
        const childFile = ref ? partAt(lib, instances, ref.inst) : null;
        if (!ref || !childFile) {
          diags.push(
            makeDiag({
              severity: "error",
              code: "schema",
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
        const childNames = collectPartPorts(worldOf(lib), childFile.id).map(
          (port) => port.name
        );
        if (!childNames.includes(ref.port)) {
          diags.push(
            makeDiag({
              severity: "warning",
              code: "broken-port",
              path: part.id,
              port: ref.port,
              quantity: "Port",
              left: inner,
              right: "missing",
              detail: `expose ${outer} names missing port ${inner}`,
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
                code: "broken-port",
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
        code: "shadowed-part",
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
