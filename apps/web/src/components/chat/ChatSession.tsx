import {
  Check,
  Copy,
  EllipsisVertical,
  MessageCircleDashedIcon,
} from "lucide-react";
import { type RefObject, useEffect, useState } from "react";
import { lastUserPromptText } from "@/chat/composer-recovery";
import { firstUserLine } from "@/chat/history";
import { isTurnErrorPart } from "@/chat/persist-thread";
import { useBenchChat } from "@/chat/useBenchChat";
import {
  type GalleryChatHandle,
  GalleryChatInput,
  type GalleryPromptMessage,
} from "@/components/chat/chat-input";
import { ChatMessageRow } from "@/components/chat/chat-message-parts";
import type { GalleryChatMessage } from "@/components/chat/mock-chat-messages";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { showNetworkErrorToast } from "@/components/ui/toast";
import { copyText } from "@/lib/settings";
import { useViewer } from "@/state/viewer";

export async function copyConversationJson(conversation: {
  id: string | null;
  title: string;
  messages: GalleryChatMessage[];
}) {
  return copyText(JSON.stringify(conversation, null, 2));
}

export function ChatExportMenu({
  onCopyJson,
}: {
  onCopyJson: () => Promise<boolean>;
}) {
  const [copied, setCopied] = useState<"idle" | "copied" | "error">("idle");

  return (
    <Popover
      onOpenChange={(open) => {
        if (!open) setCopied("idle");
      }}
    >
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            title="Export"
            aria-label="Export"
          />
        }
      >
        <EllipsisVertical />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-1">
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-foreground outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={() => {
            void onCopyJson().then((ok) => {
              setCopied(ok ? "copied" : "error");
            });
          }}
        >
          {copied === "copied" ? (
            <Check className="size-4 shrink-0" />
          ) : (
            <Copy className="size-4 shrink-0" />
          )}
          {copied === "copied"
            ? "Copied"
            : copied === "error"
              ? "Couldn't copy"
              : "Copy conversation as JSON"}
        </button>
      </PopoverContent>
    </Popover>
  );
}

export function ChatSession({
  threadId,
  initialMessages,
  messagesRef,
  messagesThreadIdRef,
  onLive,
  onMeta,
  onPersist,
  registerTabTurn,
  stopTurnRef,
  captureDraftRef,
  composerRef,
}: {
  threadId: string;
  initialMessages: GalleryChatMessage[];
  messagesRef: RefObject<GalleryChatMessage[]>;
  messagesThreadIdRef: RefObject<string | null>;
  onLive: (live: boolean) => void;
  onMeta: (meta: {
    preview: string | null;
    streaming: boolean;
    askUser: boolean;
    error: boolean;
  }) => void;
  onPersist: () => void;
  registerTabTurn: (streaming: boolean, stop: (() => void) | null) => void;
  stopTurnRef: RefObject<(() => void) | null>;
  captureDraftRef: RefObject<(() => void) | null>;
  composerRef: RefObject<GalleryChatHandle | null>;
}) {
  const progress = useViewer((s) => s.progress);
  const url = useViewer((s) => s.url);
  const {
    messages,
    sendMessage,
    status,
    errorText,
    errorIsBusy,
    busy,
    live,
    pendingAsk,
    pendingViewer,
    stop,
    answerAskUser,
    retryFailedTurn,
  } = useBenchChat({
    threadId,
    initialMessages,
    onPersistSettled: (outcome) => {
      if (!outcome.ok) {
        showNetworkErrorToast({ title: "Couldn't save this chat" });
        return;
      }
      onPersist();
    },
    onStopFailed: () => {
      showNetworkErrorToast({ title: "Couldn't stop the reply" });
    },
  });
  const loadingModel = pendingViewer !== null || progress !== null;
  useEffect(() => {
    captureDraftRef.current = () => composerRef.current?.captureDraft();
    return () => {
      captureDraftRef.current = null;
    };
  }, [captureDraftRef]);
  useEffect(() => {
    if (!live) {
      stopTurnRef.current = null;
      return;
    }
    stopTurnRef.current = stop;
    return () => {
      stopTurnRef.current = null;
    };
  }, [live, stop, stopTurnRef]);
  useEffect(() => {
    registerTabTurn(busy, busy ? stop : null);
    return () => registerTabTurn(false, null);
  }, [busy, stop, registerTabTurn]);
  useEffect(() => {
    onLive(live);
    return () => onLive(false);
  }, [live, onLive]);
  messagesRef.current = messages;
  messagesThreadIdRef.current = threadId;
  const streamingMessageId =
    busy && messages.at(-1)?.role === "assistant"
      ? (messages.at(-1)?.id ?? null)
      : null;
  const lastPrompt = lastUserPromptText(messages);

  const onSubmit = (payload: GalleryPromptMessage) => {
    const text = payload.text.trim();
    if (!text) return;
    void sendMessage({ text });
  };

  const liveError = status === "error";
  const lastMessage = messages.at(-1);
  const tailErrorId =
    !liveError &&
    lastMessage?.role === "assistant" &&
    (lastMessage.parts ?? []).some(isTurnErrorPart)
      ? lastMessage.id
      : null;

  useEffect(() => {
    onMeta({
      preview: firstUserLine(messages),
      streaming: busy,
      askUser: pendingAsk !== null,
      error: liveError || Boolean(tailErrorId),
    });
  }, [messages, busy, pendingAsk, liveError, tailErrorId, onMeta]);

  return (
    <>
      {liveError && errorText ? (
        <div className="flex items-center gap-2 px-3 py-1 text-xs text-error">
          <span className="min-w-0 flex-1">{errorText}</span>
          {errorIsBusy ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2"
              onClick={stop}
            >
              Stop
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2"
              onClick={retryFailedTurn}
            >
              Retry
            </Button>
          )}
        </div>
      ) : null}
      <MessageScrollerProvider autoScroll>
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent className="px-3 py-3">
              {messages.length === 0 ? (
                <Empty className="h-full border-0">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <MessageCircleDashedIcon />
                    </EmptyMedia>
                    <EmptyTitle>How can I help?</EmptyTitle>
                    <EmptyDescription>
                      Ask for a CAD change. Try “What am I looking at?” then a
                      size change.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                messages.map((message) => (
                  <MessageScrollerItem
                    key={message.id}
                    messageId={message.id}
                    scrollAnchor={message.role === "user"}
                    className={
                      streamingMessageId === message.id
                        ? "[content-visibility:visible]"
                        : undefined
                    }
                  >
                    <ChatMessageRow
                      isStreaming={streamingMessageId === message.id}
                      message={message as GalleryChatMessage}
                      onRetry={
                        tailErrorId === message.id ? retryFailedTurn : undefined
                      }
                    />
                  </MessageScrollerItem>
                ))
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          {pendingAsk ? null : <MessageScrollerButton />}
        </MessageScroller>
      </MessageScrollerProvider>
      <GalleryChatInput
        canStop={pendingViewer !== null}
        loadingModel={loadingModel}
        modelLoaded={Boolean(url) && progress === null}
        onAnswerAskUser={answerAskUser}
        onStop={stop}
        onSubmit={onSubmit}
        pendingAsk={pendingAsk}
        ref={composerRef}
        restorePrompt={status === "error" ? lastPrompt : null}
        status={status}
        threadId={threadId}
      />
    </>
  );
}
