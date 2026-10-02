/** The live cards for a link, a supply, and the dispatcher that picks board, supply or part. */

import type { WorldViewNode } from "@sfab-bench/contract";
import { ampsText } from "@/lib/amps-text";
import {
  formatJointReadout,
  type WorldOutline,
  type WorldOutlineLink,
  type WorldOutlineSupply,
} from "@/lib/world-outline";
import { useWorld } from "@/state/world";
import { useWorldTimeline } from "@/state/world-timeline";
import { BoardBody } from "./board-card";
import { PartBody } from "./part-card";
import { Field, socText, voltsText } from "./parts";

function LinkBody({
  robot,
  link,
  info,
  pending,
}: {
  robot: string;
  link: string;
  info: WorldOutlineLink | undefined;
  pending: boolean;
}) {
  const jointName = info?.joint?.name;
  const scrub = useWorldTimeline();
  const liveQ = useWorld((s) =>
    jointName ? s.joints[robot]?.[jointName] : undefined
  );
  const qpos =
    scrub.playhead !== null && jointName
      ? scrub.frame?.joints[robot]?.[jointName]
      : liveQ;
  const joint = info?.joint ?? null;
  const meshes = info?.meshes ?? [];
  if (pending) {
    return (
      <p className="text-[12px] text-muted-foreground">Reading the world…</p>
    );
  }
  const readout = joint ? formatJointReadout(joint, qpos) : null;
  return (
    <>
      <Field label="Robot" value={robot} />
      <Field label="Link" value={link} />
      <Field
        label="Mesh"
        value={meshes.length > 0 ? meshes.join(", ") : "None"}
      />
      {joint && readout ? (
        <>
          <Field label="Joint" value={joint.name} />
          <Field label="Type" value={joint.type || "—"} />
          <Field label="Axis" value={joint.axis ? joint.axis.join(" ") : "—"} />
          {readout.limits ? (
            <Field label="Limits" value={readout.limits} />
          ) : null}
          <Field label={readout.label} value={readout.value} />
        </>
      ) : (
        <p className="text-[12px] text-muted-foreground">No parent joint.</p>
      )}
    </>
  );
}

function feedText(info: WorldOutlineSupply | undefined): string {
  const names = [...(info?.boards ?? []), ...(info?.parts ?? [])];
  return names.length > 0 ? names.join(", ") : "Nothing";
}

function SupplyBody({
  id,
  info,
  pending,
}: {
  id: string;
  info: WorldOutlineSupply | undefined;
  pending: boolean;
}) {
  const live = useWorld((s) => s.supplies[id]);
  const scrub = useWorldTimeline();
  const recorded =
    scrub.playhead !== null ? scrub.frame?.supplies[id] : undefined;
  const voltage = recorded ? recorded.minVoltage : live?.voltage;
  const soc = scrub.playhead !== null ? recorded?.soc : live?.soc;
  if (pending) {
    return (
      <p className="text-[12px] text-muted-foreground">Reading the world…</p>
    );
  }
  return (
    <>
      <Field label="Supply" value={id} />
      <Field
        label="Voltage"
        value={
          scrub.playhead !== null && voltage === undefined
            ? "—"
            : voltsText(voltage ?? info?.voltage ?? 0)
        }
      />
      <Field
        label="Current"
        value={
          recorded
            ? ampsText(recorded.maxCurrent)
            : live
              ? ampsText(live.current)
              : "—"
        }
      />
      {soc === undefined ? null : (
        <Field label="State of charge" value={socText(soc)} />
      )}
      <Field label="Limit" value={info ? ampsText(info.currentLimit) : "—"} />
      <Field label="Series" value={info ? `${info.rSeries} Ω` : "—"} />
      <Field label="Feeds" value={feedText(info)} />
    </>
  );
}

export function LiveBody({
  node,
  link,
  outline,
}: {
  node: WorldViewNode;
  link?: string;
  outline: WorldOutline | null;
}) {
  if (link) {
    const info = outline?.robots
      .find((robot) => robot.id === node.id)
      ?.links.find((item) => item.name === link);
    return (
      <LinkBody
        robot={node.id}
        link={link}
        info={info}
        pending={outline === null}
      />
    );
  }
  const board = outline?.boards.find((item) => item.id === node.id);
  if (board || node.role === "board") {
    return <BoardBody id={node.id} info={board} pending={outline === null} />;
  }
  const supply = outline?.supplies.find((item) => item.id === node.id);
  if (supply || node.role === "supply") {
    return <SupplyBody id={node.id} info={supply} pending={outline === null} />;
  }
  const part = outline?.parts.find((item) => item.id === node.id);
  if (part || node.role === "part") {
    return <PartBody id={node.id} info={part} pending={outline === null} />;
  }
  return null;
}
