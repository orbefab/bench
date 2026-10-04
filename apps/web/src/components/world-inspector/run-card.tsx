/** The run card: what this part runs as, and how far to trust it. */
import type { WorldViewNode } from "@sfab-bench/contract";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { sendWorldGhost } from "@/hooks/useWorldRun";
import { type LevelSnapshot, levelCard } from "@/lib/level-card";
import { type GhostReadout, ghostOffer, ghostReadout } from "@/lib/world-ghost";
import { useWorld, worldLiveState } from "@/state/world";

function Tag({ text, tone }: { text: string; tone?: "warn" }) {
  return (
    <span
      className={
        tone === "warn"
          ? "shrink-0 rounded-sm bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-800 dark:text-amber-400"
          : "shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
      }
    >
      {text}
    </span>
  );
}

function Lines({ label, lines }: { label: string; lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      {lines.map((line) => (
        <div key={line} className="break-words font-mono text-[12px]">
          {line}
        </div>
      ))}
    </div>
  );
}

function SnapshotBlock({
  snapshot,
  nested,
}: {
  snapshot: LevelSnapshot;
  nested?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-baseline gap-2">
        <span
          className="min-w-0 flex-1 truncate font-mono text-[12px]"
          title={snapshot.provenance ?? snapshot.ref}
        >
          {nested ? `${snapshot.path} · ` : ""}
          {snapshot.ref}
        </span>
        <Tag text={snapshot.quality} />
        {snapshot.stale ? (
          <span title="The part changed since this snapshot was captured">
            <Tag text="stale" tone="warn" />
          </span>
        ) : null}
        {snapshot.unchecked ? (
          <span title={snapshot.unchecked}>
            <Tag text="unchecked" />
          </span>
        ) : null}
      </div>
      {snapshot.unchecked ? (
        <Lines label="Freshness not checked" lines={[snapshot.unchecked]} />
      ) : null}
      <Lines
        label="Stated error"
        lines={snapshot.errors.length ? snapshot.errors : ["none stated"]}
      />
      <Lines label="Valid range" lines={snapshot.range} />
      {snapshot.warnings.length > 0 ? (
        <div className="min-w-0">
          <div className="text-[11px] text-amber-800 dark:text-amber-400">
            Outside the valid range
          </div>
          {snapshot.warnings.map((line) => (
            <div
              key={line}
              className="break-words font-mono text-[12px] text-amber-800 dark:text-amber-400"
            >
              {line}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The live state is not React state: read the ghost a few times a second. */
function useGhostReadout(path: string): GhostReadout | null {
  const [readout, setReadout] = useState<GhostReadout | null>(null);
  useEffect(() => {
    let last = "";
    const read = () => {
      const next = ghostReadout(worldLiveState()?.ghost, path);
      const key = JSON.stringify(next);
      if (key === last) return;
      last = key;
      setReadout(next);
    };
    read();
    const timer = window.setInterval(read, 250);
    return () => window.clearInterval(timer);
  }, [path]);
  return readout;
}

function GhostBlock({ node }: { node: WorldViewNode }) {
  const offer = useMemo(() => ghostOffer(node), [node]);
  const readout = useGhostReadout(node.id);
  if (!offer && !readout) return null;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">
          {readout
            ? "Ghost: the same world with this part on its snapshot"
            : `Run ${offer?.ref ?? "the snapshot"} beside it, drawn as a ghost`}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 shrink-0 px-2 text-xs"
          onClick={() => {
            if (readout) sendWorldGhost(null);
            else if (offer) {
              sendWorldGhost({
                path: offer.path,
                class: offer.class,
                variant: offer.variant,
              });
            }
          }}
        >
          {readout ? "Hide ghost" : "Show ghost"}
        </Button>
      </div>
      {readout?.kind === "error" ? (
        <div className="break-words text-[12px] text-amber-800 dark:text-amber-400">
          {readout.text}
        </div>
      ) : null}
      {readout?.kind === "gap" ? (
        <Lines label={`Gap to ${readout.ref}`} lines={readout.lines} />
      ) : null}
    </div>
  );
}

export function RunCard({
  path,
  node,
}: {
  path: string;
  node?: WorldViewNode;
}) {
  const report = useWorld((s) => s.report);
  const card = useMemo(() => levelCard(report, path), [report, path]);
  if (!card) return null;
  const behaviour = card.axes.find((row) => row.axis === "behaviour");
  const kind = card.snapshot
    ? "snapshot"
    : card.nested.length > 0
      ? "detailed, with snapshots inside"
      : "detailed";
  return (
    <Card className="mb-3" aria-label="Run card">
      <CardHeader>
        <CardTitle>Runs as</CardTitle>
        <Tag text={kind} />
      </CardHeader>
      <CardContent>
        {behaviour ? (
          <div className="min-w-0">
            <div className="font-mono text-[12px]">{behaviour.line}</div>
            <div className="text-[11px] text-muted-foreground">
              {behaviour.reason}
            </div>
          </div>
        ) : null}
        {card.snapshot ? <SnapshotBlock snapshot={card.snapshot} /> : null}
        {card.nested.map((row) => (
          <SnapshotBlock key={row.path} snapshot={row} nested />
        ))}
        {node ? <GhostBlock node={node} /> : null}
      </CardContent>
    </Card>
  );
}
