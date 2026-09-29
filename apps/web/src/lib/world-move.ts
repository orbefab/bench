/**
 * Which instance a tool may move. Poses are flat: a stored pose is never
 * composed with its parent's, so only an instance the open part owns
 * directly is drawn where its pose says. Anything else says why not.
 */

import type {
  EditOp,
  Pose,
  WorldViewNode,
  WorldViewTree,
} from "@sfab-bench/contract";

import {
  type InstanceTarget,
  instanceEditTarget,
} from "@/lib/world-edit-target";
import { findViewNode } from "@/lib/world-tree";

export const REASON_OPEN_PART = "Open part to move it";
export const REASON_RUN = "Moved by the run";
export const REASON_ORIGIN = "The open part is the origin";
export const REASON_GROUND = "The ground stays put";

export type MoveTarget =
  | { ok: true; node: WorldViewNode; target: InstanceTarget }
  | { ok: false; reason: string };

export function moveTarget(
  tree: WorldViewTree | null,
  path: string | null
): MoveTarget {
  if (!tree || !path) return { ok: false, reason: "Select a part" };
  if (path === "$root") return { ok: false, reason: REASON_ORIGIN };
  const node = findViewNode(tree.nodes, path);
  if (!node) return { ok: false, reason: "Select a part" };
  if (node.role === "target") return { ok: false, reason: REASON_RUN };
  if (node.role === "ground") return { ok: false, reason: REASON_GROUND };
  const target = instanceEditTarget(tree, path);
  if (!target) return { ok: false, reason: REASON_ORIGIN };
  if (target.part !== undefined) {
    return { ok: false, reason: REASON_OPEN_PART };
  }
  return { ok: true, node, target };
}

export type PoseCommit = {
  ops: EditOp[];
  part?: string;
  label: string;
  previewPath: string;
};

const samePose = (a: Pose, b: Pose) =>
  a.position.every((value, i) => value === b.position[i]) &&
  a.rotation.every((value, i) => value === b.rotation[i]);

/**
 * The one `set-pose` a handle, a drag or a card field sends. Null when the
 * pose is the one the document already has, so a click that did not move
 * sends nothing.
 */
export function poseCommit(
  move: Extract<MoveTarget, { ok: true }>,
  path: string,
  pose: Pose,
  verb = "Move"
): PoseCommit | null {
  if (samePose(move.node.pose, pose)) return null;
  return {
    ops: [
      {
        kind: "set-pose",
        document: move.target.document,
        id: move.target.id,
        pose,
      },
    ],
    part: move.target.part,
    label: `${verb} ${move.node.name}`,
    previewPath: path,
  };
}
