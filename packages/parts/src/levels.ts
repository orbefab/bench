/** Ported from layered-sim E7 (318b899). */

import {
  AXES,
  type AxisName,
  type BehaviourImpl,
  isParamRef,
  type LevelClass,
  type Netlist,
  type NetlistParams,
  type Params,
  type PartFile,
  type PartTypeFile,
  type Pose,
  ROOT_PATH,
} from "@sfab-bench/contract";

import { environmentKind, type RunRoot } from "./document";
import { type Library, typeOf } from "./library";
import { pathRefOf } from "./path-ref";
import { type AxisRequest, classesOf, isLevelClass, specAxes } from "./si";

export type ReasonKind =
  | { kind: "default" }
  | { kind: "type"; type: string }
  | { kind: "path"; path: string }
  | { kind: "instance" }
  | { kind: "parent"; class: LevelClass };

export type ResolvedSource =
  | "default"
  | "type"
  | "path"
  | "instance"
  | "fallback"
  | "parent";

export type ResolvedAxis = {
  axis: AxisName;
  requested: LevelClass;
  requestedBy: ReasonKind;
  class: LevelClass | null;
  variant: string | null;
  reason: string;
  source: ResolvedSource;
  impl: unknown;
  label: string;
  omits: string[];
  /**
   * Set when a variant rule names a variant this class does not have.
   * The axis does not fall back.
   */
  variantMiss?: string;
};

export type LiveInstance = {
  path: string;
  part: PartFile;
  type: PartTypeFile;
  params: Params;
  /** Placement from the netlist instance. Absent when the instance sets none. */
  pose?: Pose;
  axes: Record<AxisName, ResolvedAxis>;
  foreign: boolean;
  declaredOnly: boolean;
};

export type LevelRules = {
  default: Record<AxisName, AxisRequest>;
  types: Record<string, Partial<Record<AxisName, AxisRequest>>>;
  paths: Record<string, Partial<Record<AxisName, AxisRequest>>>;
};

export function compileRules(run: RunRoot): LevelRules {
  const def = specAxes(run.play.levels.default);
  for (const axis of AXES) {
    if (!isLevelClass(def[axis]?.class)) {
      throw new Error(`world default must set ${axis}`);
    }
  }
  const types: LevelRules["types"] = {};
  for (const [id, spec] of Object.entries(run.play.levels.types ?? {})) {
    types[id] = specAxes(spec);
  }
  const paths: LevelRules["paths"] = {};
  for (const [id, spec] of Object.entries(run.play.levels.paths ?? {})) {
    paths[id] = specAxes(spec);
  }
  return {
    default: def as Record<AxisName, AxisRequest>,
    types,
    paths,
  };
}

function reasonOf(by: ReasonKind): string {
  if (by.kind === "default") return "default";
  if (by.kind === "type") return `type rule ${by.type}`;
  if (by.kind === "instance") return "instance level";
  if (by.kind === "parent") return `parent class ${by.class}`;
  return `path rule ${by.path}`;
}

function sourceOf(by: ReasonKind): ResolvedSource {
  if (by.kind === "default") return "default";
  if (by.kind === "type") return "type";
  if (by.kind === "instance") return "instance";
  if (by.kind === "parent") return "parent";
  return "path";
}

function request(
  rules: LevelRules,
  axis: AxisName,
  instancePath: string,
  typeId: string,
  instanceLevel?: Partial<Record<AxisName, AxisRequest>>
): { class: LevelClass; variant?: string; by: ReasonKind } {
  let asked = rules.default[axis];
  let by: ReasonKind = { kind: "default" };
  const typeRule = rules.types[typeId];
  if (typeRule?.[axis] !== undefined) {
    asked = typeRule[axis] as AxisRequest;
    by = { kind: "type", type: typeId };
  }
  // The netlist names this child. A world path rule is the run's override.
  const placed = instanceLevel?.[axis];
  if (placed !== undefined) {
    asked = placed;
    by = { kind: "instance" };
  }
  const pathRule = rules.paths[instancePath];
  if (pathRule?.[axis] !== undefined) {
    asked = pathRule[axis] as AxisRequest;
    by = { kind: "path", path: instancePath };
  }
  return {
    class: asked.class,
    ...(asked.variant !== undefined ? { variant: asked.variant } : {}),
    by,
  };
}

function omitsOf(impl: unknown): string[] {
  if (impl && typeof impl === "object" && "omits" in impl) {
    return [...(impl.omits as string[])];
  }
  return ["no level authored"];
}

function implLabel(impl: unknown): string {
  if (!impl || typeof impl !== "object") return "none";
  const kind = (impl as { kind?: string }).kind;
  if (kind === "form") return `form ${(impl as { form: string }).form}`;
  if (kind === "snapshot") return `snapshot ${(impl as { ref: string }).ref}`;
  if (kind === "firmware") return `firmware ${(impl as { chip: string }).chip}`;
  if (kind === "script") return `script ${(impl as { script: string }).script}`;
  if (typeof kind === "string") return kind;
  return "none";
}

