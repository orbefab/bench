/**
 * Which instance a tool may move: one the open part owns directly, whose
 * stored pose is in the open part's frame. A part inside another part
 * file moves with its parent (the run composes the poses) and is moved
 * in its own file. Anything else says why not.
 */

import {
  type EditOp,
  type Pose,
  ROOT_PATH,
  type WorldViewNode,
  type WorldViewTree,
} from "@sfab-bench/contract";

import {
  type InstanceTarget,
  instanceEditTarget,
  stageEditTarget,
} from "@/lib/world-edit-target";
import { findViewNode } from "@/lib/world-tree";

export const REASON_OPEN_PART = "Open part to move it";
export const REASON_RUN = "Moved by the run";
export const REASON_ORIGIN = "The open part is the origin";
export const REASON_GROUND = "The ground stays put";

export type MoveTarget =
  | { ok: true; node: WorldViewNode; target: InstanceTarget }
  | { ok: false; reason: string };

/**
 * `openDocument` is the open tab's file path. A stage scene that the open
 * part owns (`$root` while the stage is not the document) moves like any
 * other direct child; a stage that is the document is the origin.
 */
export function moveTarget(
  tree: WorldViewTree | null,
  path: string | null,
  openDocument: string
): MoveTarget {
  if (!tree || !path) return { ok: false, reason: "Select a part" };
  const node = findViewNode(tree.nodes, path);
  if (!node) return { ok: false, reason: "Select a part" };
  if (path === ROOT_PATH) {
    const stage = stageEditTarget(tree, openDocument);
    if (!stage) return { ok: false, reason: REASON_ORIGIN };
    return { ok: true, node, target: stage };
  }
  if (node.role === "target") return { ok: false, reason: REASON_RUN };
  if (node.role === "ground") return { ok: false, reason: REASON_GROUND };
  const target = instanceEditTarget(tree, path, openDocument);
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
  verb: string
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
