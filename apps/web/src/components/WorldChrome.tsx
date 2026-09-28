import { Home } from "lucide-react";
import { useShallow } from "zustand/react/shallow";

import { Button } from "@/components/ui/button";
import { formatWorldIssues, visibleAssetIssues } from "@/lib/world-issues";
import { useWorld } from "@/state/world";

export function WorldControls({
  top,
  left,
  onHome,
}: {
  top: number;
  left: number;
  onHome: () => void;
}) {
  const { connection, notice } = useWorld(
    useShallow((s) => ({
      connection: s.connection,
      notice: s.notice,
    }))
  );
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
        {status ? (
          <span className="pr-1.5 text-xs text-muted-foreground">{status}</span>
        ) : null}
      </div>
      {notice ? (
        <div
          className="pointer-events-none absolute z-20 rounded-xl border border-border bg-card/95 px-3 py-1.5 text-xs shadow-lg"
          style={{ top: top + 52, left }}
          aria-live="polite"
        >
          {notice}
        </div>
      ) : null}
    </>
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
