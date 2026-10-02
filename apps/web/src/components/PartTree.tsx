import {
  ChevronDown,
  ChevronRight,
  ListTree,
  PanelLeftClose,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Object3D } from "three";
import { useShallow } from "zustand/react/shallow";

import type { CadPart, CadReview } from "@/cad/review";
import { CrashCard } from "@/components/CrashCard";
import { RenderErrorBoundary } from "@/components/RenderErrorBoundary";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { overlayMaxHeight } from "@/lib/layout";
import {
  disambiguateSiblingNames,
  partDisplayName,
  partLabelFileStem,
} from "@/lib/part-label";
import {
  filterPartTree,
  type PartTreeItem,
  siblingRows,
} from "@/lib/part-tree";
import { cn } from "@/lib/utils";
import { useScene } from "@/state/scene";
import { useViewer } from "@/state/viewer";

type TreeRow = PartTreeItem & { obj: Object3D; part: CadPart };

function partKey(part: CadPart): string {
  return part.cadRef ?? `id:${part.id}`;
}

function rowsFromObjs(
  parent: Object3D | null,
  review: CadReview,
  fileStem: string | undefined
): TreeRow[] {
  const mapped: TreeRow[] = [];
  for (const obj of siblingRows(review, parent)) {
    const part = review.partByObject.get(obj);
    if (!part) continue;
    mapped.push({
      key: partKey(part),
      rawName: part.name,
      displayName: partDisplayName(part, part.cadRef, fileStem),
      children: rowsFromObjs(obj, review, fileStem),
      obj,
      part,
    });
  }
  const labels = disambiguateSiblingNames(
    mapped.map((row) => ({
      key: row.key,
      display: row.displayName,
      ref: row.part.cadRef,
    }))
  );
  return mapped.map((row) => ({
    ...row,
    displayName: labels.get(row.key) ?? row.displayName,
  }));
}

