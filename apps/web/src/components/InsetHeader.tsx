import { ChevronsUpDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { PartBreadcrumb, PartTabStrip } from "@/components/WorldPartTabs";
import { sendWorldRedo, sendWorldUndo } from "@/hooks/useWorldRun";
import { folderName } from "@/lib/project";
import { cn } from "@/lib/utils";
import { historyButtons } from "@/lib/world-history";
import { useStudioNav } from "@/state/studio-nav";
import { useWorld } from "@/state/world";

export function InsetHeader({
  path,
  docked,
  onToggleDock,
  showDockToggle,
}: {
  path: string;
  docked: boolean;
  onToggleDock: () => void;
  showDockToggle: boolean;
}) {
  const atHome = useStudioNav((state) => state.atHome);
  const worldPath = useWorld((state) => state.path);
  const history = useWorld((state) => state.history);
  const label = useWorld((state) => state.editLabel);
  const showWorld = Boolean(worldPath) && !atHome;
  const buttons = historyButtons(history);
  const title = atHome || !path ? "Home" : folderName(path);
  const dockLabel = docked ? "Float chat" : "Dock chat";

  return (
    <div className="shrink-0 border-b border-border bg-background">
      <div
        data-slot="inset-header"
        className="flex h-10 items-center gap-1 px-2"
      >
        <SidebarTrigger />
        <span className="max-w-40 truncate px-1 font-medium text-sm">
          {title}
        </span>
        {showWorld ? <PartTabStrip /> : null}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {showWorld && label ? (
            <span className="hidden max-w-40 truncate text-muted-foreground text-xs sm:inline">
              {label}
            </span>
          ) : null}
          {showWorld ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={!buttons.canUndo}
                onClick={() => sendWorldUndo()}
              >
                Undo
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={!buttons.canRedo}
                onClick={() => sendWorldRedo()}
              >
                Redo
              </Button>
            </>
          ) : null}
          {showDockToggle ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className={cn(
                "size-7",
                docked && "bg-accent text-accent-foreground"
              )}
              aria-pressed={docked}
              aria-label={dockLabel}
              title={dockLabel}
              onClick={onToggleDock}
            >
              <ChevronsUpDown />
            </Button>
          ) : null}
        </div>
      </div>
      {showWorld ? <PartBreadcrumb /> : null}
    </div>
  );
}
