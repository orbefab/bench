import { PanelRight, Plus } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { currentThreadIsEmpty, decideNewChatAction } from "@/chat/history";
import { LiveDot } from "@/components/brand/LiveDot";
import { CrashCard } from "@/components/CrashCard";
import { CadRefTitle } from "@/components/chat/CadRefTitle";
import {
  ChatExportMenu,
  ChatSession,
  copyConversationJson,
} from "@/components/chat/ChatSession";
import type { GalleryChatHandle } from "@/components/chat/chat-input";
import { HistoryPopover } from "@/components/chat/HistoryPopover";
import type { GalleryChatMessage } from "@/components/chat/mock-chat-messages";
import {
  peekThreadMessages,
  readSavedThread,
  useViewerChat,
} from "@/components/chat/useViewerChat";
import { RenderErrorBoundary } from "@/components/RenderErrorBoundary";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { showToast } from "@/components/ui/toast";
import { useProjectSession } from "@/hooks/useProjectSession";
import { HIDDEN_CHAT_NOTICE, hiddenChatNotice } from "@/lib/feedback";
import {
  CHAT_DEFAULT_WIDTH,
  CHAT_MAX_WIDTH,
  CHAT_MIN_WIDTH,
  chatWidthAfterKey,
  clampChatDrag,
} from "@/lib/layout";
import { escBelongsTo, probeEscLayers } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { usePrefs } from "@/state/prefs";