function resolveAxis(
  part: PartFile,
  axis: AxisName,
  instancePath: string,
  typeId: string,
  rules: LevelRules,
  parentClass?: LevelClass,
  instanceLevel?: Partial<Record<AxisName, AxisRequest>>,
  fallbackClass?: ReadonlyMap<string, LevelClass>
): ResolvedAxis {
  const asked = request(rules, axis, instancePath, typeId, instanceLevel);
  let requested = asked.class;
  let by = asked.by;
  const variantName = asked.variant;
  const map = part.axes?.[axis];
  const available = classesOf(map);
  if (
    axis === "behaviour" &&
    parentClass !== undefined &&
    by.kind === "default" &&
    variantName === undefined &&
    available.length > 0
  ) {
    requested = parentClass;
    by = { kind: "parent", class: parentClass };
  }
  if (variantName !== undefined) {
    const slot = map?.[String(requested) as "0"];
    const impl = slot?.variants[variantName] ?? null;
    const reason = `${reasonOf(by)} chose variant ${variantName}`;
    const source = sourceOf(by);
    if (!impl) {
      return {
        axis,
        requested,
        requestedBy: by,
        class: null,
        variant: null,
        reason,
        source,
        impl: null,
        label: "none",
        omits: ["no level authored"],
        variantMiss: variantName,
      };
    }
    return {
      axis,
      requested,
      requestedBy: by,
      class: requested,
      variant: variantName,
      reason,
      source,
      impl,
      label: implLabel(impl),
      omits: omitsOf(impl),
    };
  }
  let chosen: LevelClass | null = null;
  let reason = reasonOf(by);
  let source = sourceOf(by);
  if (available.includes(requested)) {
    chosen = requested;
  } else {
    const cheaper = available.filter((c) => c < requested);
    if (cheaper.length) {
      chosen = Math.max(...cheaper) as LevelClass;
      reason = `fallback from ${requested} to ${chosen} (cheaper)`;
      source = "fallback";
    } else {
      const deeper = available.filter((c) => c > requested);
      if (deeper.length) {
        chosen = Math.min(...deeper) as LevelClass;
        reason = `fallback from ${requested} to ${chosen} (only deeper; capture suggested)`;
        source = "fallback";
      } else {
        chosen = null;
        reason = part.declaredOnly
          ? `no level (requested ${requested} by ${reasonOf(by)}; declared-only)`
          : `no level (requested ${requested} by ${reasonOf(by)})`;
      }
    }
  }
  // The chosen level cannot express a port this scene drives. The
  // nearest other class runs instead. On a tie, the more detailed one.
  // Children do not inherit it; a fallback parent does not pass its
  // class down. The reason is the card's warning.
  const forced = fallbackClass?.get(instancePath);
  if (
    axis === "behaviour" &&
    forced !== undefined &&
    chosen !== forced &&
    available.includes(forced)
  ) {
    chosen = forced;
    source = "fallback";
    reason = "nearest runnable level";
  }
  if (chosen === null || !map) {
    return {
      axis,
      requested,
      requestedBy: by,
      class: null,
      variant: null,
      reason,
      source,
      impl: null,
      label: "none",
      omits: part.declaredOnly
        ? ["declared-only: no working behaviour"]
        : ["no level authored"],
    };
  }
  const slot = map[String(chosen) as "0"];
  if (!slot) {
    return {
      axis,
      requested,
      requestedBy: by,
      class: null,
      variant: null,
      reason,
      source,
      impl: null,
      label: "none",
      omits: ["no level authored"],
    };
  }
  const impl = slot.variants[slot.default] ?? null;
  const omits =
    impl && typeof impl === "object" && "omits" in impl
      ? [...(impl.omits as string[])]
      : ["no level authored"];
  return {
    axis,
    requested,
    requestedBy: by,
    class: chosen,
    variant: impl ? slot.default : null,
    reason,
    source,
    impl,
    label: implLabel(impl),
    omits,
  };
}

/**
 * The netlist this behaviour expands. `path:uno-usb` uses the declaring
 * part's class-2 board, so the wires and the children match class 2.
 */
export function behaviourNetlist(
  part: PartFile,
  behaviour: BehaviourImpl | null
): Netlist | null {
  if (!behaviour) return null;
  if (behaviour.kind === "composite") return behaviour.netlist;
  if (behaviour.kind === "firmware" && behaviour.board) return behaviour.board;
  if (
    behaviour.kind === "firmware" &&
    pathRefOf(behaviour.boardCircuit ?? null) === "uno-usb"
  ) {
    return class2BoardNetlist(part);
  }
  return null;
}

