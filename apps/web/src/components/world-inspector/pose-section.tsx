/** The pose fields of one placed instance. */

import type { WorldViewNode } from "@sfab-bench/contract";
import { moveTarget, poseCommit } from "@/lib/world-move";
import {
  editPoseField,
  POSE_FIELD_KEYS,
  type PoseFieldKey,
  poseToFields,
} from "@/lib/world-pose-fields";
import { useWorld } from "@/state/world";
import { commitToolEdit } from "@/state/world-tool";
import { NumberField } from "./params";
import { Section } from "./parts";

const POSE_FIELD_LABELS: Record<PoseFieldKey, string> = {
  x: "x (mm)",
  y: "y (mm)",
  z: "z (mm)",
  rx: "rotate x (°)",
  ry: "rotate y (°)",
  rz: "rotate z (°)",
};

/** Position and rotation of an instance. Works in every tool mode. */
export function PoseSection({ node }: { node: WorldViewNode }) {
  const tree = useWorld((s) => s.tree);
  const openDocument = useWorld((s) => s.path);
  const move = moveTarget(tree, node.id, openDocument);
  const fields = poseToFields(node.pose);
  const reason = move.ok ? undefined : move.reason;
  return (
    <Section title="Pose">
      {reason ? (
        <p className="mb-1.5 text-[11px] text-muted-foreground">{reason}</p>
      ) : null}
      <div className="grid grid-cols-2 gap-x-2">
        {POSE_FIELD_KEYS.map((key) => (
          <NumberField
            key={key}
            label={POSE_FIELD_LABELS[key]}
            value={fields[key]}
            disabled={!move.ok}
            title={reason}
            onCommit={(value) => {
              if (!move.ok) return;
              const next = editPoseField(node.pose, key, String(value));
              const commit = next
                ? poseCommit(move, node.id, next, "Set pose of")
                : null;
              if (commit) commitToolEdit(commit);
            }}
          />
        ))}
      </div>
    </Section>
  );
}
