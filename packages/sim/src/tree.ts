/** Part tree for the world view. Node ids are the run paths. */

import type {
  BehaviourImpl,
  Pose,
  WorldViewNode,
  WorldViewRole,
  WorldViewTree,
} from "@sfab-bench/contract";
import {
  behaviourNetlist,
  bindDependents,
  collectPartPorts,
  type LiveInstance,
  type PortDependent,
  type PortWorld,
  portDependents,
  type RunRoot,
  type RunSlot,
  type Store,
} from "@sfab-bench/parts";

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
}): WorldViewTree {
  const stagePart = input.run.stage.part;
  const stage = typeof stagePart === "string" ? stagePart : stagePart.id;
  const header = { part: input.run.document, stage };
  const rootInst = input.resolved.find((inst) => inst.path === "$root");
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

  const nodes = new Map<string, WorldViewNode>();
  for (const inst of input.resolved) {
    nodes.set(inst.path, {
      id: inst.path,
      name:
        inst.path === "$root"
          ? input.run.stage.id
          : inst.path.slice(inst.path.lastIndexOf(".") + 1),
      part: inst.part.id,
      type: inst.type.id,
      role: roleFor(inst, sets),
      pose: poseOf(inst.pose),
      ports: portsOf(inst, world, dependents(inst.part.id)),
      children: [],
    });
  }

  for (const inst of input.resolved) {
    const parent = nodes.get(inst.path);
    const behaviour = inst.axes.behaviour.impl as BehaviourImpl | null;
    const netlist = behaviourNetlist(inst.part, behaviour);
    if (!parent || !netlist) continue;
    for (const id of Object.keys(netlist.instances)) {
      const path = inst.path === "$root" ? id : `${inst.path}.${id}`;
      const child = nodes.get(path);
      if (child) {
        parent.children.push(child);
        continue;
      }
      if (inst.path !== "$root" || input.run.unwrapped) continue;
      const slot = input.run.slots.find((row) => row.id === id);
      if (!slot || (slot.kind !== "ground" && slot.kind !== "target")) continue;
      parent.children.push(envNode(slot, path));
    }
  }

  const root = nodes.get("$root");
  if (!root) return { ...header, nodes: [] };
  if (!input.run.unwrapped) return { ...header, nodes: [root] };
  const top: WorldViewNode[] = [];
  for (const slot of input.run.slots) {
    if (slot.kind === "scene") top.push(root);
    else if (slot.kind === "ground" || slot.kind === "target") {
      top.push(envNode(slot, slot.id));
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
    (port) => ({
      name: port.name,
      source: port.source,
      fixed: port.fixed,
    })
  );
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

function envNode(slot: RunSlot, id: string): WorldViewNode {
  return {
    id,
    name: slot.id,
    part: slot.part,
    type: slot.type ?? "",
    role: slot.kind === "ground" ? "ground" : "target",
    pose: poseOf(slot.pose),
    ports: [],
    children: [],
  };
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
