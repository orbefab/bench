/**
 * What the client draws and inspects. Built on the server from the run
 * plan. Not a file format.
 */

import type { AxisName, Domain, LevelClass, Params, Pose } from "./layered";
import type { WorldPrimitive, WorldStepProp, WorldTarget } from "./world";

export type WorldViewRobot = {
  id: string;
  /** Path relative to the world file. */
  urdf: string;
  pose: Pose;
};

export type WorldViewBoard = {
  id: string;
  chip: string;
  firmware: string;
  source?: string;
  pose: Pose;
  size: [number, number, number];
  /** Volts. The card's brownout line uses this, not a client-side catalog. */
  brownoutVoltage: number;
};

export type WorldViewSupply = {
  id: string;
  voltage: number;
  currentLimit: number;
  rSeries: number;
};

/** A part or supply whose resolved visual is a box. A URDF body is not one. */
export type WorldViewBox = {
  id: string;
  pose: Pose;
  size: [number, number, number];
  /** A click selects this part or supply. */
  pick: "part" | "supply";
};

export type WorldViewPart = {
  id: string;
  /** Short name the card shows, for example `sg90`. */
  model: string;
  drives?: { robot: string; joint: string };
  /** Servo signal pin, or null when the part is not a servo. */
  signalPin: string | null;
  /** Ultrasonic ranger. The card shows distance and the echo, not a pulse. */
  ranger?: boolean;
};

/** Which supply reaches a board or a part. Null when nothing feeds it. */
export type PowerFeeds = {
  boards: Record<string, string | null>;
  parts: Record<string, string | null>;
};

export type WorldViewFeeds = PowerFeeds;

export type WorldViewRole =
  | "robot"
  | "board"
  | "supply"
  | "part"
  | "leaf"
  | "ground"
  | "target"
  | "assembly";

/**
 * Where the part file was resolved. The loader's project layer is
 * `project` here. `file` is set only for that layer.
 */
export type WorldViewPartSource = "project" | "library" | "catalog";

/** A port on a tree node. The run's port model, without dependents. */
export type WorldViewPort = {
  name: string;
  source: "type" | "expose" | "auto";
  fixed: boolean;
  /** The port domain the type declares. Absent on a bubbled port. */
  domain?: Domain;
  /** The port is on a wire in its parent's netlist. */
  wired: boolean;
};

/** One authored wire in an assembly's netlist, in file order. */
export type WorldViewWire = {
  a: string;
  b: string;
};

/**
 * One class and variant on an axis. `runnable` is the loader's static
 * check (known kind and form). It does not re-plan the scene.
 */
export type WorldViewLevelOption = {
  class: LevelClass;
  variant: string;
  /** Short name of the implementation, for the picker. */
  label: string;
  runnable: boolean;
  /** Why a grayed option cannot run. Absent when it can. */
  reason?: string;
};

/** One axis the part authors. Missing axes are omitted. */
export type WorldViewLevelAxis = {
  axis: AxisName;
  options: WorldViewLevelOption[];
  /** The level this run resolved. Null when the axis did not resolve. */
  chosen: { class: LevelClass; variant: string } | null;
};

/**
 * One resolved instance. `id` is the run path (`nano`, `fleet.rig2.servo`,
 * `$root`). Ground and targets use their instance id; they are not level rows.
 */
export type WorldViewNode = {
  id: string;
  /** Instance id. `$root` uses the stage's instance id. */
  name: string;
  part: string;
  type: string;
  role: WorldViewRole;
  /** The instance pose. Flat, the same pose the old fields draw. */
  pose: Pose;
  ports: WorldViewPort[];
  /** Instance params, SI. Empty when the instance sets none. */
  params: Params;
  /**
   * Authored wires of this assembly, in netlist order. Absent on a
   * leaf, a ground, and a target.
   */
  wires?: WorldViewWire[];
  /** One picker per axis the part has. Empty when it has none. */
  levels: WorldViewLevelAxis[];
  /**
   * Where this instance's part file was found. Absent when the lookup
   * could not be repeated.
   */
  source?: WorldViewPartSource;
  /**
   * Project-relative document path. Present only when `source` is
   * `project`.
   */
  file?: string;
  children: WorldViewNode[];
};

/** Gravity, seed, and time step of the open document. */
export type WorldViewPlay = {
  /** Metres per second squared. */
  gravity: [number, number, number];
  seed: number;
  /** Seconds. Absent when an imported world did not name a step. */
  timestep?: number;
};

/** The open document and its stage, then the instance tree. */
export type WorldViewTree = {
  /** Document part id. An import uses the synthetic id. */
  part: string;
  /** Stage part id. The unwrapped scene, or the document when it is the stage. */
  stage: string;
  play: WorldViewPlay;
  nodes: WorldViewNode[];
};

export type WorldView = {
  environment: {
    ground: { plane: boolean };
    primitives?: WorldPrimitive[];
    stepProps?: WorldStepProp[];
    targets?: WorldTarget[];
  };
  robots: WorldViewRobot[];
  boards: WorldViewBoard[];
  supplies: WorldViewSupply[];
  parts: WorldViewPart[];
  /** Visual boxes. Empty when no running part resolved a box. */
  boxes: WorldViewBox[];
  wires: [string, string][];
  feeds: WorldViewFeeds;
  /** Part tree. The fields above stay until the editor shell reads this. */
  tree: WorldViewTree;
};
