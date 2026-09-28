/**
 * What the client draws and inspects. Built on the server from the run
 * plan. Not a file format.
 */

import type { Pose } from "./layered";
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

/** A port on a tree node. The run's port model, without dependents. */
export type WorldViewPort = {
  name: string;
  source: "type" | "expose" | "auto";
  fixed: boolean;
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
  children: WorldViewNode[];
};

/** The open document and its stage, then the instance tree. */
export type WorldViewTree = {
  /** Document part id. An import uses the synthetic id. */
  part: string;
  /** Stage part id. The unwrapped scene, or the document when it is the stage. */
  stage: string;
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
