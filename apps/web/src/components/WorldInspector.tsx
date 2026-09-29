import {
  ARDUINO_PINS,
  DEFAULT_TIMESTEP_S,
  maskHasPin,
  type WorldPinState,
  type WorldViewNode,
  type WorldViewPlay,
} from "@sfab-bench/contract";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";

import { SerialConsole } from "@/components/SerialConsole";
import { SourceView } from "@/components/SourceView";
import { Button } from "@/components/ui/button";
import { openPartFile } from "@/components/WorldPartTabs";
import { sendBoardSerial } from "@/hooks/useWorldRun";
import { ampsText } from "@/lib/amps-text";
import {
  boardStatusLabel,
  boardWarningLine,
  recordedSoaLine,
  scrubbedBoardStatus,
} from "@/lib/board-status";
import {
  activeEscLayer,
  compactChatSheetOpen,
  isEditableTarget,
  probeEscLayers,
} from "@/lib/shortcuts";
import { faultUntil, resetsUntil, serialUntil } from "@/lib/timeline";
import { relFromWorldFile } from "@/lib/world-assets";
import { instanceCard } from "@/lib/world-card";
import { instanceEditTarget } from "@/lib/world-edit-target";
import { formatSimTime } from "@/lib/world-issues";
import { moveTarget, poseCommit } from "@/lib/world-move";
import { openPartTarget } from "@/lib/world-open-part";
import {
  type LevelOption,
  type PlayChange,
  renamePartOp,
  setLevelOp,
  setParamOp,
  setPlayOp,
} from "@/lib/world-ops";
import {
  formatJointReadout,
  formatLiveDegrees,
  formatPartWire,
  type WorldOutline,
  type WorldOutlineBoard,
  type WorldOutlineJoint,
  type WorldOutlineLink,
  type WorldOutlinePart,
  type WorldOutlineSupply,
} from "@/lib/world-outline";
import {
  editPoseField,
  POSE_FIELD_KEYS,
  type PoseFieldKey,
  poseToFields,
} from "@/lib/world-pose-fields";
import {
  partFileName,
  RENAME_LIBRARY_REASON,
  renamePartTarget,
} from "@/lib/world-rename-part";
import { findViewNode } from "@/lib/world-tree";
import {
  documentWarnings,
  inspectorBodyClass,
  instanceWarnings,
  type PathWarning,
  warningsFromRun,
} from "@/lib/world-warnings";
import {
  type BoardConsoleEntry,
  clearBoardReject,
  useBoardConsole,
} from "@/state/board-console";
import { usePartTabs } from "@/state/part-tabs";
import { useWorld, worldStore } from "@/state/world";
import { commitEdit, useWorldEdit } from "@/state/world-edit";
import { useWorldTimeline } from "@/state/world-timeline";
import { commitToolEdit } from "@/state/world-tool";

function useWorldSelectionEsc() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (!worldStore.getState().selection) return;
      if (isEditableTarget(event.target, document.activeElement)) return;
      const layers = {
        ...probeEscLayers(document),
        compactChat: compactChatSheetOpen(document),
      };
      if (activeEscLayer(layers)) return;
      worldStore.getState().select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

const EMPTY_PARTS: readonly WorldOutlinePart[] = [];

function transcriptText(entries: readonly BoardConsoleEntry[]): string {
  let text = "";
  for (const entry of entries) {
    if (entry.kind === "out") {
      text += entry.text;
      continue;
    }
    const line = entry.text.endsWith("\n") ? entry.text : `${entry.text}\n`;
    text += `‹ sent by ${entry.by} › ${line}`;
  }
  return text;
}

function SoaLine({ text }: { text: string }) {
  if (!text) return null;
  return (
    <p className="mb-1.5 break-words font-mono text-[12px] text-amber-800 dark:text-amber-400">
      {text}
    </p>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="mb-1.5 min-w-0">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="truncate font-mono text-[12px]" title={value}>
        {value}
      </div>
    </div>
  );
}

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

