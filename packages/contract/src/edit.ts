/**
 * Typed edits of one open part document. Plain JSON: the agent, the
 * socket, and a script send the same values. The inverse of an edit is
 * another edit. A few fields exist only on that inverse (`restore`,
 * `clear`, `levels`, `index`) so a variant rule and a removed wire can
 * come back.
 */

import type {
  AxisName,
  LevelClass,
  LevelSpec,
  NetlistInstance,
  Params,
  PlayBlock,
  PortRef,
  Pose,
} from "./layered";

export type EditOp =
  | AddInstanceOp
  | RemoveInstanceOp
  | SetPoseOp
  | SetParamOp
  | SetLevelOp
  | WireOp
  | UnwireOp
  | RenameInstanceOp
  | SetPlayOp
  | BatchOp;

export type AddInstanceOp = {
  kind: "add-instance";
  /** Project-relative path of the open document, or its absolute path. */
  document: string;
  id: string;
  part: string;
  pose?: Pose;
  params?: Params;
  level?: LevelSpec;
  /**
   * Inverse of remove-instance. The instance object keeps the key order
   * it had, and the wires, expose entries, and path rules go back to
   * their indexes.
   */
  restore?: {
    index: number;
    instance: NetlistInstance;
    wires: { index: number; pair: [PortRef, PortRef] }[];
    expose: { index: number; key: string; ref: PortRef }[];
    paths: { index: number; key: string; spec: LevelSpec }[];
  };
};

export type RemoveInstanceOp = {
  kind: "remove-instance";
  document: string;
  id: string;
};

export type SetPoseOp = {
  kind: "set-pose";
  document: string;
  id: string;
  pose?: Pose;
  /** Inverse: this instance had no pose. */
  clear?: boolean;
};

export type SetParamOp = {
  kind: "set-param";
  document: string;
  id: string;
  name: string;
  value?: number | string | boolean;
  /** Inverse: this instance had no such param. */
  clear?: boolean;
};

export type SetLevelOp = {
  kind: "set-level";
  document: string;
  scope: "default" | "type" | "path";
  key?: string;
  axis?: AxisName;
  class: LevelClass | null;
  /**
   * Inverse: the previous `play.levels` table. A variant rule is not a
   * class number, so `class` alone cannot restore it.
   */
  levels?: PlayBlock["levels"];
};

export type WireOp = {
  kind: "wire";
  document: string;
  a: PortRef;
  b: PortRef;
  /** Inverse of unwire. Insert the pair at this index. */
  index?: number;
};

export type UnwireOp = {
  kind: "unwire";
  document: string;
  a: PortRef;
  b: PortRef;
};

export type RenameInstanceOp = {
  kind: "rename-instance";
  document: string;
  id: string;
  to: string;
};

export type SetPlayOp = {
  kind: "set-play";
  document: string;
  gravity?: [number, number, number];
  seed?: number;
  timestep?: number;
  /** Inverse: the part had no play block. */
  clear?: boolean;
  /** Inverse of clear: the play block to put back. */
  play?: PlayBlock;
};

export type BatchOp = {
  kind: "batch";
  document: string;
  label: string;
  ops: EditOp[];
};
