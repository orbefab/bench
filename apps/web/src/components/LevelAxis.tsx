import type { WorldViewNode } from "@sfab-bench/contract";
import { useEffect, useMemo } from "react";

import { Button } from "@/components/ui/button";
import { levelCard } from "@/lib/level-card";
import {
  captureDisabledReason,
  captureEditTarget,
  captureFailure,
  levelDeletable,
  levelSourceWords,
} from "@/lib/world-capture";
import type { CardAxis, CardOption } from "@/lib/world-card";
import { type LevelOption, removeCaptureOp, setLevelOp } from "@/lib/world-ops";
import { useWorld, worldStore } from "@/state/world";
import {
  settleWorldCapture,
  startWorldCapture,
  useCapture,
} from "@/state/world-capture";
import { commitEdit } from "@/state/world-edit";

function optionValue(option: Pick<CardOption, "class" | "variant">): string {
  return `${option.class}:${option.variant}`;
}

function optionText(option: CardOption): string {
  const source = levelSourceWords(option.source);
  return [
    `${option.class} ${option.variant}${option.chosen ? " · current" : ""}`,
    option.label,
    source?.word,
    option.stale ? "stale" : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

function optionTitle(option: CardOption): string {
  return [
    option.reason,
    levelSourceWords(option.source)?.title,
    option.stale ? `Stale: ${option.stale}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

function commitLevel(
  path: string,
  axis: CardAxis["axis"],
  option: LevelOption
) {
  const op = setLevelOp(worldStore.getState().path, path, axis, option);
  if (op) commitEdit([op]);
}

/** The server asks first when a parent's level rule selects this capture. */
function deleteCapture(
  node: WorldViewNode,
  axis: CardAxis["axis"],
  option: CardOption
) {
  const target = captureEditTarget(node, worldStore.getState().path);
  commitEdit([removeCaptureOp(target, axis, option)], {
    ...(target.session ? { part: target.session } : {}),
  });
}

/** One axis of the card: the picker, each level's source, and Capture. */
export function LevelAxis({
  node,
  axis,
}: {
  node: WorldViewNode;
  axis: CardAxis;
}) {
  const report = useWorld((s) => s.report);
  const capture = useCapture((s) => s);
  // A failure or a landing belongs to the selection it was started on.
  useEffect(() => settleWorldCapture(), [node.id]);
  const card = useMemo(() => levelCard(report, node.id), [report, node.id]);
  const line = card?.axes.find((row) => row.axis === axis.axis);
  const snapshot = axis.axis === "behaviour" ? card?.snapshot : null;
  const current = axis.options.find((option) => option.chosen);
  const captureAxis = axis.axis === "visual" ? undefined : axis.capture;
  const reason = captureAxis ? captureDisabledReason(capture, axis) : null;
  const failure =
    capture.phase === "failed" && capture.axis === axis.axis
      ? captureFailure(capture, node.id)
      : null;
  const captures = axis.options.filter((option) =>
    levelDeletable(node.source, option)
  );
  return (
    <>
      <select
        className="w-full rounded-md border border-border bg-background px-2 py-1 text-[12px]"
        value={current ? optionValue(current) : ""}
        onChange={(event) => {
          const option = axis.options.find(
            (item) => optionValue(item) === event.target.value
          );
          if (option) commitLevel(node.id, axis.axis, option);
        }}
      >
        {axis.options.map((option) => (
          <option
            key={optionValue(option)}
            value={optionValue(option)}
            disabled={option.gray}
            title={optionTitle(option)}
          >
            {optionText(option)}
          </option>
        ))}
      </select>
      {line?.reason ? (
        <p className="mt-1 text-[11px] text-muted-foreground">{line.reason}</p>
      ) : null}
      {captures.length > 0 ? (
        <ul className="mt-1.5 space-y-1">
          {captures.map((option) => {
            const source = levelSourceWords(option.source);
            return (
              <li
                key={optionValue(option)}
                className="flex items-center gap-2 text-[11px]"
              >
                <span className="min-w-0 flex-1 truncate font-mono">
                  {option.variant}
                </span>
                {source ? (
                  <span className="text-muted-foreground" title={source.title}>
                    {source.word}
                  </span>
                ) : null}
                {option.stale ? (
                  <span
                    className="text-amber-800 dark:text-amber-400"
                    title={option.stale}
                  >
                    stale
                  </span>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-[11px] text-muted-foreground"
                  aria-label={`Delete ${axis.axis} ${option.variant}`}
                  onClick={() => deleteCapture(node, axis.axis, option)}
                >
                  Delete
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {captureAxis ? (
        <div className="mt-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={reason !== null}
            title={reason ?? `Capture ${axis.axis} of ${node.name}`}
            onClick={() =>
              startWorldCapture(
                node.id,
                axis.axis === "body" ? "body" : "behaviour"
              )
            }
          >
            Capture
          </Button>
          {reason ? (
            <p className="mt-1 text-[11px] text-muted-foreground">{reason}</p>
          ) : null}
        </div>
      ) : null}
      {failure ? (
        <p className="mt-1.5 break-words text-[12px] text-error">{failure}</p>
      ) : null}
      {snapshot ? (
        <details className="mt-1.5 text-[11px] text-muted-foreground">
          <summary className="cursor-pointer">
            Snapshot {snapshot.ref} · {snapshot.quality}
          </summary>
          {snapshot.provenance ? <p>{snapshot.provenance}</p> : null}
          {snapshot.errors.map((error) => (
            <p key={error}>{error}</p>
          ))}
        </details>
      ) : null}
    </>
  );
}
