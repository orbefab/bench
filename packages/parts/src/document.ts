/**
 * The part is the document. A v2 world converts into a root part; the
 * loader also does that in memory when a `.world.json` is opened.
 */

import {
  DEFAULT_TIMESTEP_S,
  GROUND_PART_ID,
  type Netlist,
  type NetlistInstance,
  PART_FORMAT,
  type PartFile,
  type PlayBlock,
  TARGET_PART_ID,
  type TargetInstance,
  type WorldFileV2,
  type WorldTarget,
} from "@sfab-bench/contract";

import { dirname } from "./path";
import { parsePartRef } from "./si";

export type EnvironmentKind = "ground" | "target" | "other";

/** Id used only while a `.world.json` is converted in memory. */
export const IMPORT_PART_ID = "sfab/import@1.0.0";

export function isPartFile(value: unknown): value is PartFile {
  if (!value || typeof value !== "object") return false;
  return (value as { format?: unknown }).format === PART_FORMAT;
}

/**
 * Directory that holds `parts/`, `robot/`, and `firmware/`.
 * A root part lives at `<project>/parts/<pub>/<name>@<ver>.json`.
 * A legacy world file lives in the project directory itself.
 */
export function assetDir(file: string): string {
  const norm = file.replace(/\\/g, "/");
  const match = /^(.*)\/parts\/[^/]+\/[^/]+@\d+\.\d+\.\d+\.json$/i.exec(norm);
  if (match?.[1]) return match[1];
  return dirname(file);
}

export function partFilePath(projectDir: string, id: string): string | null {
  const parsed = parsePartRef(id);
  if (!parsed) return null;
  return `${projectDir}/parts/${parsed.publisher}/${parsed.name}@${parsed.version}.json`;
}

/**
 * `sfab/<stem>@1.0.0`, or `sfab/<stem>-bench@1.0.0` when that id is
 * already a part (the arm robot is `sfab/arm@1.0.0`).
 */
export function chooseRootPartId(
  stem: string,
  taken: (id: string) => boolean
): string {
  const plain = `sfab/${stem}@1.0.0`;
  if (!taken(plain)) return plain;
  const bench = `sfab/${stem}-bench@1.0.0`;
  if (!taken(bench)) return bench;
  throw new Error(`root part id is taken: ${plain}`);
}

export function environmentKind(part: PartFile): EnvironmentKind {
  const behaviour = part.axes?.behaviour;
  if (!behaviour) return "other";
  for (const slot of Object.values(behaviour)) {
    if (!slot) continue;
    for (const variant of Object.values(slot.variants)) {
      if (variant.kind !== "form") continue;
      if (variant.form === "ground-plane@1") return "ground";
      if (variant.form === "target@1") return "target";
    }
  }
  return "other";
}

function compositeNetlist(part: PartFile): Netlist | null {
  const behaviour = part.axes?.behaviour;
  if (!behaviour) return null;
  const preferred = behaviour["2"] ? [behaviour["2"]] : [];
  const slots = [...preferred, ...Object.values(behaviour)];
  for (const slot of slots) {
    if (!slot) continue;
    const variant =
      slot.variants[slot.default] ?? Object.values(slot.variants)[0];
    if (variant?.kind === "composite") return variant.netlist;
  }
  return null;
}

function levelsOf(world: WorldFileV2): PlayBlock["levels"] {
  const levels = world.run.levels;
  return {
    default: levels.default,
    ...(levels.types ? { types: levels.types } : {}),
    ...(levels.paths ? { paths: levels.paths } : {}),
    ...(levels.nets ? { nets: levels.nets } : {}),
  };
}

function targetInstance(value: unknown): {
  pose: NonNullable<NetlistInstance["pose"]>;
  target: TargetInstance;
} | null {
  if (!value || typeof value !== "object") return null;
  const row = value as WorldTarget;
  if (!row.pose || !row.shape) return null;
  const target: TargetInstance = {
    shape: row.shape,
    size: row.size,
    ...(row.path ? { path: row.path } : {}),
  };
  return { pose: row.pose, target };
}

function noneAxis(omit: string): PartFile["axes"] {
  return {
    behaviour: {
      "2": {
        default: "netlist",
        variants: {
          netlist: {
            kind: "composite",
            omits: [omit],
            netlist: { instances: {}, wires: [], expose: {} },
          },
        },
      },
    },
    body: {
      "0": {
        default: "none",
        variants: { none: { kind: "none", omits: ["assembly adds no body"] } },
      },
    },
    visual: {
      "0": {
        default: "none",
        variants: {
          none: { kind: "none", omits: ["assembly adds no visual"] },
        },
      },
    },
  };
}

