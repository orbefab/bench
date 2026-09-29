import { Home, MousePointer2, Move3d, Rotate3d } from "lucide-react";
import { useShallow } from "zustand/react/shallow";

import { RunPlayingDialog } from "@/components/RunPlayingDialog";
import { Button } from "@/components/ui/button";
import { formatWorldIssues, visibleAssetIssues } from "@/lib/world-issues";
import { moveTarget } from "@/lib/world-move";
import { toolLabel, type WorldToolMode } from "@/lib/world-tool";
import { useWorld } from "@/state/world";
import {
  pickWorldTool,
  stayToolCommit,
  stopToolCommit,
  useWorldTool,
} from "@/state/world-tool";

const TOOL_BUTTONS: readonly {
  mode: WorldToolMode;
  icon: typeof MousePointer2;
}[] = [
  { mode: "select", icon: MousePointer2 },
  { mode: "move", icon: Move3d },
  { mode: "rotate", icon: Rotate3d },
];

/** Why the selection cannot take a tool, or null when it can. */
export function useMoveReason(): string | null {
  const tree = useWorld((s) => s.tree);
  const path = useWorld((s) => s.selection?.path ?? null);
  const openDocument = useWorld((s) => s.path);
  const target = moveTarget(tree, path, openDocument);
  return target.ok ? null : target.reason;
}

export function WorldControls({
  top,
  left,
  onHome,
}: {
  top: number;
  left: number;
  onHome: () => void;
}) {
  const { connection, notice, selected } = useWorld(
    useShallow((s) => ({
      connection: s.connection,
      notice: s.notice,
      selected: s.selection !== null,
    }))
  );
  const mode = useWorldTool((s) => s.mode);
  const reason = useMoveReason();
  const status =
    connection === "reconnecting"
      ? "Reconnecting…"
      : connection === "connecting"
        ? "Connecting…"
        : null;
  return (
    <>
      <div
        className="pointer-events-auto absolute z-20 flex items-center gap-0.5 rounded-xl border border-border bg-card/95 p-1 shadow-lg"
        style={{ top, left }}
      >
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-9 w-9 p-0"
          title="Frame world"
          aria-label="Frame world"
          onClick={onHome}
        >
          <Home />
        </Button>
        <div
          className="mx-0.5 flex items-center gap-0.5"
          role="toolbar"
          aria-label="Tools"
        >
          {TOOL_BUTTONS.map(({ mode: item, icon: Icon }) => {
            const blocked = item !== "select" && selected && reason !== null;
            const label = toolLabel(item);
            return (
              <Button
                key={item}
                type="button"
                variant={mode === item ? "default" : "secondary"}
                size="sm"
                className="h-9 w-9 p-0"
                title={blocked ? `${label}: ${reason}` : label}
                aria-label={label}
                aria-pressed={mode === item}
                disabled={blocked}
                onClick={() => pickWorldTool(item)}
              >
                <Icon />
              </Button>
            );
          })}
        </div>
        {status ? (
          <span className="pr-1.5 text-xs text-muted-foreground">{status}</span>
        ) : null}
      </div>
      {mode !== "select" && selected && reason ? (
        <div
          className="pointer-events-none absolute z-20 rounded-xl border border-border bg-card/95 px-3 py-1.5 text-xs text-muted-foreground shadow-lg"
          style={{ top: top + 52, left }}
        >
          {reason}
        </div>
      ) : null}
      {notice ? (
        <div
          className="pointer-events-none absolute z-20 rounded-xl border border-border bg-card/95 px-3 py-1.5 text-xs shadow-lg"
          style={{
            top: top + (mode !== "select" && selected && reason ? 92 : 52),
            left,
          }}
          aria-live="polite"
        >
          {notice}
        </div>
      ) : null}
    </>
  );
}

/** A tool commit restarts the run, so a playing run asks first. */
export function WorldToolDialog() {
  const pending = useWorldTool((s) => s.pending);
  if (!pending) return null;
  return (
    <RunPlayingDialog
      description={`${pending.label} restarts the run. The recording stays on the timeline.`}
      onStay={stayToolCommit}
      onStop={stopToolCommit}
    />
  );
}

export function WorldProblemCard() {
  const { runErrors, runMessage, assetIssues, assets, sceneReady, path } =
    useWorld(
      useShallow((s) => ({
        runErrors: s.runErrors,
        runMessage: s.runMessage,
        assetIssues: s.assetIssues,
        assets: s.assets,
        sceneReady: s.sceneReady,
        path: s.path,
      }))
    );
  const issues = formatWorldIssues(runErrors, runMessage);
  const assetsShown = visibleAssetIssues(assetIssues, runErrors);
  if (!path) return null;
  if (
    issues.length === 0 &&
    assetsShown.length === 0 &&
    !(assets === "loading" && !sceneReady)
  ) {
    return null;
  }
  if (issues.length === 0 && assetsShown.length === 0) {
    const name = path.split("/").filter(Boolean).pop() ?? "world";
    return (
      <div className="pointer-events-none absolute inset-x-4 top-1/2 z-20 mx-auto w-full max-w-72 -translate-y-1/2 rounded-xl border border-border bg-card/95 p-4 text-center text-sm shadow-lg">
        Opening {name}…
      </div>
    );
  }
  return (
    <div className="pointer-events-auto absolute inset-x-4 top-1/2 z-20 mx-auto max-h-[50vh] w-full max-w-md -translate-y-1/2 overflow-auto rounded-xl border border-destructive bg-card p-4 text-sm shadow-lg">
      <strong>This world can’t run</strong>
      {issues.length > 0 ? (
        <ul className="mt-2 space-y-2">
          {issues.map((issue) => (
            <li key={`${issue.code}:${issue.path}:${issue.message}`}>
              <div className="text-xs text-muted-foreground">
                {issue.code}
                {issue.path ? ` · ${issue.path}` : ""}
              </div>
              <div className="text-error">{issue.message}</div>
              {issue.hint ? (
                <div className="text-xs text-muted-foreground">
                  Hint: {issue.hint}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {assetsShown.length > 0 ? (
        <div className="mt-2 whitespace-pre-wrap text-error">
          {assetsShown.map((issue) => issue.text).join("\n")}
        </div>
      ) : null}
    </div>
  );
}
