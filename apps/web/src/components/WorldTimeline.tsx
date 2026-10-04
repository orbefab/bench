import {
  ROOT_PATH,
  type TimelineMarker,
  type TimelineTrack,
} from "@sfab-bench/contract";
import { Pause, Play, X } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useEffect } from "react";

import { CaptureBar } from "@/components/CaptureBar";
import { Button } from "@/components/ui/button";
import { sendWorldCommand } from "@/hooks/useWorldRun";
import {
  isMacPlatform,
  matchesShortcut,
  shortcutTooltip,
} from "@/lib/shortcuts";
import {
  minSpan,
  seriesRange,
  seriesValues,
  sparkline,
  timelineTrackLabel,
  tracksForSelection,
} from "@/lib/timeline";
import { formatSimTime } from "@/lib/world-issues";
import {
  formatProbeValue,
  type ProbeRow,
  probeLabel,
  probeRows,
  trackLabel as probeTrackLabel,
  rowNote,
  valueAt,
} from "@/lib/world-probe";
import { useWorld } from "@/state/world";
import { toggleProbePort, useProbes } from "@/state/world-probe";
import { goLive, scrubTo, useWorldTimeline } from "@/state/world-timeline";

/**
 * Desktop scrub strip. Dragging moves this client's playhead only.
 * The shared run keeps its own sim time (D-015). Hidden in XR (D-008).
 */
