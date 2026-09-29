/** Part tree for the world view. Node ids are the run paths. */

import {
  AXES,
  type AxisName,
  type BehaviourImpl,
  type BodyImpl,
  type LevelClass,
  type PartFile,
  type Pose,
  ROOT_PATH,
  type VisualImpl,
  type WorldViewLevelAxis,
  type WorldViewLevelOption,
  type WorldViewNode,
  type WorldViewPartSource,
  type WorldViewPlay,
  type WorldViewRole,
  type WorldViewTree,
} from "@sfab-bench/contract";
import {
  behaviourNetlist,
  bindDependents,
  collectPartPorts,
  type LiveInstance,
  loadPartById,
  type PortDependent,
  type PortWorld,
  portDependents,
  type RunRoot,
  type RunSlot,
  type Store,
  splitPortRef,
} from "@sfab-bench/parts";

import { formAdapter } from "./forms";
import { chipFacts } from "./power-path";

const IDENTITY: Pose = {
  position: [0, 0, 0],
  rotation: [1, 0, 0, 0],
};

export function runTree(input: {
  run: RunRoot;
  resolved: readonly LiveInstance[];
  robots: readonly { id: string }[];
  boards: readonly { id: string }[];
  supplies: readonly { id: string }[];
  parts: readonly { id: string }[];
  rangers: readonly { id: string }[];
  leaves: readonly { id: string }[];
  store: Store;
  projectDir: string;
  catalogDir: string;
  assetRoot: string;
}): WorldViewTree {
  const stagePart = input.run.stage.part;
  const stage = typeof stagePart === "string" ? stagePart : stagePart.id;
  const header = {
    part: input.run.document,
    stage,
    play: playOf(input.run),
  };
  const rootInst = input.resolved.find((inst) => inst.path === ROOT_PATH);
  if (!rootInst) return { ...header, nodes: [] };

  const partIds = new Set(input.parts.map((part) => part.id));
  for (const ranger of input.rangers) partIds.add(ranger.id);
  for (const leaf of input.leaves) partIds.add(leaf.id);
  const sets = {
    robots: new Set(input.robots.map((robot) => robot.id)),
    boards: new Set(input.boards.map((board) => board.id)),
    supplies: new Set(input.supplies.map((supply) => supply.id)),
    parts: partIds,
  };
  const world = portWorld(input.resolved);
  const deps = new Map<string, Map<string, PortDependent[]>>();
  const dependents = (partId: string) => {
    const hit = deps.get(partId);
    if (hit) return hit;
    const next = portDependents(
      input.store,
      input.projectDir,
      { catalogDir: input.catalogDir },
      partId
    );
    deps.set(partId, next);
    return next;
  };

  const partsById = new Map(
    input.resolved.map((inst) => [inst.part.id, inst.part])
  );
  const places = new Map<string, PartPlace | null>();
  const located = (
    id: string
  ): { part: PartFile | null; place: PartPlace | null } => {
    if (places.has(id)) {
      return {
        part: partsById.get(id) ?? null,
        place: places.get(id) ?? null,
      };
    }
    const loaded = loadPartById(
      input.projectDir,
      {
        store: input.store,
        catalogDir: input.catalogDir,
        assetRoot: input.assetRoot,
      },
      id
    );
    if (!("part" in loaded)) {
      places.set(id, null);
      return { part: partsById.get(id) ?? null, place: null };
    }
    partsById.set(id, loaded.part);
    const place = partPlace(loaded.source, loaded.path);
    places.set(id, place);
    return { part: loaded.part, place };
  };
  const partFile = (id: string): PartFile | null => {
    const hit = partsById.get(id);
    if (hit && places.has(id)) return hit;
    return located(id).part;
  };
  const placeOf = (id: string): PartPlace | null => {
    if (places.has(id)) return places.get(id) ?? null;
    return located(id).place;
  };

  const nodes = new Map<string, WorldViewNode>();
  for (const inst of input.resolved) {
    const behaviour = inst.axes.behaviour.impl as BehaviourImpl | null;
    const netlist = behaviourNetlist(inst.part, behaviour);
    nodes.set(inst.path, {
      id: inst.path,
      name:
        inst.path === ROOT_PATH
          ? input.run.stage.id
          : inst.path.slice(inst.path.lastIndexOf(".") + 1),
      part: inst.part.id,
      type: inst.type.id,
      role: roleFor(inst, sets),
      pose: poseOf(inst.pose),
      ports: portsOf(inst, world, dependents(inst.part.id)),
      params: { ...inst.params },
      ...(netlist ? { wires: netlist.wires.map(([a, b]) => ({ a, b })) } : {}),
      levels: levelAxes(inst.part, chosenOf(inst), inst.declaredOnly),
      ...originFields(placeOf(inst.part.id)),
      children: [],
    });
  }

  for (const inst of input.resolved) {
    const parent = nodes.get(inst.path);
    const behaviour = inst.axes.behaviour.impl as BehaviourImpl | null;
    const netlist = behaviourNetlist(inst.part, behaviour);
    if (!parent || !netlist) continue;
    markWired(nodes, inst.path, netlist.wires);
    for (const id of Object.keys(netlist.instances)) {
      const path = inst.path === ROOT_PATH ? id : `${inst.path}.${id}`;
      const child = nodes.get(path);
      if (child) {
        parent.children.push(child);
        continue;
      }
      if (inst.path !== ROOT_PATH || input.run.unwrapped) continue;
      const slot = input.run.slots.find((row) => row.id === id);
      if (!slot || (slot.kind !== "ground" && slot.kind !== "target")) continue;
      parent.children.push(envNode(slot, path, partFile, placeOf(slot.part)));
    }
  }

  const root = nodes.get(ROOT_PATH);
  if (!root) return { ...header, nodes: [] };
  if (!input.run.unwrapped) return { ...header, nodes: [root] };
  const top: WorldViewNode[] = [];
  for (const slot of input.run.slots) {
    if (slot.kind === "scene") top.push(root);
    else if (slot.kind === "ground" || slot.kind === "target") {
      top.push(envNode(slot, slot.id, partFile, placeOf(slot.part)));
    }
  }
  if (!top.includes(root)) top.unshift(root);
  return { ...header, nodes: top };
}