/**
 * A v2 world becomes one root part. The scene, the ground, and the
 * targets are instances. Level paths and net choices stay on `play`,
 * so two roots can share one scene part.
 */
export function worldToPart(world: WorldFileV2, id: string): PartFile {
  const root = world.root;
  if (typeof root.part !== "string") {
    throw new Error("an inline root is already a part");
  }
  const instances: Record<string, NetlistInstance> = {};
  const scene: NetlistInstance = { part: root.part };
  if (root.pose) scene.pose = root.pose;
  if (root.params) scene.params = root.params;
  instances[root.id] = scene;
  if (world.environment.ground?.plane) {
    const groundId = instances.ground ? "ground-plane" : "ground";
    instances[groundId] = { part: GROUND_PART_ID };
  }
  for (const raw of world.environment.targets ?? []) {
    const built = targetInstance(raw);
    const targetId =
      raw &&
      typeof raw === "object" &&
      typeof (raw as { id?: unknown }).id === "string"
        ? (raw as { id: string }).id
        : "";
    if (!built || !targetId || instances[targetId]) continue;
    instances[targetId] = {
      part: TARGET_PART_ID,
      pose: built.pose,
      target: built.target,
    };
  }
  const play: PlayBlock = {
    gravity: [...(world.environment.gravity ?? [0, 0, -9.81])],
    seed: world.run.seed,
    timestep: world.run.timestep ?? DEFAULT_TIMESTEP_S,
    levels: levelsOf(world),
    ...(world.environment.air ? { air: world.environment.air } : {}),
    ...(world.environment.primitives
      ? { primitives: world.environment.primitives }
      : {}),
    ...(world.environment.stepProps
      ? { stepProps: world.environment.stepProps }
      : {}),
  };
  const axes = noneAxis("play settings are not a behaviour");
  const netlist = axes?.behaviour?.["2"]?.variants.netlist;
  if (netlist && netlist.kind === "composite") {
    netlist.netlist = { instances, wires: [], expose: {} };
  }
  return {
    format: PART_FORMAT,
    id,
    type: "assembly",
    foreign: false,
    play,
    axes,
  };
}

function worldTarget(
  id: string,
  inst: NetlistInstance
): Record<string, unknown> | null {
  const spec = inst.target;
  const pose = inst.pose;
  if (!spec || !pose) return null;
  return {
    id,
    shape: spec.shape,
    size: spec.size,
    pose,
    ...(spec.path ? { path: spec.path } : {}),
  };
}

/**
 * Play from this part, ground and targets from its netlist. One other
 * instance becomes the scene root, so its children's paths stay
 * unprefixed. Any other shape is itself the root. A nested part's
 * `play` is not read.
 */
export function partToWorld(
  part: PartFile,
  kindOf: (partId: string) => EnvironmentKind
): WorldFileV2 {
  const play = part.play;
  const gravity = play?.gravity ?? [0, 0, -9.81];
  const seed = play?.seed ?? 1;
  const timestep = play?.timestep ?? DEFAULT_TIMESTEP_S;
  const levels = play?.levels ?? { default: 1 };
  const netlist = compositeNetlist(part);
  const environment: WorldFileV2["environment"] = {
    ground: { plane: false },
    gravity: [...gravity] as WorldFileV2["environment"]["gravity"],
    ...(play?.air ? { air: play.air } : {}),
    ...(play?.primitives ? { primitives: play.primitives } : {}),
    ...(play?.stepProps ? { stepProps: play.stepProps } : {}),
  };
  let root: WorldFileV2["root"] = { id: "root", part: part.id };
  if (netlist) {
    const rest: [string, NetlistInstance][] = [];
    const targets: Record<string, unknown>[] = [];
    let plane = false;
    for (const [id, inst] of Object.entries(netlist.instances)) {
      const kind = kindOf(inst.part);
      if (kind === "ground") {
        plane = true;
        continue;
      }
      if (kind === "target") {
        const target = worldTarget(id, inst);
        if (target) targets.push(target);
        continue;
      }
      rest.push([id, inst]);
    }
    environment.ground = { plane };
    if (targets.length > 0) environment.targets = targets;
    const only = rest.length === 1 ? rest[0] : undefined;
    if (only) {
      const [id, inst] = only;
      root = {
        id,
        part: inst.part,
        ...(inst.pose ? { pose: inst.pose } : {}),
        ...(inst.params ? { params: inst.params } : {}),
      };
    }
  }
  return {
    version: 2,
    environment,
    run: {
      seed,
      timestep,
      levels,
    },
    root,
  };
}