export function WorldTimeline({ docked = false }: { docked?: boolean }) {
  const { recording, data, playhead, previous } = useWorldTimeline();
  const probes = useProbes();
  const selection = useWorld((s) => s.selection);
  const playing = useWorld((s) => s.playing);
  const connection = useWorld((s) => s.connection);
  const blocked = useWorld((s) => s.runErrors.length > 0);
  const outline = useWorld((s) => s.outline);
  const tree = useWorld((s) => s.tree);
  const root = tree?.nodes.find((node) => node.id === ROOT_PATH);
  const rootName =
    root && root.name !== "root" && root.name !== ROOT_PATH ? root.name : null;
  const mac = isMacPlatform(
    typeof navigator === "undefined" ? "" : navigator.platform,
    typeof navigator === "undefined" ? "" : navigator.userAgent
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (
        !matchesShortcut(event, "timeline-live", {
          mac,
          activeElement: document.activeElement,
        })
      ) {
        return;
      }
      event.preventDefault();
      goLive();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mac]);

  const canPlay = connection === "live" && !blocked;
  const playButton = (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      className="h-9 shrink-0 self-center px-2.5"
      disabled={!canPlay}
      aria-label={playing ? "Pause" : "Play"}
      onClick={() => sendWorldCommand(playing ? "pause" : "play")}
    >
      {playing ? <Pause /> : <Play />}
      {playing ? "Pause" : "Play"}
    </Button>
  );
  const shell = docked
    ? "flex shrink-0 flex-col gap-1 border-t border-border bg-card px-2 py-1.5"
    : "pointer-events-auto absolute inset-x-3 bottom-3 z-20 flex flex-col gap-1 rounded-xl border border-border bg-card/95 p-1.5 shadow-lg";
  const rowClass = docked
    ? "flex items-center gap-2"
    : "flex items-stretch gap-2";

  if (!recording) {
    return (
      <div className={shell}>
        <CaptureBar />
        <div className={rowClass}>
          {playButton}
          <span className="text-xs tabular-nums text-muted-foreground">
            {formatSimTime(0)}
          </span>
        </div>
      </div>
    );
  }
  const from = recording.from;
  const to = Math.max(recording.to, from);
  const chosen = tracksForSelection(data?.tracks ?? [], selection, outline);
  const primaryField = chosen.primary?.unit === "V" ? "lo" : "v";
  const sharedUnit =
    chosen.primary !== null &&
    chosen.secondary !== null &&
    chosen.primary.unit === chosen.secondary.unit;
  const primaryRange = chosen.primary
    ? seriesRange(
        [
          seriesValues(chosen.primary, primaryField),
          ...(sharedUnit && chosen.secondary
            ? [seriesValues(chosen.secondary, "v")]
            : []),
        ],
        minSpan(chosen.primary.unit)
      )
    : null;
  const secondaryRange =
    chosen.secondary === null
      ? null
      : sharedUnit
        ? primaryRange
        : seriesRange(
            [seriesValues(chosen.secondary, "v")],
            minSpan(chosen.secondary.unit)
          );
  const head = playhead ?? to;
  const span = Math.max(to - from, 1e-9);
  const headX = playheadX(head, from, to);
  const markers = (data?.markers ?? []).filter(
    (marker) => marker.kind !== "serial"
  );
  const live = playhead === null;
  const rows = probeRows(probes, data);

  return (
    <div className={shell}>
      <CaptureBar />
      {rows.length > 0 ? (
        <div className="flex max-h-36 flex-col gap-0.5 overflow-y-auto">
          {rows.map((item) => (
            <ProbeRowView
              key={item.probe}
              row={item}
              from={from}
              to={to}
              head={head}
              live={live}
              previous={previous}
              rootName={rootName}
            />
          ))}
        </div>
      ) : null}
      <div className={rowClass}>
        {playButton}
        <div
          className="relative min-w-0 flex-1 cursor-ew-resize touch-none"
          role="slider"
          aria-label="Timeline"
          aria-valuemin={Math.round(from * 1000)}
          aria-valuemax={Math.round(to * 1000)}
          aria-valuenow={Math.round(head * 1000)}
          aria-valuetext={formatSimTime(head)}
          tabIndex={0}
          {...scrubHandlers(from, to)}
        >
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="h-9 w-full"
            aria-hidden="true"
          >
            {chosen.primary && primaryRange ? (
              <Spark
                track={chosen.primary}
                from={from}
                to={to}
                field={primaryField}
                range={primaryRange}
                className="stroke-foreground"
              />
            ) : null}
            {chosen.secondary && secondaryRange ? (
              <Spark
                track={chosen.secondary}
                from={from}
                to={to}
                field="v"
                range={secondaryRange}
                className="stroke-muted-foreground"
              />
            ) : null}
            {markers.map((marker) => (
              <Marker
                key={`${marker.kind}:${marker.board ?? ""}:${marker.t}`}
                marker={marker}
                from={from}
                span={span}
              />
            ))}
            <Playhead x={headX} live={live} />
          </svg>
          <div className="flex justify-between px-0.5 text-[10px] tabular-nums text-muted-foreground">
            <span>{formatSimTime(from)}</span>
            <span className="truncate px-2">
              {trackLabel(chosen.primary, rootName)}
              {chosen.secondary
                ? ` · ${trackLabel(chosen.secondary, rootName)}`
                : ""}
            </span>
            <span>{formatSimTime(to)}</span>
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          variant={live ? "secondary" : "default"}
          className="h-9 shrink-0 self-center px-2.5"
          aria-pressed={live}
          title={
            previous
              ? "Previous run"
              : shortcutTooltip("Return to live", "timeline-live", mac)
          }
          disabled={previous}
          onClick={() => goLive()}
        >
          {previous ? "Previous run" : "Live"}
        </Button>
      </div>
    </div>
  );
}

function playheadX(head: number, from: number, to: number): number {
  return ((head - from) / Math.max(to - from, 1e-9)) * 100;
}

function Playhead({ x, live }: { x: number; live: boolean }) {
  return (
    <line
      x1={x}
      x2={x}
      y1="0"
      y2="100"
      className={live ? "stroke-foreground/40" : "stroke-brand"}
      strokeWidth="0.6"
      vectorEffect="non-scaling-stroke"
    />
  );
}

function scrubHandlers(from: number, to: number) {
  return {
    onPointerDown: (event: ReactPointerEvent<Element>) => {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      scrubTo(timeFromPointer(event, from, to));
    },
    onPointerMove: (event: ReactPointerEvent<Element>) => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
      scrubTo(timeFromPointer(event, from, to));
    },
  };
}