function roleFor(
  inst: LiveInstance,
  sets: {
    robots: Set<string>;
    boards: Set<string>;
    supplies: Set<string>;
    parts: Set<string>;
  }
): WorldViewRole {
  if (sets.robots.has(inst.path)) return "robot";
  if (sets.boards.has(inst.path)) return "board";
  if (sets.supplies.has(inst.path)) return "supply";
  if (sets.parts.has(inst.path)) return "part";
  const behaviour = inst.axes.behaviour.impl as BehaviourImpl | null;
  if (
    behaviour?.kind === "composite" ||
    behaviourNetlist(inst.part, behaviour)
  ) {
    return "assembly";
  }
  return "leaf";
}

function portsOf(
  inst: LiveInstance,
  world: PortWorld,
  deps: Map<string, PortDependent[]>
): WorldViewNode["ports"] {
  const axis = inst.axes.behaviour;
  const spec =
    axis.class === null
      ? undefined
      : {
          class: axis.class,
          ...(axis.variant ? { variant: axis.variant } : {}),
        };
  return bindDependents(collectPartPorts(world, inst.part.id, spec), deps).map(
    (port) => {
      const domain = inst.type.ports[port.name]?.domain;
      return {
        name: port.name,
        source: port.source,
        fixed: port.fixed,
        ...(domain ? { domain } : {}),
        wired: false,
      };
    }
  );
}

/** Marks the child ports that a wire in this netlist names. */
function markWired(
  nodes: Map<string, WorldViewNode>,
  parentPath: string,
  wires: readonly (readonly [string, string])[]
) {
  for (const wire of wires) {
    for (const ref of wire) {
      const end = splitPortRef(ref);
      if (!end) continue;
      const path =
        parentPath === ROOT_PATH ? end.inst : `${parentPath}.${end.inst}`;
      const port = nodes
        .get(path)
        ?.ports.find((item) => item.name === end.port);
      if (port) port.wired = true;
    }
  }
}

