/** The board card: pins, LEDs, serial console and firmware source for one live board. */

import {
  ARDUINO_PINS,
  maskHasPin,
  type WorldPinState,
} from "@sfab-bench/contract";
import { SerialConsole } from "@/components/SerialConsole";
import { SourceView } from "@/components/SourceView";
import { sendBoardSerial } from "@/hooks/useWorldRun";
import { ampsText } from "@/lib/amps-text";
import {
  boardStatusLabel,
  boardWarningLine,
  recordedSoaLine,
  scrubbedBoardStatus,
} from "@/lib/board-status";
import { faultUntil, resetsUntil, serialUntil } from "@/lib/timeline";
import { relFromWorldFile } from "@/lib/world-assets";
import type { WorldOutlineBoard, WorldOutlinePart } from "@/lib/world-outline";
import {
  type BoardConsoleEntry,
  clearBoardReject,
  useBoardConsole,
} from "@/state/board-console";
import { useWorld } from "@/state/world";
import { useWorldTimeline } from "@/state/world-timeline";
import { Field, SoaLine, voltsText } from "./parts";

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

export function BoardBody({
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
