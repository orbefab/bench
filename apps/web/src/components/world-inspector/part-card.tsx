/** The part card: a servo or ranger's live and recorded readout. */

import { ampsText } from "@/lib/amps-text";
import {
  formatJointReadout,
  formatLiveDegrees,
  formatPartWire,
  type WorldOutline,
  type WorldOutlineJoint,
  type WorldOutlinePart,
} from "@/lib/world-outline";
import { useWorld } from "@/state/world";
import { useWorldTimeline } from "@/state/world-timeline";
import { commandText, Field, motionText, pulseText, voltsText } from "./parts";

function drivenJoint(
  outline: WorldOutline | null,
  drives: { robot: string; joint: string } | null
): WorldOutlineJoint | null {
  if (!outline || !drives) return null;
  const robot = outline.robots.find((item) => item.id === drives.robot);
  for (const link of robot?.links ?? []) {
    if (link.joint?.name === drives.joint) return link.joint;
  }
  return null;
}

export function PartBody({
  id,
  info,
  pending,
}: {
  id: string;
  info: WorldOutlinePart | undefined;
  pending: boolean;
}) {
  const outline = useWorld((s) => s.outline);
  const live = useWorld((s) => s.parts[id]);
  const drives = info?.drives ?? null;
  const liveQ = useWorld((s) =>
    drives ? s.joints[drives.robot]?.[drives.joint] : undefined
  );
  const scrub = useWorldTimeline();
  const recorded = scrub.playhead !== null ? scrub.frame?.parts[id] : undefined;
  const qpos =
    scrub.playhead !== null && drives
      ? scrub.frame?.joints[drives.robot]?.[drives.joint]
      : liveQ;
  if (pending) {
    return (
      <p className="text-[12px] text-muted-foreground">Reading the world…</p>
    );
  }
  const joint = drivenJoint(outline, drives);
  const angle = joint
    ? formatJointReadout(joint, qpos).value
    : qpos === undefined
      ? "—"
      : `${formatLiveDegrees(qpos)}°`;
  const wires = info?.wires ?? [];
  return (
    <>
      <Field label="Part" value={id} />
      <Field label="Model" value={info?.model ?? "—"} />
      <div className="mb-1.5 min-w-0">
        <div className="text-[11px] text-muted-foreground">Wires</div>
        {wires.length === 0 ? (
          <div className="text-[12px]">None</div>
        ) : (
          wires.map((wire) => (
            <div
              key={`${wire.pin}:${wire.other}`}
              className="truncate font-mono text-[12px]"
              title={formatPartWire(wire)}
            >
              {formatPartWire(wire)}
            </div>
          ))
        )}
      </div>
      {info?.ranger ? (
        <RangerFields reading={scrub.playhead !== null ? recorded : live} />
      ) : info && info.signalPin === null ? null : (
        <>
          <Field
            label="Pulse"
            value={pulseText(
              scrub.playhead !== null
                ? (recorded?.pulseUs ?? null)
                : (live?.pulseUs ?? null)
            )}
          />
          <Field
            label="Command"
            value={commandText(
              scrub.playhead !== null
                ? (recorded?.commandDeg ?? null)
                : (live?.commandDeg ?? null)
            )}
          />
          <Field
            label="State"
            value={motionText(
              scrub.playhead !== null ? recorded?.worst : live?.state
            )}
          />
          <Field
            label="V+"
            value={
              scrub.playhead !== null
                ? recorded
                  ? voltsText(recorded.voltage)
                  : "—"
                : live?.voltage === undefined
                  ? "—"
                  : voltsText(live.voltage)
            }
          />
          <Field
            label="Current"
            value={
              scrub.playhead !== null
                ? recorded
                  ? ampsText(recorded.maxCurrent)
                  : "—"
                : live?.current === undefined
                  ? "—"
                  : ampsText(live.current)
            }
          />
        </>
      )}
      {drives ? (
        <>
          <Field label="Joint" value={`${drives.robot}/${drives.joint}`} />
          <Field label="Angle" value={angle} />
        </>
      ) : null}
    </>
  );
}

function RangerFields({
  reading,
}: {
  reading:
    | {
        distanceM?: number | null;
        echoS?: number | null;
        hit?: boolean;
        voltage?: number;
        current?: number;
      }
    | undefined;
}) {
  const distance =
    reading?.distanceM === null || reading?.distanceM === undefined
      ? "no echo"
      : `${(reading.distanceM * 100).toFixed(2)} cm`;
  const echo =
    reading?.echoS === null || reading?.echoS === undefined
      ? "—"
      : `${Math.round(reading.echoS * 1e6)} µs`;
  return (
    <>
      <Field label="Distance" value={reading ? distance : "—"} />
      <Field label="Echo" value={reading ? echo : "—"} />
      <Field
        label="Return"
        value={reading ? (reading.hit ? "echo" : "no echo") : "—"}
      />
      <Field
        label="VCC"
        value={
          reading?.voltage === undefined ? "—" : voltsText(reading.voltage)
        }
      />
      <Field
        label="Current"
        value={reading?.current === undefined ? "—" : ampsText(reading.current)}
      />
    </>
  );
}
