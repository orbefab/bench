import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { Button } from "@/components/ui/button";
import { overlayMaxHeight } from "@/lib/layout";
import { formatMm, measureDelta } from "@/lib/measure";
import {
  disambiguateSiblingNames,
  partDisplayName,
  partLabelFileStem,
} from "@/lib/part-label";
import { siblingRows } from "@/lib/part-tree";
import { useScene } from "@/state/scene";
import { useViewer } from "@/state/viewer";

function SelectionBody() {
  const {
    review,
    title,
    selectedId,
    pickedRef,
    select,
    isolate,
    setVisible,
    showAll,
    hiddenIds,
  } = useViewer(
    useShallow((s) => ({
      review: s.review,
      title: s.title,
      selectedId: s.selectedId,
      pickedRef: s.pickedRef,
      select: s.select,
      isolate: s.isolate,
      setVisible: s.setVisible,
      showAll: s.showAll,
      hiddenIds: s.hiddenIds,
    }))
  );
  const fit = useScene((s) => s.fit);
  const part = selectedId !== null ? review?.parts[selectedId] : undefined;
  const ref = pickedRef ?? part?.cadRef ?? null;
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle"
  );
  const copyTimer = useRef(0);

  useEffect(() => {
    setCopyState("idle");
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    return () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    };
  }, [ref]);

  const fileStem = partLabelFileStem(review?.parts.length ?? 0, title);
  const displayName = useMemo(() => {
    if (!part || !review) return "";
    const siblings = siblingRows(review, part.object.parent).flatMap((obj) => {
      const sibling = review.partByObject.get(obj);
      if (!sibling) return [];
      return [
        {
          key: sibling.cadRef ?? `id:${sibling.id}`,
          display: partDisplayName(sibling, sibling.cadRef, fileStem),
          ref: sibling.cadRef,
        },
      ];
    });
    if (!siblings.length) {
      return partDisplayName(part, part.cadRef, fileStem);
    }
    const labels = disambiguateSiblingNames(siblings);
    const key = part.cadRef ?? `id:${part.id}`;
    return labels.get(key) ?? partDisplayName(part, part.cadRef, fileStem);
  }, [part, review, fileStem]);

  if (!review || (!part && !pickedRef)) return null;
  const shown = part ? !hiddenIds.has(part.id) : true;

  const copyRef = () => {
    if (!ref) return;
    void navigator.clipboard.writeText(ref).then(
      () => {
        setCopyState("copied");
        if (copyTimer.current) window.clearTimeout(copyTimer.current);
        copyTimer.current = window.setTimeout(() => setCopyState("idle"), 1500);
      },
      () => {
        setCopyState("error");
        if (copyTimer.current) window.clearTimeout(copyTimer.current);
        copyTimer.current = window.setTimeout(() => setCopyState("idle"), 1500);
      }
    );
  };

  return (
    <>
      <header className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium">Selection</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-muted-foreground"
          onClick={() => select(null)}
        >
          Clear
        </Button>
      </header>
      {part ? (
        <div className="mb-2 flex min-w-0 items-center gap-2 text-[13px]">
          <span
            className="size-3 shrink-0 rounded-[2px] border border-border"
            style={{ background: part.color }}
          />
          <span className="min-w-0 truncate font-medium" title={part.name}>
            {displayName}
          </span>
        </div>
      ) : null}
      {ref ? (
        <div className="mb-3 flex min-w-0 items-center gap-2">
          <code
            className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1 text-[12px]"
            title={ref}
          >
            {ref}
          </code>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="shrink-0"
            onClick={copyRef}
          >
            {copyState === "copied"
              ? "Copied"
              : copyState === "error"
                ? "Couldn't copy"
                : "Copy"}
          </Button>
        </div>
      ) : null}
      {part ? (
        <div className="flex flex-wrap gap-1">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => setVisible(part.id, !shown)}
          >
            {shown ? "Hide" : "Show"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => {
              isolate(part.id);
              fit?.(part.object);
            }}
          >
            Isolate
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => showAll()}
          >
            Show all
          </Button>
        </div>
      ) : null}
    </>
  );
}

function MeasureBody() {
  const { measure, clearMeasure, setTool } = useViewer(
    useShallow((s) => ({
      measure: s.measure,
      clearMeasure: s.clearMeasure,
      setTool: s.setTool,
    }))
  );
  const a = measure.a;
  const b = measure.b;
  const delta = measureDelta(a, b);

  return (
    <>
      <header className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium">Measure</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-muted-foreground"
          onClick={() => setTool("select")}
        >
          Done
        </Button>
      </header>
      <p className="mb-2 text-[12px] text-muted-foreground">
        Click two places on the model.
      </p>
      <div className="mb-1 truncate font-mono text-[12px]" title={a?.cadRef}>
        1 {a?.cadRef ?? "—"}
      </div>
      <div className="mb-3 truncate font-mono text-[12px]" title={b?.cadRef}>
        2 {b?.cadRef ?? "—"}
      </div>
      {delta ? (
        <div className="mb-3">
          <div className="text-[16px] font-medium">{formatMm(delta.dist)}</div>
          <div className="mt-1 font-mono text-[11px] text-muted-foreground">
            ΔX {formatMm(delta.dx)}
            <br />
            ΔY {formatMm(delta.dy)}
            <br />
            ΔZ {formatMm(delta.dz)}
          </div>
        </div>
      ) : null}
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={() => clearMeasure()}
      >
        Clear
      </Button>
    </>
  );
}

export function DetailPanel({
  canvasHeight,
  compact,
  width,
  cardRef,
}: {
  canvasHeight: number;
  compact: boolean;
  width: number;
  cardRef?: (el: HTMLElement | null) => void;
}) {
  const { review, selectedId, pickedRef, tool } = useViewer(
    useShallow((s) => ({
      review: s.review,
      selectedId: s.selectedId,
      pickedRef: s.pickedRef,
      tool: s.tool,
    }))
  );
  const part = selectedId !== null ? review?.parts[selectedId] : undefined;
  if (!review) return null;
  if (tool !== "measure" && !part && !pickedRef) return null;
  if (width <= 0) return null;

  return (
    <aside
      ref={cardRef}
      className="pointer-events-auto absolute top-16 right-4 z-10 min-w-0 overflow-auto rounded-xl border border-border bg-card/95 p-3 shadow-lg"
      style={{
        width: compact ? width : 260,
        maxWidth: compact ? "calc(100% - 1.5rem)" : undefined,
        maxHeight: overlayMaxHeight(canvasHeight),
      }}
    >
      {tool === "measure" ? <MeasureBody /> : <SelectionBody />}
    </aside>
  );
}
