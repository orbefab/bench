import { History } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  EMPTY_THREAD_TITLE,
  formatRelativeTime,
  isEmptyHistoryTitle,
  partitionHistoryRows,
  type ThreadPip,
  threadRowPip,
} from "@/chat/history";
import { LiveDot } from "@/components/brand/LiveDot";
import { CadRefTitle } from "@/components/chat/CadRefTitle";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

function StatusPip({ pip }: { pip: ThreadPip }) {
  if (!pip) return null;
  const label =
    pip === "streaming"
      ? "Replying"
      : pip === "ask-user"
        ? "Waiting on you"
        : "Error";
  if (pip === "streaming") {
    return <LiveDot className="animate-pulse" title={label} />;
  }
  return (
    <span
      aria-label={label}
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        pip === "ask-user" ? "bg-amber-500" : "bg-destructive"
      )}
      title={label}
    />
  );
}

export function HistoryPopover({
  threads,
  threadId,
  currentEmpty,
  currentPreview,
  currentStatus,
  refreshThreads,
  onOpenThread,
  side = "bottom",
}: {
  threads: { id: string; title: string; updated_at: number }[];
  threadId: string | null;
  currentEmpty: boolean;
  currentPreview: string | null;
  currentStatus: { streaming: boolean; askUser: boolean; error: boolean };
  refreshThreads: () => Promise<unknown>;
  onOpenThread: (id: string) => void;
  side?: "top" | "bottom";
}) {
  const [open, setOpen] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const [showEmpty, setShowEmpty] = useState(false);
  const now = Date.now();

  const refresh = useCallback(async () => {
    const rows = await refreshThreads();
    setRefreshError(rows === undefined);
  }, [refreshThreads]);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  const { visible, emptyHidden } = partitionHistoryRows(
    threads,
    threadId,
    currentEmpty
  );
  const rows = showEmpty ? [...visible, ...emptyHidden] : visible;

  return (
    <Popover
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setShowEmpty(false);
      }}
    >
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            title="Chat history"
            aria-label="Chat history"
          />
        }
      >
        <History />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-1" side={side}>
        {refreshError ? (
          <div className="px-2 py-1 text-[11px] text-error" role="status">
            Couldn't refresh
          </div>
        ) : null}
        {threads.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            No chats yet
          </div>
        ) : (
          <ul className="max-h-80 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
            {rows.map((t) => {
              const current = t.id === threadId;
              const empty = current
                ? currentEmpty
                : isEmptyHistoryTitle(t.title);
              const preview =
                current && isEmptyHistoryTitle(t.title) ? currentPreview : null;
              const pip = threadRowPip({
                rowId: t.id,
                currentId: threadId,
                streaming: currentStatus.streaming,
                askUser: currentStatus.askUser,
                error: currentStatus.error,
              });
              return (
                <li key={t.id}>
                  <PopoverClose
                    className={cn(
                      "flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                      current
                        ? "bg-accent font-medium text-accent-foreground"
                        : "hover:bg-accent",
                      empty && !current && "text-muted-foreground"
                    )}
                    onClick={() => onOpenThread(t.id)}
                  >
                    <StatusPip pip={pip} />
                    <span className="min-w-0 flex-1">
                      <CadRefTitle
                        className="block truncate text-sm"
                        title={t.title.trim() ? t.title : EMPTY_THREAD_TITLE}
                      />
                      {preview ? (
                        <span className="mt-0.5 block truncate text-[11px] font-normal text-muted-foreground">
                          <CadRefTitle title={preview} />
                        </span>
                      ) : null}
                    </span>
                    <span className="shrink-0 pt-0.5 text-[11px] font-normal text-muted-foreground">
                      {formatRelativeTime(t.updated_at, now)}
                    </span>
                  </PopoverClose>
                </li>
              );
            })}
          </ul>
        )}
        {emptyHidden.length > 0 ? (
          <button
            type="button"
            className="mt-0.5 w-full rounded-sm px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent"
            onClick={() => setShowEmpty((v) => !v)}
          >
            {showEmpty ? "Hide empty" : `Show empty (${emptyHidden.length})`}
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