export function ChatPanel({
  width,
  onClose,
  open = true,
  compact = false,
  toggleRef,
}: {
  width: number;
  onClose: () => void;
  open?: boolean;
  compact?: boolean;
  toggleRef?: RefObject<HTMLButtonElement | null>;
}) {
  const treeOpen = usePrefs((s) => s.treeOpen);
  const setWidth = usePrefs((s) => s.setChatWidth);
  const setChatOpen = usePrefs((s) => s.setChatOpen);
  const setCompactChatOpen = usePrefs((s) => s.setCompactChatOpen);
  const [resizing, setResizing] = useState(false);
  const [live, setLive] = useState(false);
  const [sessionPreview, setSessionPreview] = useState<string | null>(null);
  const [tabStatus, setTabStatus] = useState({
    streaming: false,
    askUser: false,
    error: false,
  });
  const prevTabStatus = useRef(tabStatus);
  const messagesRef = useRef<GalleryChatMessage[]>([]);
  const messagesThreadIdRef = useRef<string | null>(null);
  const newChatLock = useRef(false);
  const compactOpenRef = useRef(false);
  const panelRef = useRef<HTMLElement>(null);
  const stopTurnRef = useRef<(() => void) | null>(null);
  const captureDraftRef = useRef<(() => void) | null>(null);
  const composerRef = useRef<GalleryChatHandle>(null);
  const projectPath = useProjectSession().project.path;
  const {
    threads,
    threadId,
    initialMessages,
    refreshThreads,
    newThread,
    openThread,
    registerTabTurn,
  } = useViewerChat();
  useEffect(() => {
    const prev = prevTabStatus.current;
    prevTabStatus.current = tabStatus;
    const kind = hiddenChatNotice(!open, prev, tabStatus);
    if (!kind) return;
    showToast({
      type: kind === "failed" ? "error" : "info",
      title: HIDDEN_CHAT_NOTICE[kind],
      action: {
        label: "Show chat",
        onClick: () => (compact ? setCompactChatOpen(true) : setChatOpen(true)),
      },
    });
  }, [open, tabStatus, compact, setChatOpen, setCompactChatOpen]);

  const onSessionMeta = useCallback(
    (meta: {
      preview: string | null;
      streaming: boolean;
      askUser: boolean;
      error: boolean;
    }) => {
      setSessionPreview(meta.preview);
      setTabStatus((prev) =>
        prev.streaming === meta.streaming &&
        prev.askUser === meta.askUser &&
        prev.error === meta.error
          ? prev
          : {
              streaming: meta.streaming,
              askUser: meta.askUser,
              error: meta.error,
            }
      );
    },
    []
  );

  const persistWidth = useCallback(
    (next: number) => {
      setWidth(clampChatDrag(next, window.innerWidth, treeOpen));
    },
    [setWidth, treeOpen]
  );
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  useEffect(() => {
    if (!resizing) return;
    if (!open) {
      setResizing(false);
      return;
    }
    const move = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      persistWidth(drag.startW + (drag.startX - e.clientX));
    };
    const up = () => {
      setResizing(false);
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    return () => {
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
  }, [resizing, open, persistWidth]);

  useEffect(() => {
    const wasCompactOpen = compactOpenRef.current;
    const isCompactOpen = compact && open;
    compactOpenRef.current = isCompactOpen;
    if (isCompactOpen && !wasCompactOpen) {
      panelRef.current?.focus();
      return;
    }
    if (wasCompactOpen && compact && !open) {
      toggleRef?.current?.focus();
    }
  }, [compact, open, toggleRef]);

  useEffect(() => {
    if (!compact || !open || !threadId) return;
    let cancelled = false;
    let timer = 0;
    const started = Date.now();
    const tryFocus = () => {
      if (cancelled) return;
      if (composerRef.current?.isReady()) {
        composerRef.current.focus();
        return;
      }
      if (Date.now() - started > 1000) return;
      timer = window.setTimeout(tryFocus, 16);
    };
    tryFocus();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [compact, open, threadId]);

  // Hidden chat stays mounted (docked or compact), so stop any recording when it closes.
  useEffect(() => {
    if (!open) composerRef.current?.cancelVoice();
  }, [open]);

  useEffect(() => {
    if (!compact || !open) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      // Capture so we see popovers/selects before Base UI unmounts them.
      if (ev.defaultPrevented) return;
      const layers = { ...probeEscLayers(document), compactChat: true };
      if (!escBelongsTo("compact-chat", layers)) return;
      ev.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
    };
  }, [compact, open, onClose]);

  const onResizeKeyDown = (ev: ReactKeyboardEvent<HTMLDivElement>) => {
    const next = chatWidthAfterKey(
      ev.key,
      ev.shiftKey,
      width,
      window.innerWidth,
      treeOpen
    );
    if (next == null) return;
    ev.preventDefault();
    persistWidth(next);
  };

  const resizeMax = clampChatDrag(
    CHAT_MAX_WIDTH,
    typeof window === "undefined" ? width : window.innerWidth,
    treeOpen
  );

  const onResizeDown = (ev: ReactMouseEvent) => {
    ev.preventDefault();
    dragRef.current = { startX: ev.clientX, startW: width };
    setResizing(true);
  };

  const active = threads.find((t) => t.id === threadId);
  const headerTitle = active?.title ?? "Assistant";
  const currentEmpty = currentThreadIsEmpty({
    threadId,
    liveThreadId: messagesThreadIdRef.current,
    liveCount: messagesRef.current.length,
    initialCount: initialMessages.length,
  });

  const startNewChat = () => {
    if (newChatLock.current) return;
    newChatLock.current = true;
    void (async () => {
      try {
        const emptyNow = currentThreadIsEmpty({
          threadId,
          liveThreadId: messagesThreadIdRef.current,
          liveCount: messagesRef.current.length,
          initialCount: initialMessages.length,
        });
        const saved = readSavedThread(projectPath);
        const skipIds = saved && saved !== threadId ? [saved] : [];
        const rejected = new Set<string>();
        while (true) {
          const decision = decideNewChatAction({
            currentId: threadId,
            currentEmpty: emptyNow,
            threads,
            skipIds,
            rejectedIds: rejected,
          });
          if (decision.action === "focus") {
            composerRef.current?.focus();
            return;
          }
          if (decision.action === "create") {
            captureDraftRef.current?.();
            stopTurnRef.current?.();
            await newThread();
            return;
          }
          const peeked = await peekThreadMessages(decision.id);
          if (peeked && peeked.length === 0) {
            captureDraftRef.current?.();
            stopTurnRef.current?.();
            await openThread(decision.id);
            return;
          }
          rejected.add(decision.id);
        }
      } finally {
        newChatLock.current = false;
      }
    })();
  };

  return (
    <>
      {compact ? (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          aria-label="Close chat"
          className={cn(
            "fixed inset-0 z-40 bg-black/30 transition-opacity duration-200",
            open ? "opacity-100" : "pointer-events-none opacity-0"
          )}
          onClick={onClose}
        />
      ) : null}
      <aside
        ref={panelRef}
        role={compact && open ? "dialog" : undefined}
        aria-modal={compact && open ? true : undefined}
        aria-label="Assistant"
        aria-hidden={compact && !open ? true : undefined}
        inert={compact && !open ? true : undefined}
        tabIndex={compact ? -1 : undefined}
        data-compact-chat={compact && open ? "" : undefined}
        className={cn(
          "@container/chat flex h-full min-h-0 min-w-0 flex-col overflow-x-hidden border-l border-border bg-background",
          compact
            ? cn(
                "fixed inset-y-0 right-0 z-50 max-w-[90vw] outline-none transition-transform duration-200 ease-out",
                open ? "translate-x-0" : "pointer-events-none translate-x-full"
              )
            : "relative shrink-0",
          !compact && !open && "hidden"
        )}
        style={{ width }}
      >
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize chat"
          aria-valuemin={CHAT_MIN_WIDTH}
          aria-valuemax={resizeMax}
          aria-valuenow={width}
          tabIndex={0}
          className={cn(
            "absolute inset-y-0 left-0 z-10 w-2 cursor-col-resize bg-transparent outline-none hover:bg-border focus-visible:bg-border focus-visible:ring-2 focus-visible:ring-ring/50",
            resizing && "bg-muted-foreground"
          )}
          title="Drag to resize chat. Double-click to reset."
          onMouseDown={onResizeDown}
          onKeyDown={onResizeKeyDown}
          onDoubleClick={(ev) => {
            ev.preventDefault();
            persistWidth(CHAT_DEFAULT_WIDTH);
          }}
        />
        <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7"
            title="Hide chat"
            aria-label="Hide chat"
            onClick={onClose}
          >
            <PanelRight />
          </Button>
          <Separator
            orientation="vertical"
            className="mx-1 data-[orientation=vertical]:h-4"
          />
          <div className="flex min-w-0 flex-1 items-center gap-2 px-2">
            {live ? <LiveDot /> : null}
            <CadRefTitle
              className="min-w-0 truncate text-sm font-medium"
              title={headerTitle}
            />
          </div>
          <ChatExportMenu
            onCopyJson={() =>
              copyConversationJson({
                id: threadId,
                title: active?.title ?? "Assistant",
                messages: messagesRef.current,
              })
            }
          />
          <HistoryPopover
            currentEmpty={currentEmpty}
            currentPreview={sessionPreview}
            currentStatus={tabStatus}
            onOpenThread={(id) => {
              if (id === threadId) return;
              captureDraftRef.current?.();
              stopTurnRef.current?.();
              void openThread(id);
            }}
            refreshThreads={refreshThreads}
            threadId={threadId}
            threads={threads}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            title="New chat"
            aria-label="New chat"
            onClick={startNewChat}
          >
            <Plus />
          </Button>
        </header>
        <RenderErrorBoundary
          resetKeys={[threadId]}
          fallback={({ error, reset }) => (
            <div className="flex min-h-0 flex-1 items-center justify-center p-4">
              <CrashCard error={error} onRetry={reset} />
            </div>
          )}
        >
          {threadId ? (
            <ChatSession
              key={threadId}
              threadId={threadId}
              initialMessages={initialMessages}
              messagesRef={messagesRef}
              messagesThreadIdRef={messagesThreadIdRef}
              onLive={setLive}
              onMeta={onSessionMeta}
              onPersist={() => void refreshThreads()}
              registerTabTurn={registerTabTurn}
              stopTurnRef={stopTurnRef}
              captureDraftRef={captureDraftRef}
              composerRef={composerRef}
            />
          ) : null}
        </RenderErrorBoundary>
      </aside>
    </>
  );
}
