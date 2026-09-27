/** Ported from layered-sim E7 (318b899). */

import {
  AXES,
  type AxisName,
  type BehaviourImpl,
  type LevelClass,
  type Params,
  type PartFile,
  type PartTypeFile,
  type Pose,
  type WorldFileV2,
} from "@sfab-bench/contract";

import { type Library, typeOf } from "./library";
import { classesOf, isLevelClass, specAxes } from "./si";

export type ReasonKind =
  | { kind: "default" }
  | { kind: "type"; type: string }
  | { kind: "path"; path: string }
  | { kind: "parent"; class: LevelClass };

export type ResolvedSource =
  | "default"
  | "type"
  | "path"
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
  default: Record<AxisName, LevelClass>;
  types: Record<string, Partial<Record<AxisName, LevelClass>>>;
  paths: Record<string, Partial<Record<AxisName, LevelClass>>>;
};

export function compileRules(world: WorldFileV2): LevelRules {
  const def = specAxes(world.run.levels.default);
  for (const axis of AXES) {
    if (!isLevelClass(def[axis])) {
      throw new Error(`world default must set ${axis}`);
    }
  }
  const types: LevelRules["types"] = {};
  for (const [id, spec] of Object.entries(world.run.levels.types ?? {})) {
    types[id] = specAxes(spec);
  }
  const paths: LevelRules["paths"] = {};
  for (const [id, spec] of Object.entries(world.run.levels.paths ?? {})) {
    paths[id] = specAxes(spec);
  }
  return {
    default: def as Record<AxisName, LevelClass>,
    types,
    paths,
  };
}

function reasonOf(by: ReasonKind): string {
  if (by.kind === "default") return "default";
  if (by.kind === "type") return `type rule ${by.type}`;
  if (by.kind === "parent") return `parent class ${by.class}`;
  return `path rule ${by.path}`;
}

function sourceOf(by: ReasonKind): ResolvedSource {
  if (by.kind === "default") return "default";
  if (by.kind === "type") return "type";
  if (by.kind === "parent") return "parent";
  return "path";
}

function request(
  rules: LevelRules,
  axis: AxisName,
  instancePath: string,
  typeId: string
): { class: LevelClass; by: ReasonKind } {
  let cls = rules.default[axis];
  let by: ReasonKind = { kind: "default" };
  const typeRule = rules.types[typeId];
  if (typeRule?.[axis] !== undefined) {
    cls = typeRule[axis] as LevelClass;
    by = { kind: "type", type: typeId };
  }
  const pathRule = rules.paths[instancePath];
  if (pathRule?.[axis] !== undefined) {
    cls = pathRule[axis] as LevelClass;
    by = { kind: "path", path: instancePath };
  }
  return { class: cls, by };
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
  parentClass?: LevelClass
): ResolvedAxis {
  const asked = request(rules, axis, instancePath, typeId);
  let requested = asked.class;
  let by = asked.by;
  const map = part.axes?.[axis];
  const available = classesOf(map);
  if (
    axis === "behaviour" &&
    parentClass !== undefined &&
    by.kind === "default" &&
    available.length > 0
  ) {
    requested = parentClass;
    by = { kind: "parent", class: parentClass };
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

function childPath(parent: string, id: string): string {
  if (parent === "$root") return id;
  return `${parent}.${id}`;
}

export function resolveLevels(
  lib: Library,
  rules: LevelRules
): { instances: LiveInstance[]; appliedPaths: Set<string> } {
  const instances: LiveInstance[] = [];
  const appliedPaths = new Set<string>();

  const visit = (
    part: PartFile,
    instancePath: string,
    params: Params,
    pose?: Pose,
    parentClass?: LevelClass
  ) => {
    const type = typeOf(lib, part);
    const axes = {
      behaviour: resolveAxis(
        part,
        "behaviour",
        instancePath,
        type.id,
        rules,
        parentClass
      ),
      body: resolveAxis(part, "body", instancePath, type.id, rules),
      visual: resolveAxis(part, "visual", instancePath, type.id, rules),
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
    const netlist =
      behaviour?.kind === "composite"
        ? behaviour.netlist
        : behaviour?.kind === "firmware"
          ? (behaviour.board ?? null)
          : null;
    if (netlist) {
      // The world root is the scene container. Its children use the world
      // default. A shell that only reached its class by fallback does not
      // pass that class down either: the default still applies underneath.
      const nextParent =
        instancePath !== "$root" &&
        axes.behaviour.class !== null &&
        axes.behaviour.source !== "fallback"
          ? axes.behaviour.class
          : undefined;
      for (const [id, child] of Object.entries(netlist.instances)) {
        const childPart = lib.parts.get(child.part);
        if (!childPart) {
          throw new Error(
            `missing child part ${child.part} under ${instancePath}`
          );
        }
        visit(
          childPart.part,
          childPath(instancePath, id),
          { ...(child.params ?? {}) },
          child.pose,
          nextParent
        );
      }
    }
  };

  const rootPart =
    typeof lib.world.root.part === "string"
      ? lib.parts.get(lib.world.root.part)?.part
      : lib.world.root.part;
  if (!rootPart) throw new Error("root part did not resolve");
  visit(
    rootPart,
    "$root",
    { ...(lib.world.root.params ?? {}) },
    lib.world.root.pose
  );
  instances.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { instances, appliedPaths };
}