function ProbeRowView({
  row,
  from,
  to,
  head,
  live,
  previous,
  rootName,
}: {
  row: ProbeRow;
  from: number;
  to: number;
  head: number;
  live: boolean;
  previous: boolean;
  rootName: string | null;
}) {
  const note = rowNote(row, previous);
  const headX = playheadX(head, from, to);
  const remove = (
    <button
      type="button"
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
      title={`Stop probing ${probeLabel(row.probe, rootName)}`}
      aria-label={`Stop probing ${probeLabel(row.probe, rootName)}`}
      onClick={() => toggleProbePort(row.probe)}
    >
      <X className="h-3 w-3" />
    </button>
  );
  if (note) {
    return (
      <div className="flex items-center gap-2 text-[11px]">
        <span className="w-44 shrink-0 truncate">
          {probeLabel(row.probe, rootName)}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {note}
        </span>
        {remove}
      </div>
    );
  }
  return (
    <>
      {row.tracks.map((track) => {
        // A solved pin draws its frame's lowest and highest step around
        // the mean: a PWM node's ripple band.
        const band = track.lo !== undefined && track.hi !== undefined;
        const range = seriesRange(
          band ? [track.v, track.lo ?? [], track.hi ?? []] : [track.v],
          minSpan(track.unit)
        );
        return (
          <div key={track.id} className="flex items-center gap-2 text-[11px]">
            <span className="w-44 shrink-0 truncate">
              {probeTrackLabel(track, rootName)}
            </span>
            <svg
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              className="h-6 min-w-0 flex-1 cursor-ew-resize touch-none"
              role="img"
              aria-label={probeTrackLabel(track, rootName)}
              {...scrubHandlers(from, to)}
            >
              {range && band ? (
                <>
                  <Spark
                    track={track}
                    from={from}
                    to={to}
                    field="lo"
                    range={range}
                    className="stroke-sky-500/40"
                  />
                  <Spark
                    track={track}
                    from={from}
                    to={to}
                    field="hi"
                    range={range}
                    className="stroke-sky-500/40"
                  />
                </>
              ) : null}
              {range ? (
                <Spark
                  track={track}
                  from={from}
                  to={to}
                  field="v"
                  range={range}
                  className="stroke-sky-500"
                />
              ) : null}
              <Playhead x={headX} live={live} />
            </svg>
            <span className="w-20 shrink-0 text-right tabular-nums">
              {formatProbeValue(valueAt(track, head), track.unit)}
            </span>
            {remove}
          </div>
        );
      })}
    </>
  );
}

function Spark({
  track,
  from,
  to,
  field,
  range,
  className,
}: {
  track: TimelineTrack;
  from: number;
  to: number;
  field: "v" | "lo" | "hi";
  range: { min: number; max: number };
  className: string;
}) {
  const d = sparkline(track, from, to, field, range);
  if (!d) return null;
  return (
    <path
      d={d}
      fill="none"
      className={className}
      strokeWidth="1.25"
      vectorEffect="non-scaling-stroke"
    />
  );
}

function Marker({
  marker,
  from,
  span,
}: {
  marker: TimelineMarker;
  from: number;
  span: number;
}) {
  const x = ((marker.t - from) / span) * 100;
  const fault = marker.kind === "fault" || marker.kind === "reset";
  return (
    <line
      x1={x}
      x2={x}
      y1="8"
      y2="92"
      className={fault ? "stroke-destructive" : "stroke-muted-foreground"}
      strokeWidth="0.8"
      vectorEffect="non-scaling-stroke"
    >
      <title>
        {marker.kind}
        {marker.board ? ` ${marker.board}` : ""} {marker.t.toFixed(3)} s
      </title>
    </line>
  );
}

function trackLabel(
  track: TimelineTrack | null,
  rootName: string | null
): string {
  if (!track) return "";
  return timelineTrackLabel(track.id, track.unit, rootName);
}

function timeFromPointer(
  event: { clientX: number; currentTarget: Element },
  from: number,
  to: number
): number {
  const rect = event.currentTarget.getBoundingClientRect();
  const x = event.clientX - rect.left;
  if (!(rect.width > 0) || !(to > from)) return from;
  const u = Math.min(1, Math.max(0, x / rect.width));
  return from + u * (to - from);
}