function Node({
  row,
  openKeys,
  onToggle,
}: {
  row: TreeRow;
  openKeys: Set<string>;
  onToggle: (key: string) => void;
}) {
  const { selectedId, select, isolate, setVisible, hiddenIds } = useViewer(
    useShallow((s) => ({
      selectedId: s.selectedId,
      select: s.select,
      isolate: s.isolate,
      setVisible: s.setVisible,
      hiddenIds: s.hiddenIds,
    }))
  );
  const fit = useScene((s) => s.fit);
  const kids = row.children as TreeRow[];
  const part = row.part;
  const selected = selectedId === part.id;
  const open = openKeys.has(row.key);
  return (
    <div>
      <div
        className={cn(
          "flex cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-[13px]",
          selected
            ? "bg-accent font-medium text-accent-foreground"
            : "text-foreground hover:bg-accent/60"
        )}
        onClick={() => select(part.id)}
        onDoubleClick={() => {
          isolate(part.id);
          fit?.(part.object);
        }}
      >
        {kids.length ? (
          <button
            type="button"
            className="grid h-5 w-5 shrink-0 place-items-center text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            aria-label={
              open ? `Collapse ${row.displayName}` : `Expand ${row.displayName}`
            }
            aria-expanded={open}
            onClick={(ev) => {
              ev.stopPropagation();
              onToggle(row.key);
            }}
          >
            {open ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
          </button>
        ) : (
          <span className="inline-block h-5 w-5 shrink-0" aria-hidden />
        )}
        <input
          type="checkbox"
          className="size-3.5 accent-foreground"
          checked={!hiddenIds.has(part.id)}
          aria-label={
            hiddenIds.has(part.id)
              ? `Show ${row.displayName}`
              : `Hide ${row.displayName}`
          }
          onClick={(ev) => ev.stopPropagation()}
          onChange={(ev) => setVisible(part.id, ev.target.checked)}
        />
        <span
          className="size-2.5 shrink-0 rounded-[2px] border border-border"
          style={{ background: part.color }}
        />
        <span className="min-w-0 flex-1 truncate" title={part.name}>
          {row.displayName}
        </span>
      </div>
      {open && kids.length > 0 && (
        <div className="ml-3 border-l border-border pl-1">
          {kids.map((child) => (
            <Node
              key={child.key}
              row={child}
              openKeys={openKeys}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ModelTreeBody() {
  const { review, title, selectedId } = useViewer(
    useShallow((s) => ({
      review: s.review,
      title: s.title,
      selectedId: s.selectedId,
    }))
  );
  const [filter, setFilter] = useState("");
  const [openKeys, setOpenKeys] = useState<Set<string>>(() => new Set());
  const openKeysRef = useRef(openKeys);
  openKeysRef.current = openKeys;
  const savedOpenKeys = useRef<Set<string> | null>(null);

  const fileStem = useMemo(
    () => partLabelFileStem(review?.parts.length ?? 0, title),
    [review, title]
  );

  const forest = useMemo(
    () => (review ? rowsFromObjs(null, review, fileStem) : []),
    [review, fileStem]
  );
  const q = filter.trim();
  const filtered = useMemo(() => filterPartTree(forest, q), [forest, q]);
  const shown = q ? filtered.nodes : forest;
  const expandKey = filtered.expandKeys.join("\0");

  useEffect(() => {
    if (q) {
      if (savedOpenKeys.current === null)
        savedOpenKeys.current = new Set(openKeysRef.current);
      setOpenKeys((prev) => {
        const next = new Set(prev);
        for (const key of expandKey ? expandKey.split("\0") : []) next.add(key);
        return next;
      });
      return;
    }
    if (savedOpenKeys.current) {
      setOpenKeys(savedOpenKeys.current);
      savedOpenKeys.current = null;
    }
  }, [q, expandKey]);

  useEffect(() => {
    if (!review || selectedId === null) return;
    const selected = review.parts[selectedId]?.object;
    if (!selected) return;
    const keys: string[] = [];
    let cur: Object3D | null = selected.parent;
    while (cur) {
      const part = review.partByObject.get(cur);
      if (part) keys.push(partKey(part));
      cur = cur.parent;
    }
    if (!keys.length) return;
    setOpenKeys((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const key of keys) {
        if (!next.has(key)) {
          next.add(key);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [review, selectedId]);

  if (!review) return null;

  const toggle = (key: string) => {
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <>
      <div className="flex items-center gap-2 px-3 pt-2">
        <Input
          className="h-7 flex-1 text-[13px]"
          placeholder="Filter parts…"
          aria-label="Filter parts"
          value={filter}
          onChange={(ev) => setFilter(ev.target.value)}
        />
        <button
          type="button"
          className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() => setOpenKeys(new Set())}
        >
          Collapse
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
        {q && shown.length === 0 ? (
          <p className="px-1 py-1 text-xs text-muted-foreground">
            No parts match.{" "}
            <button
              type="button"
              className="font-medium text-foreground hover:underline"
              onClick={() => setFilter("")}
            >
              Clear
            </button>
          </p>
        ) : (
          (shown as TreeRow[]).map((row) => (
            <Node
              key={row.key}
              row={row}
              openKeys={openKeys}
              onToggle={toggle}
            />
          ))
        )}
      </div>
    </>
  );
}

export function PartTree({
  canvasHeight,
  expanded,
  onExpand,
  onCollapse,
  cardRef,
}: {
  canvasHeight: number;
  expanded: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  cardRef?: (el: HTMLElement | null) => void;
}) {
  const url = useViewer((s) => s.url);
  return (
    <RenderErrorBoundary
      resetKeys={[url]}
      fallback={({ error, reset }) => (
        <div
          ref={cardRef}
          className="pointer-events-auto absolute top-16 left-3 z-10"
        >
          <CrashCard error={error} onRetry={reset} />
        </div>
      )}
    >
      <PartTreeBody
        canvasHeight={canvasHeight}
        expanded={expanded}
        onCollapse={onCollapse}
        onExpand={onExpand}
        cardRef={cardRef}
      />
    </RenderErrorBoundary>
  );
}

function PartTreeBody({
  canvasHeight,
  expanded,
  onExpand,
  onCollapse,
  cardRef,
}: {
  canvasHeight: number;
  expanded: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  cardRef?: (el: HTMLElement | null) => void;
}) {
  const { review, title, url } = useViewer(
    useShallow((s) => ({
      review: s.review,
      title: s.title,
      url: s.url,
    }))
  );
  if (!review) return null;
  if (!expanded) {
    return (
      <Button
        ref={(el) => cardRef?.(el)}
        type="button"
        variant="secondary"
        size="sm"
        className="pointer-events-auto absolute top-16 left-3 z-10 h-9 gap-2 shadow-lg"
        title="Show model tree"
        aria-label="Show model tree"
        onClick={onExpand}
      >
        <ListTree className="size-4" />
        Model
      </Button>
    );
  }
  return (
    <aside
      ref={cardRef}
      className="pointer-events-auto absolute top-16 left-3 z-10 flex w-[280px] flex-col overflow-hidden rounded-xl border border-border/80 bg-card/95 shadow-lg backdrop-blur-sm"
      style={{ maxHeight: overlayMaxHeight(canvasHeight) }}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <ListTree className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-foreground">Model</div>
          <div className="truncate text-[11px] text-muted-foreground">
            {title}
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          title="Hide model tree"
          aria-label="Hide model tree"
          onClick={onCollapse}
        >
          <PanelLeftClose />
        </Button>
      </header>
      <ModelTreeBody key={url} />
    </aside>
  );
}