/** The class-2 firmware board, when that variant carries a netlist. */
export function class2BoardNetlist(part: PartFile): Netlist | null {
  const slot = part.axes?.behaviour?.["2"];
  if (!slot) return null;
  const impl = slot.variants[slot.default];
  if (impl?.kind === "firmware" && impl.board) return impl.board;
  return null;
}

function childPath(parent: string, id: string): string {
  if (parent === ROOT_PATH) return id;
  return `${parent}.${id}`;
}

/** A `$param` that names a param the parent instance does not carry. */
export type UnresolvedParam = {
  /** The child instance path. */
  path: string;
  /** The child's own param name. */
  param: string;
  /** The parent param it asked for. */
  ref: string;
};

/**
 * A netlist child's params as plain values. `{ $param: name }` becomes the
 * parent instance's value of `name`. A name the parent lacks leaves the key
 * out and is reported, so the child never sees an `undefined`.
 */
function resolveParams(
  written: NetlistParams | undefined,
  parent: Params,
  path: string,
  unresolved: UnresolvedParam[]
): Params {
  const out: Params = {};
  for (const [name, value] of Object.entries(written ?? {})) {
    if (!isParamRef(value)) {
      out[name] = value;
      continue;
    }
    const forwarded = Object.hasOwn(parent, value.$param)
      ? parent[value.$param]
      : undefined;
    if (forwarded === undefined) {
      unresolved.push({ path, param: name, ref: value.$param });
      continue;
    }
    out[name] = forwarded;
  }
  return out;
}

export function resolveLevels(
  lib: Library,
  rules: LevelRules,
  fallbackClass?: ReadonlyMap<string, LevelClass>
): {
  instances: LiveInstance[];
  appliedPaths: Set<string>;
  missing: { path: string; partId: string }[];
  unresolved: UnresolvedParam[];
} {
  const instances: LiveInstance[] = [];
  const appliedPaths = new Set<string>();
  const missing: { path: string; partId: string }[] = [];
  const unresolved: UnresolvedParam[] = [];

  const visit = (
    part: PartFile,
    instancePath: string,
    params: Params,
    pose?: Pose,
    parentClass?: LevelClass,
    instanceLevel?: Partial<Record<AxisName, AxisRequest>>
  ) => {
    const type = typeOf(lib, part);
    const axes = {
      behaviour: resolveAxis(
        part,
        "behaviour",
        instancePath,
        type.id,
        rules,
        parentClass,
        instanceLevel,
        fallbackClass
      ),
      body: resolveAxis(
        part,
        "body",
        instancePath,
        type.id,
        rules,
        undefined,
        instanceLevel
      ),
      visual: resolveAxis(
        part,
        "visual",
        instancePath,
        type.id,
        rules,
        undefined,
        instanceLevel
      ),
    };
    for (const axis of AXES) {
      const by = axes[axis].requestedBy;
      if (by.kind === "path") appliedPaths.add(by.path);
    }
    instances.push({
      path: instancePath,
      part,
      type,
      params,
      ...(pose ? { pose } : {}),
      axes,
      foreign: part.foreign === true,
      declaredOnly: part.declaredOnly === true,
    });
    const behaviour = axes.behaviour.impl as BehaviourImpl | null;
    const netlist = behaviourNetlist(part, behaviour);
    const aliasNetlist =
      netlist !== null &&
      behaviour?.kind === "firmware" &&
      behaviour.board === undefined;
    if (netlist) {
      // The world root is the scene container. Its children use the world
      // default. A shell that only reached its class by fallback does not
      // pass that class down either: the default still applies underneath.
      const nextParent = aliasNetlist
        ? (2 as LevelClass)
        : instancePath !== ROOT_PATH &&
            axes.behaviour.class !== null &&
            axes.behaviour.source !== "fallback"
          ? axes.behaviour.class
          : undefined;
      for (const [id, child] of Object.entries(netlist.instances)) {
        const childPart = lib.parts.get(child.part);
        if (!childPart) {
          missing.push({
            path: childPath(instancePath, id),
            partId: child.part,
          });
          continue;
        }
        // Ground and targets are the environment, not level rows.
        if (environmentKind(childPart.part) !== "other") continue;
        const path = childPath(instancePath, id);
        visit(
          childPart.part,
          path,
          resolveParams(child.params, params, path, unresolved),
          child.pose,
          nextParent,
          child.level === undefined ? undefined : specAxes(child.level)
        );
      }
    }
  };

  const stage = lib.run.stage;
  const rootPart =
    typeof stage.part === "string"
      ? lib.parts.get(stage.part)?.part
      : stage.part;
  if (!rootPart) throw new Error("root part did not resolve");
  // The document above the stage has no params, so a ref here is unresolved.
  visit(
    rootPart,
    ROOT_PATH,
    resolveParams(stage.params, {}, ROOT_PATH, unresolved),
    stage.pose
  );
  instances.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { instances, appliedPaths, missing, unresolved };
}
