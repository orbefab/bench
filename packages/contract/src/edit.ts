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
  NetlistParams,
  ParamRef,
  PlayBlock,
  PortRef,
  Pose,
} from "./layered";

/**
 * Why an undo or redo is refused when its step is there: a file in it no
 * longer matches what the step wrote. The server sends it as the refusal
 * message, and the web names it.
 */
export const EXTERNAL_EDIT = "the document changed outside this session";

export type EditOp = (
  | AddInstanceOp
  | RemoveInstanceOp
  | SetPoseOp
  | SetParamOp
  | SetLevelOp
  | WireOp
  | UnwireOp
  | RenameInstanceOp
  | RenamePartOp
  | AddCaptureOp
  | RemoveCaptureOp
  | SetPlayOp
  | BatchOp
  | PinExposeOp
) & { confirm?: "break" };

export type AddInstanceOp = {
  kind: "add-instance";
  /** Project-relative path of the open document, or its absolute path. */
  document: string;
  id: string;
  part: string;
  pose?: Pose;
  params?: NetlistParams;
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
  value?: number | string | boolean | ParamRef;
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
   * With `axis`, the rule is `{ class, variant }`. Without it, `class`
   * is the bare number, as before.
   */
  variant?: string;
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

/**
 * Rename the part file this document is. Publisher and version stay.
 * The inverse is a `rename-part` back to the previous name. The session
 * writes every project file that names this part, as one step.
 */
export type RenamePartOp = {
  kind: "rename-part";
  document: string;
  /** New short name. Not a full id. */
  to: string;
};

/**
 * Land a captured snapshot as a new variant on one level of the part this
 * document is. A project part gets the variant in its own file; a library
 * part gets it in the project's level overlay. The session writes the
 * snapshot, the variant, and every root lock it re-pins as one step. It
 * never changes `default`: "use it" is a `set-level` with the variant.
 * The inverse is `remove-capture`.
 */
export type AddCaptureOp = {
  kind: "add-capture";
  /** Project-relative path of the open document, or its absolute path. */
  document: string;
  /** Part id that gets the variant. Absent: the part this document is. */
  part?: string;
  axis: AxisName;
  level: LevelClass;
  /** Variant name on the level. */
  variant: string;
  /** Snapshot id. Must be the next `<name>-<axis>-<n>` for this part. */
  ref: string;
  /** Text of the snapshot file, with `id` equal to `ref`. */
  snapshot: string;
  omits?: string[];
  /** Inverse of remove-capture. Take `ref` as given and leave the counter. */
  restore?: boolean;
};

/**
 * Take a captured variant and its snapshot file off the part. If a
 * `play.levels` rule in the project selects the variant this answers
 * `needs-confirm`; `confirm: "break"` goes ahead and leaves the rule.
 */
export type RemoveCaptureOp = {
  kind: "remove-capture";
  document: string;
  part?: string;
  axis: AxisName;
  level: LevelClass;
  variant: string;
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

/**
 * The session writes this when an edit would rename or merge a fixed
 * auto port. It is one undo step with the edit that caused it. `remove`
 * is the inverse.
 */
export type PinExposeOp = {
  kind: "pin-expose";
  document: string;
  entries: { key: string; ref: PortRef }[];
  remove?: boolean;
};