function portWorld(resolved: readonly LiveInstance[]): PortWorld {
  const parts = new Map(resolved.map((inst) => [inst.part.id, inst.part]));
  const types = new Map(resolved.map((inst) => [inst.part.id, inst.type]));
  return {
    part(id) {
      return parts.get(id) ?? null;
    },
    typePorts(part) {
      return types.get(part.id)?.ports ?? null;
    },
  };
}

type PartPlace = {
  source: WorldViewPartSource;
  file?: string;
};

/**
 * The loader calls the project layer "world". A part pinned from the
 * open bytes is "inline"; the file on disk is what Open part uses, and
 * `loadPartById` reports that as "world" when the file is in the project.
 */
function partPlace(
  source: "world" | "library" | "catalog" | "inline",
  path: string
): PartPlace {
  if (source === "library") return { source: "library" };
  if (source === "catalog") return { source: "catalog" };
  if (source === "world") return { source: "project", file: path };
  return { source: "project" };
}

function originFields(place: PartPlace | null): {
  source?: WorldViewPartSource;
  file?: string;
} {
  if (!place) return {};
  return {
    source: place.source,
    ...(place.file ? { file: place.file } : {}),
  };
}

function envNode(
  slot: RunSlot,
  id: string,
  partFile: (partId: string) => PartFile | null,
  place: PartPlace | null
): WorldViewNode {
  const part = partFile(slot.part);
  return {
    id,
    name: slot.id,
    part: slot.part,
    type: slot.type ?? "",
    role: slot.kind === "ground" ? "ground" : "target",
    pose: poseOf(slot.pose),
    ports: [],
    params: {},
    levels: part
      ? levelAxes(part, defaultsOf(part), part.declaredOnly === true)
      : [],
    ...originFields(place),
    children: [],
  };
}

function playOf(run: RunRoot): WorldViewPlay {
  const play: WorldViewPlay = {
    gravity: [run.play.gravity[0], run.play.gravity[1], run.play.gravity[2]],
    seed: run.play.seed,
  };
  if (run.play.timestep !== undefined) play.timestep = run.play.timestep;
  return play;
}

function chosenOf(
  inst: LiveInstance
): Partial<Record<AxisName, { class: LevelClass; variant: string } | null>> {
  const chosen: Partial<
    Record<AxisName, { class: LevelClass; variant: string } | null>
  > = {};
  for (const axis of AXES) {
    const resolved = inst.axes[axis];
    chosen[axis] =
      resolved.class !== null && resolved.variant
        ? { class: resolved.class, variant: resolved.variant }
        : null;
  }
  return chosen;
}

/** The default variant of each authored class. Ground and targets have no resolve. */
function defaultsOf(
  part: PartFile
): Partial<Record<AxisName, { class: LevelClass; variant: string } | null>> {
  const chosen: Partial<
    Record<AxisName, { class: LevelClass; variant: string } | null>
  > = {};
  for (const axis of AXES) {
    const map = part.axes?.[axis];
    if (!map) continue;
    const classes = classKeys(map);
    const only = classes.length === 1 ? classes[0] : undefined;
    const slot = only === undefined ? undefined : map[String(only) as "0"];
    chosen[axis] =
      only !== undefined && slot
        ? { class: only, variant: slot.default }
        : null;
  }
  return chosen;
}

function classKeys(map: NonNullable<PartFile["axes"]>[AxisName]): LevelClass[] {
  if (!map) return [];
  const out: LevelClass[] = [];
  for (const cls of [0, 1, 2, 3] as const) {
    if (map[String(cls) as "0"]) out.push(cls);
  }
  return out;
}

/**
 * Options the card can offer. `runnable` uses the same static facts the
 * plan uses before it looks at this scene: a known behaviour kind, a
 * form the adapters run, a chip the loader knows. It misses a snapshot
 * that fails to load, a port the level cannot express, a missing
 * firmware image, an unpowered part, and a motor with no joint.
 */