function pulseOnPin(
  boardId: string,
  pin: string,
  parts: readonly WorldOutlinePart[],
  live: Record<string, { pulseUs: number | null }>
): number | null | undefined {
  const signal = `${boardId}.${pin}`;
  const hit = parts.find((part) => {
    if (!part.signalPin) return false;
    return part.wires.some(
      (wire) => wire.pin === part.signalPin && wire.other === signal
    );
  });
  if (!hit) return undefined;
  return live[hit.id]?.pulseUs ?? null;
}

function pulseText(us: number | null): string {
  if (us === null) return "No signal";
  return `${Math.round(us)} µs`;
}

function commandText(deg: number | null): string {
  if (deg === null) return "—";
  const shown = Math.round(deg * 10) / 10;
  return `${shown.toFixed(1)}°`;
}

function voltsText(voltage: number): string {
  return `${voltage.toFixed(2)} V`;
}

function socText(soc: number): string {
  return `${(soc * 100).toFixed(1)}%`;
}

function motionText(state: string | undefined): string {
  if (state === "idle" || state === "moving" || state === "stall") return state;
  return "—";
}

function PinTable({
  pins,
  boardId,
  parts,
  live,
}: {
  pins: WorldPinState | undefined;
  boardId: string;
  parts: readonly WorldOutlinePart[];
  live: Record<string, { pulseUs: number | null }>;
}) {
  if (!pins) {
    return (
      <p className="mb-3 text-[12px] text-muted-foreground">
        Pins appear with the next state.
      </p>
    );
  }
  return (
    <table className="mb-3 w-full border-collapse text-[11px]">
      <thead>
        <tr className="text-left text-muted-foreground">
          <th className="py-0.5 font-medium">Pin</th>
          <th className="font-medium">Dir</th>
          <th className="font-medium">Level</th>
          <th className="font-medium">
            <span className="sr-only">Activity</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {ARDUINO_PINS.map((pin) => {
          const active = maskHasPin(pins.toggled, pin);
          const pulse = pulseOnPin(boardId, pin, parts, live);
          const width =
            pulse === undefined || pulse === null
              ? null
              : `${Math.round(pulse)} µs`;
          return (
            <tr key={pin} className="font-mono">
              <td>{pin}</td>
              <td>{maskHasPin(pins.ddr, pin) ? "out" : "in"}</td>
              <td>{maskHasPin(pins.level, pin) ? "H" : "L"}</td>
              <td className="whitespace-nowrap">
                {active ? (
                  <span title="Toggled since the last state">●</span>
                ) : null}
                {width ? (
                  <span title="Servo pulse width">
                    {active ? " " : ""}
                    {width}
                  </span>
                ) : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

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

function PartBody({
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

function extraLeds(boardId: string, leds: Record<string, number> | undefined) {
  if (!leds) return null;
  const rows = Object.entries(leds).filter(
    ([path]) => path !== `${boardId}.led`
  );
  if (rows.length === 0) return null;
  return rows.map(([path, amps]) => (
    <Field key={path} label={path} value={ampsText(amps)} />
  ));
}

function BoardBody({
  id,
  info,
  pending,
}: {
  id: string;
  info: WorldOutlineBoard | undefined;
  pending: boolean;
}) {
  const path = useWorld((s) => s.path);
  const playing = useWorld((s) => s.playing);
  const live = useWorld((s) => s.boards[id]);
  const livePins = useWorld((s) => s.pins[id]);
  const liveParts = useWorld((s) => s.parts);
  const scrub = useWorldTimeline();
  const recorded =
    scrub.playhead !== null ? scrub.frame?.boards[id] : undefined;
  const ledCurrent =
    scrub.playhead !== null ? recorded?.ledCurrent : live?.ledCurrent;
  const markers = scrub.data?.markers ?? [];
  const pins = recorded?.pins ?? livePins;
  const pastFault =
    scrub.playhead !== null
      ? faultUntil(markers, id, scrub.playhead)
      : undefined;
  const statusBoard = recorded
    ? {
        running: recorded.running,
        brownout: recorded.brownout || recorded.brownoutAny,
        ...(pastFault ? { fault: pastFault } : {}),
        ...(live?.unpowered ? { unpowered: true } : {}),
      }
    : live;
  const serialText =
    scrub.playhead !== null ? serialUntil(markers, id, scrub.playhead) : null;
  const outlineParts = useWorld((s) => s.outline?.parts ?? EMPTY_PARTS);
  const consoleState = useBoardConsole();
  const sourceRel =
    path && info?.source ? relFromWorldFile(path, info.source) : undefined;
  const text =
    serialText ?? transcriptText(consoleState.boards[id]?.entries ?? []);
  const resets =
    scrub.playhead !== null
      ? String(resetsUntil(markers, id, scrub.playhead))
      : live?.resets === undefined
        ? "—"
        : String(live.resets);
  if (pending) {
    return (
      <p className="text-[12px] text-muted-foreground">Reading the world…</p>
    );
  }
  return (
    <>
      <Field label="Board" value={id} />
      <Field label="Chip" value={info?.chip ?? "—"} />
      <Field label="Firmware" value={info?.firmware ?? "—"} />
      <Field label="Source" value={info?.source ?? "None"} />
      <Field
        label="Status"
        value={
          (recorded
            ? scrubbedBoardStatus(statusBoard)
            : boardStatusLabel(statusBoard, playing)) || "—"
        }
      />
      <Field
        label="5V"
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
      {recorded ? (
        <Field label="Min" value={voltsText(recorded.minVoltage)} />
      ) : null}
      {ledCurrent === undefined ? null : (
        <Field label="D13 LED" value={ampsText(ledCurrent)} />
      )}
      {extraLeds(id, scrub.playhead !== null ? recorded?.leds : live?.leds)}
      <SoaLine
        text={
          recorded
            ? recordedSoaLine(
                recorded.belowSoa,
                recorded,
                info?.brownoutVoltage
              )
            : boardWarningLine(live?.warnings)
        }
      />
      <Field label="Resets" value={resets} />
      <div className="mb-3 flex h-36 flex-col overflow-hidden rounded-md border border-border">
        <SerialConsole
          title={id}
          text={text}
          fault={statusBoard?.fault}
          notice={consoleState.rejects[id]}
          onNoticeClear={() => clearBoardReject(id)}
          onSend={(line) => sendBoardSerial(id, line)}
        />
      </div>
      <PinTable
        pins={pins}
        boardId={id}
        parts={outlineParts}
        live={
          scrub.frame && scrub.playhead !== null
            ? Object.fromEntries(
                Object.entries(scrub.frame.parts).map(([partId, part]) => [
                  partId,
                  { pulseUs: part.pulseUs },
                ])
              )
            : liveParts
        }
      />
      <div className="text-[11px] text-muted-foreground">Source</div>
      <div className="mt-1 flex h-40 flex-col overflow-hidden rounded-md border border-border">
        {sourceRel ? (
          <SourceView path={sourceRel} />
        ) : (
          <p className="px-3 py-2 text-[12px] text-muted-foreground">
            This board has no source file.
          </p>
        )}
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-3">
      <div className="mb-1 text-[11px] text-muted-foreground">{title}</div>
      {children}
    </section>
  );
}

function WarningList({ rows }: { rows: readonly PathWarning[] }) {
  if (rows.length === 0) return null;
  return (
    <Section title="Warnings">
      {rows.map((row) => (
        <p
          key={`${row.code ?? ""}:${row.message}`}
          className="mb-1.5 min-w-0 break-words text-[12px]"
        >
          {row.message}
        </p>
      ))}
    </Section>
  );
}

function LiveBody({
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

const POSE_FIELD_LABELS: Record<PoseFieldKey, string> = {
  x: "x (mm)",
  y: "y (mm)",
  z: "z (mm)",
  rx: "rotate x (°)",
  ry: "rotate y (°)",
  rz: "rotate z (°)",
};

/** Position and rotation of an instance. Works in every tool mode. */
function PoseSection({ node }: { node: WorldViewNode }) {
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

function commitParam(
  node: WorldViewNode,
  name: string,
  raw: string,
  previous: number | string | boolean
) {
  const tree = worldStore.getState().tree;
  if (!tree) return;
  const target = instanceEditTarget(tree, node.id, worldStore.getState().path);
  if (!target) return;
  const op = setParamOp(target, name, raw, previous);
  if (op) commitEdit([op], { part: target.part });
}

function commitLevel(
  path: string,
  axis: WorldViewNode["levels"][number]["axis"],
  option: LevelOption
) {
  const op = setLevelOp(worldStore.getState().path, path, axis, option);
  if (op) commitEdit([op]);
}

function commitPlay(current: WorldViewPlay, next: PlayChange) {
  const op = setPlayOp(worldStore.getState().path, current, next);
  if (op) commitEdit([op]);
}

/**
 * Enter commits by leaving the field. Mark the key handled first: an
 * unhandled Enter that lands on the body after the blur is sent back
 * by Chrome on macOS, and in an unfocused window it repeats forever.
 */
function commitOnEnter(event: ReactKeyboardEvent<HTMLInputElement>) {
  if (event.key !== "Enter") return;
  event.preventDefault();
  event.currentTarget.blur();
}

function NumberField({
  label,
  value,
  onCommit,
  disabled,
  title,
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  disabled?: boolean;
  title?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  const stays = useWorldEdit((s) => s.stays);
  // Stay on the ask drops the typed value, even when the card's did not move.
  useEffect(() => setDraft(String(value)), [value, stays]);
  return (
    <label className="mb-1.5 block min-w-0" title={title}>
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <input
        className="mt-0.5 w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-[12px] disabled:opacity-50"
        disabled={disabled}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const next = Number(draft);
          if (!Number.isFinite(next)) {
            setDraft(String(value));
            return;
          }
          onCommit(next);
        }}
        onKeyDown={commitOnEnter}
      />
    </label>
  );
}

function PlayFields({ play }: { play: WorldViewPlay }) {
  return (
    <Section title="Play">
      <NumberField
        label="Gravity x"
        value={play.gravity[0]}
        onCommit={(value) =>
          commitPlay(play, {
            gravity: [value, play.gravity[1], play.gravity[2]],
          })
        }
      />
      <NumberField
        label="Gravity y"
        value={play.gravity[1]}
        onCommit={(value) =>
          commitPlay(play, {
            gravity: [play.gravity[0], value, play.gravity[2]],
          })
        }
      />
      <NumberField
        label="Gravity z"
        value={play.gravity[2]}
        onCommit={(value) =>
          commitPlay(play, {
            gravity: [play.gravity[0], play.gravity[1], value],
          })
        }
      />
      <NumberField
        label="Seed"
        value={play.seed}
        onCommit={(value) => commitPlay(play, { seed: value })}
      />
      <NumberField
        label="Time step"
        value={play.timestep ?? DEFAULT_TIMESTEP_S}
        onCommit={(value) => commitPlay(play, { timestep: value })}
      />
    </Section>
  );
}

function RenamePartFile({
  name,
  source,
  rootPart,
  nodePart,
}: {
  name: string;
  source?: WorldViewNode["source"];
  rootPart?: string;
  nodePart?: string;
}) {
  const world = useWorld((s) => s.path);
  const own = !nodePart || nodePart === rootPart;
  const document = own ? world : (nodePart ?? world);
  const part = own ? undefined : nodePart;
  const target = renamePartTarget({ source });
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);
  const commit = () => {
    setOpen(false);
    const op = renamePartOp(document, name, draft);
    if (op) commitEdit([op], { part });
  };
  return (
    <div className="mb-3">
      {open && target.enabled ? (
        <div className="flex flex-col gap-1.5">
          <input
            className="w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-[12px]"
            aria-label="Part file name"
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              commit();
            }}
          />
          <div className="flex gap-1.5">
            <Button
              type="button"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={commit}
            >
              Rename
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2 text-xs"
          disabled={!target.enabled}
          title={target.enabled ? "Rename this part file" : target.reason}
          onClick={() => {
            if (!target.enabled) return;
            setDraft(name);
            setOpen(true);
          }}
        >
          Rename part file
        </Button>
      )}
      {!target.enabled ? (
        <p className="mt-1 text-[11px] text-muted-foreground">
          {target.reason || RENAME_LIBRARY_REASON}
        </p>
      ) : null}
    </div>
  );
}

function OpenPart({ node }: { node: WorldViewNode }) {
  const target = openPartTarget(node);
  return (
    <div className="mb-3">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 px-2 text-xs"
        disabled={!target.enabled}
        title={target.enabled ? "Open this part" : target.reason}
        onClick={() => {
          if (!target.enabled) return;
          openPartFile(target.file, node.id, node.part);
        }}
      >
        Open part
      </Button>
      {!target.enabled ? (
        <p className="mt-1 text-[11px] text-muted-foreground">
          {target.reason}
        </p>
      ) : null}
    </div>
  );
}

function InstanceBody({
  node,
  link,
  outline,
  warnings,
  rootPart,
}: {
  node: WorldViewNode;
  link?: string;
  outline: WorldOutline | null;
  warnings: readonly PathWarning[];
  rootPart?: string;
}) {
  const card = instanceCard(node);
  const stays = useWorldEdit((s) => s.stays);
  return (
    <>
      <Section title="Ports">
        {card.ports.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">None</p>
        ) : (
          card.ports.map((port) => (
            <div
              key={port.name}
              className="flex items-baseline gap-2 text-[12px]"
            >
              <span className="font-mono">{port.name}</span>
              {port.fixed ? (
                <span className="text-[11px] text-muted-foreground">fixed</span>
              ) : null}
            </div>
          ))
        )}
      </Section>
      <LiveBody node={node} link={link} outline={outline} />
      <PoseSection node={node} />
      {card.params.length > 0 ? (
        <Section title="Params">
          {card.params.map((param) =>
            typeof param.value === "boolean" ? (
              <label
                key={param.name}
                className="mb-1.5 flex items-center gap-2 text-[12px]"
              >
                <input
                  type="checkbox"
                  checked={param.value}
                  onChange={(event) =>
                    commitParam(
                      node,
                      param.name,
                      event.target.checked ? "true" : "false",
                      param.value
                    )
                  }
                />
                <span className="font-mono">{param.name}</span>
              </label>
            ) : typeof param.value === "number" ? (
              <NumberField
                key={param.name}
                label={param.name}
                value={param.value}
                onCommit={(value) =>
                  commitParam(node, param.name, String(value), param.value)
                }
              />
            ) : (
              <label key={`${param.name}:${stays}`} className="mb-1.5 block">
                <span className="text-[11px] text-muted-foreground">
                  {param.name}
                </span>
                <input
                  className="mt-0.5 w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-[12px]"
                  defaultValue={param.value}
                  onKeyDown={commitOnEnter}
                  onBlur={(event) =>
                    commitParam(
                      node,
                      param.name,
                      event.target.value,
                      param.value
                    )
                  }
                />
              </label>
            )
          )}
        </Section>
      ) : null}
      {card.axes.map((axis) => (
        <Section key={axis.axis} title={axis.axis}>
          <select
            className="w-full rounded-md border border-border bg-background px-2 py-1 text-[12px]"
            value={
              axis.options.find((option) => option.chosen)
                ? `${axis.options.find((option) => option.chosen)?.class}:${axis.options.find((option) => option.chosen)?.variant}`
                : ""
            }
            onChange={(event) => {
              const option = axis.options.find(
                (item) => `${item.class}:${item.variant}` === event.target.value
              );
              if (!option) return;
              commitLevel(node.id, axis.axis, option);
            }}
          >
            {axis.options.map((option) => (
              <option
                key={`${option.class}:${option.variant}`}
                value={`${option.class}:${option.variant}`}
                disabled={option.gray}
                title={option.reason}
              >
                {option.class} {option.variant}
                {option.chosen ? " · current" : ""}
                {option.label ? ` · ${option.label}` : ""}
              </option>
            ))}
          </select>
        </Section>
      ))}
      <OpenPart node={node} />
      <RenamePartFile
        name={partFileName(node.part)}
        source={node.source}
        rootPart={rootPart}
        nodePart={node.part}
      />
      <WarningList rows={warnings} />
    </>
  );
}

function leafRoot(
  tree: { nodes: WorldViewNode[] } | null
): WorldViewNode | null {
  const node = tree?.nodes.length === 1 ? tree.nodes[0] : undefined;
  if (!node || node.children.length > 0) return null;
  if (node.role === "leaf" || node.role === "robot") return node;
  return null;
}

export function WorldInspector() {
  useWorldSelectionEsc();
  const tabs = usePartTabs();
  const selection = useWorld((s) => s.selection);
  const wire = useWorld((s) => s.wire);
  const tree = useWorld((s) => s.tree);
  const outline = useWorld((s) => s.outline);
  const report = useWorld((s) => s.report);
  const diagnostics = useWorld((s) => s.diagnostics);
  const editError = useWorld((s) => s.editError);
  const playhead = useWorldTimeline().playhead;
  const warnings = useMemo(
    () => warningsFromRun(report, diagnostics),
    [report, diagnostics]
  );
  const node =
    selection && tree ? findViewNode(tree.nodes, selection.path) : null;
  const wireNode = wire && tree ? findViewNode(tree.nodes, wire.owner) : null;
  const ends = wire ? wireNode?.wires?.[wire.index] : undefined;
  const title = wire ? "Wire" : node ? node.name : (tree?.part ?? "Part");
  const focused = tabs.model.tabs.find(
    (tab) => tab.file === tabs.model.focused
  );
  const openSource = focused?.readOnly
    ? ("library" as const)
    : ("project" as const);
  const lone = leafRoot(tree);
  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-l border-border bg-card">
      <header className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <span className="truncate text-[13px] font-medium">{title}</span>
        {selection || wire ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground"
            onClick={() => {
              worldStore.getState().select(null);
              worldStore.getState().selectWire(null);
            }}
          >
            Clear
          </Button>
        ) : null}
      </header>
      <div className={inspectorBodyClass}>
        {playhead !== null ? (
          <p className="mb-2 text-[11px] text-muted-foreground">
            Recorded at {formatSimTime(playhead)}
          </p>
        ) : null}
        {editError ? (
          <p className="mb-2 break-words text-[12px] text-error">{editError}</p>
        ) : null}
        {wire && ends ? (
          <>
            <Field label="From" value={ends.a} />
            <Field label="To" value={ends.b} />
          </>
        ) : node ? (
          <InstanceBody
            node={node}
            link={selection?.link}
            outline={outline}
            warnings={instanceWarnings(warnings, node.id)}
            rootPart={tree?.part}
          />
        ) : (
          <>
            {tree ? (
              <PlayFields play={tree.play} />
            ) : (
              <p className="text-[12px] text-muted-foreground">
                Reading the world…
              </p>
            )}
            {tree ? (
              <RenamePartFile
                name={partFileName(tree.part)}
                source={openSource}
                rootPart={tree.part}
              />
            ) : null}
            <WarningList
              rows={
                lone
                  ? [
                      ...documentWarnings(warnings),
                      ...instanceWarnings(warnings, lone.id),
                    ]
                  : documentWarnings(warnings)
              }
            />
          </>
        )}
      </div>
    </aside>
  );
}
