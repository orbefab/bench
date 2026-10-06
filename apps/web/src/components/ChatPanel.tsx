import { MessageCircleDashedIcon, Minus, Plus } from "lucide-react";
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
import {
  type ChatComposerLayout,
  type GalleryChatHandle,
  GalleryChatInput,
} from "@/components/chat/chat-input";
import { HistoryPopover } from "@/components/chat/HistoryPopover";
import type { GalleryChatMessage } from "@/components/chat/mock-chat-messages";
import {
  peekThreadMessages,
  readSavedThread,
  useViewerChat,
} from "@/components/chat/useViewerChat";
import { RenderErrorBoundary } from "@/components/RenderErrorBoundary";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
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
import { cn } from "@/lib/utils";
import { usePrefs } from "@/state/prefs";

const MINIMAL_HISTORY_SLOT = 32 + 6;

export function ChatPanel({
  width,
  onClose,
  open = true,
  docked = false,
  toggleRef,
}: {
  width: number;
  onClose: () => void;
  open?: boolean;
  docked?: boolean;
  toggleRef?: RefObject<HTMLButtonElement | null>;
}) {
  const setWidth = usePrefs((s) => s.setChatWidth);
  const setChatOpen = usePrefs((s) => s.setChatOpen);
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
        onClick: () => setChatOpen(true),
      },
    });
  }, [open, tabStatus, setChatOpen]);

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
      setWidth(clampChatDrag(next));
    },
    [setWidth]
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

  // A hidden popup stays mounted, so stop any recording when it closes.
  useEffect(() => {
    if (!open) composerRef.current?.cancelVoice();
  }, [open]);

  const wasOpenRef = useRef(open);
  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = open;
    if (wasOpen && !open && !docked) toggleRef?.current?.focus();
  }, [docked, open, toggleRef]);

  const onResizeKeyDown = (ev: ReactKeyboardEvent<HTMLDivElement>) => {
    const next = chatWidthAfterKey(ev.key, ev.shiftKey, width);
    if (next == null) return;
    ev.preventDefault();
    persistWidth(next);
  };

  const resizeMax = clampChatDrag(CHAT_MAX_WIDTH);

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
  const popup = !docked;
  const bare = popup && (!threadId || currentEmpty);
  const composerLayout: ChatComposerLayout = popup ? "inline" : "stacked";

  const historyPopover = (side: "top" | "bottom") => (
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
      side={side}
      threadId={threadId}
      threads={threads}
    />
  );

  const pendingSubmit = () => {
    showToast({
      type: "info",
      title: projectPath ? "Still opening this chat" : "Open a folder to send",
    });
  };

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
    <aside
      ref={panelRef}
      aria-label="Assistant"
      aria-hidden={!docked && !open ? true : undefined}
      inert={!docked && !open ? true : undefined}
      data-chat-chrome={bare ? "input" : "panel"}
      className={cn(
        "@container/chat flex min-h-0 min-w-0 flex-col",
        docked
          ? "relative h-full w-full bg-background"
          : bare
            ? cn(
                "absolute right-3 bottom-3 z-20 max-w-[calc(100%-1.5rem)] rounded-3xl border border-white bg-background p-2 shadow-2xl",
                !open && "hidden"
              )
            : cn(
                "absolute right-3 bottom-3 z-20 overflow-hidden rounded-xl border border-border bg-background shadow-2xl",
                "h-[min(640px,calc(100%-1.5rem))] max-w-[calc(100%-1.5rem)]",
                !open && "hidden"
              )
      )}
      style={
        docked
          ? undefined
          : { width: bare ? width + MINIMAL_HISTORY_SLOT : width }
      }
    >
      {docked || bare ? null : (
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
      )}
      {bare ? null : (
        <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-2">
          {docked ? null : (
            <>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-7"
                title="Minimize"
                aria-label="Minimize"
                onClick={onClose}
              >
                <Minus />
              </Button>
              <Separator
                orientation="vertical"
                className="mx-1 data-[orientation=vertical]:h-4"
              />
            </>
          )}
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
          {historyPopover("bottom")}
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
      )}
      <RenderErrorBoundary
        resetKeys={[threadId]}
        fallback={({ error, reset }) => (
          <div className="flex min-h-0 flex-1 items-center justify-center p-4">
            <CrashCard error={error} onRetry={reset} />
          </div>
        )}
      >
        {bare ? (
          <div className="flex items-center gap-1.5">
            <div className="min-w-0 flex-1">
              {threadId ? (
                <ChatSession
                  key={threadId}
                  captureDraftRef={captureDraftRef}
                  composerRef={composerRef}
                  hideEmpty
                  initialMessages={initialMessages}
                  layout="inline"
                  messagesRef={messagesRef}
                  messagesThreadIdRef={messagesThreadIdRef}
                  registerTabTurn={registerTabTurn}
                  stopTurnRef={stopTurnRef}
                  threadId={threadId}
                  onLive={setLive}
                  onMeta={onSessionMeta}
                  onPersist={() => void refreshThreads()}
                />
              ) : (
                <GalleryChatInput
                  elevated
                  layout="inline"
                  status="ready"
                  threadId={projectPath ? `pending:${projectPath}` : "pending"}
                  onSubmit={pendingSubmit}
                />
              )}
            </div>
            {historyPopover("top")}
          </div>
        ) : threadId ? (
          <ChatSession
            key={threadId}
            captureDraftRef={captureDraftRef}
            composerRef={composerRef}
            hideEmpty={false}
            initialMessages={initialMessages}
            layout={composerLayout}
            messagesRef={messagesRef}
            messagesThreadIdRef={messagesThreadIdRef}
            registerTabTurn={registerTabTurn}
            stopTurnRef={stopTurnRef}
            threadId={threadId}
            onLive={setLive}
            onMeta={onSessionMeta}
            onPersist={() => void refreshThreads()}
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-0 flex-1 items-center justify-center p-6">
              <Empty className="border-0">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <MessageCircleDashedIcon />
                  </EmptyMedia>
                  <EmptyTitle>How can I help?</EmptyTitle>
                  <EmptyDescription>
                    {projectPath
                      ? "Starting a chat…"
                      : "Open a folder to send a message."}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </div>
            <GalleryChatInput
              status="ready"
              threadId={projectPath ? `pending:${projectPath}` : "pending"}
              onSubmit={pendingSubmit}
            />
          </div>
        )}
      </RenderErrorBoundary>
    </aside>
  );
}