function levelAxes(
  part: PartFile,
  chosen: Partial<
    Record<AxisName, { class: LevelClass; variant: string } | null>
  >,
  declaredOnly: boolean
): WorldViewLevelAxis[] {
  const axes: WorldViewLevelAxis[] = [];
  for (const axis of AXES) {
    const map = part.axes?.[axis];
    if (!map) continue;
    const options: WorldViewLevelOption[] = [];
    for (const cls of classKeys(map)) {
      const slot = map[String(cls) as "0"];
      if (!slot) continue;
      for (const variant of Object.keys(slot.variants)) {
        const impl = slot.variants[variant];
        const check = runnableOf(axis, impl, declaredOnly);
        options.push({
          class: cls,
          variant,
          label: variantLabel(impl),
          runnable: check.runnable,
          ...(check.reason ? { reason: check.reason } : {}),
        });
      }
    }
    if (options.length === 0) continue;
    const pick = chosen[axis];
    axes.push({
      axis,
      options,
      chosen:
        pick &&
        options.some(
          (opt) => opt.class === pick.class && opt.variant === pick.variant
        )
          ? pick
          : null,
    });
  }
  return axes;
}

const SCENE_FORMS = new Set([
  "dc-motor@1",
  "ranger@1",
  "multibody@1",
  "ground-plane@1",
  "target@1",
]);

function runnableOf(
  axis: AxisName,
  impl: unknown,
  declaredOnly: boolean
): { runnable: boolean; reason?: string } {
  if (axis === "behaviour" && declaredOnly) {
    return { runnable: false, reason: "declared-only" };
  }
  if (!impl || typeof impl !== "object") {
    return { runnable: false, reason: "no level authored" };
  }
  if (axis === "behaviour") return behaviourRunnable(impl as BehaviourImpl);
  if (axis === "visual") return visualRunnable(impl as VisualImpl);
  return bodyRunnable(impl as BodyImpl);
}

function behaviourRunnable(impl: BehaviourImpl): {
  runnable: boolean;
  reason?: string;
} {
  if (impl.kind === "composite" || impl.kind === "snapshot") {
    return { runnable: true };
  }
  if (impl.kind === "firmware") {
    if (!chipFacts(impl.chip)) {
      return { runnable: false, reason: `unknown chip ${impl.chip}` };
    }
    return { runnable: true };
  }
  if (impl.kind === "script") {
    return { runnable: false, reason: "no runtime for script" };
  }
  if (impl.kind === "form") {
    if (SCENE_FORMS.has(impl.form) || formAdapter(impl.form)) {
      return { runnable: true };
    }
    return { runnable: false, reason: `no runtime for form ${impl.form}` };
  }
  return { runnable: false, reason: "no behaviour" };
}

function bodyRunnable(impl: BodyImpl): { runnable: boolean; reason?: string } {
  if (impl.kind === "none") return { runnable: true };
  if (
    impl.kind === "lumped" ||
    impl.kind === "gear-train" ||
    impl.kind === "snapshot" ||
    impl.kind === "urdf" ||
    impl.kind === "mjcf" ||
    impl.kind === "children"
  ) {
    return { runnable: true };
  }
  return { runnable: false, reason: "no body" };
}

function visualRunnable(impl: VisualImpl): {
  runnable: boolean;
  reason?: string;
} {
  // A placeholder mesh is not what this run draws. The plan uses the
  // nearest lower class whose visual is a box, and records that on the
  // axis. The variant stays the resolved level, so the card marks it
  // current and does not gray it.
  if (impl.kind === "mesh" && impl.placeholder === true) {
    return { runnable: false, reason: "placeholder mesh" };
  }
  if (
    impl.kind === "mesh" ||
    impl.kind === "box" ||
    impl.kind === "children" ||
    impl.kind === "none"
  ) {
    return { runnable: true };
  }
  return { runnable: false, reason: "no visual" };
}

function variantLabel(impl: unknown): string {
  if (!impl || typeof impl !== "object") return "none";
  const row = impl as {
    kind?: string;
    form?: string;
    ref?: string;
    chip?: string;
  };
  if (row.kind === "form" && row.form) return row.form;
  if (row.kind === "snapshot" && row.ref) return row.ref;
  if (row.kind === "firmware" && row.chip) return row.chip;
  if (typeof row.kind === "string") return row.kind;
  return "none";
}

function poseOf(pose: Pose | undefined): Pose {
  if (!pose) return IDENTITY;
  return {
    position: [pose.position[0], pose.position[1], pose.position[2]],
    rotation: [
      pose.rotation[0],
      pose.rotation[1],
      pose.rotation[2],
      pose.rotation[3],
    ],
  };
}
