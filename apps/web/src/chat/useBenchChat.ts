import { useChat } from "@ai-sdk/react";
import { useCallback, useRef } from "react";

import {
  type AskUserQuestionsOutput,
  findPendingAskUserQuestions,
} from "@/chat/ask-user-questions";
import { harnessSendAutomaticallyWhen } from "@/chat/bench-chat";
import {
  isWorkspaceBusyError,
  lastUserPromptText,
  mapChatErrorMessage,
} from "@/chat/composer-recovery";
import { findPendingGetViewer } from "@/chat/get-viewer";
import { finishPersistMessages } from "@/chat/persist-thread";
import { useLiveViewerTools } from "@/chat/useLiveViewerTools";
import { viewerChatTransport } from "@/chat/viewer-chat-runtime";
import type { GalleryChatMessage } from "@/components/chat/mock-chat-messages";
import { persistThread } from "@/components/chat/useViewerChat";
import { jsonApi } from "@/lib/api";

export type BenchChatPersistOutcome =
  | { ok: true }
  | { ok: false; reason: "http" | "network" };

export type UseBenchChatOptions = {
  threadId: string;
  initialMessages: GalleryChatMessage[];
  /** Persist finished. The surface decides whether to toast or refresh. */
  onPersistSettled: (outcome: BenchChatPersistOutcome) => void;
  /** POST /api/chat/stop failed. Desktop toasts. Quest ignores. */
  onStopFailed?: () => void;
};

/**
 * One harness chat for the desktop session and the Quest runtime.
 * Each browser still has its own stream (ADR 0003).
 * `sendAutomaticallyWhen` stays false. A client tool fills from
 * `sendMessage()` after `addToolOutput` (ADR 0007).
 */
export function useBenchChat({
  threadId,
  initialMessages,
  onPersistSettled,
  onStopFailed,
}: UseBenchChatOptions) {
  const onPersistSettledRef = useRef(onPersistSettled);
  onPersistSettledRef.current = onPersistSettled;
  const onStopFailedRef = useRef(onStopFailed);
  onStopFailedRef.current = onStopFailed;
  const turnErrorRef = useRef<string | null>(null);

  const {
    messages: rawMessages,
    sendMessage,
    status,
    error,
    stop: stopStream,
    addToolOutput,
    setMessages,
  } = useChat({
    id: threadId,
    throttle: 50,
    messages: initialMessages,
    transport: viewerChatTransport(),
    sendAutomaticallyWhen: harnessSendAutomaticallyWhen,
    onError: (err) => {
      turnErrorRef.current = mapChatErrorMessage(err) ?? err.message;
    },
    onFinish: ({ messages: next, isError }) => {
      const text = turnErrorRef.current;
      turnErrorRef.current = null;
      const toSave = finishPersistMessages(
        next as GalleryChatMessage[],
        isError,
        text
      );
      if (!toSave) return;
      // Persist stamps data-error. Live state must use it or the turn
      // collapses to a Worked chip until reload.
      if (isError) setMessages(toSave);
      void persistThread(threadId, toSave).then(
        (res) => {
          if (res && "ok" in res && res.ok === false) {
            onPersistSettledRef.current({ ok: false, reason: "http" });
            return;
          }
          onPersistSettledRef.current({ ok: true });
        },
        () => {
          onPersistSettledRef.current({ ok: false, reason: "network" });
        }
      );
    },
  });

  const messages = rawMessages as GalleryChatMessage[];
  const busy = status === "submitted" || status === "streaming";
  const pendingAsk = findPendingAskUserQuestions(messages);
  const pendingViewer = findPendingGetViewer(messages);
  const live = busy || pendingViewer !== null;
  const errorText = mapChatErrorMessage(error);
  const errorIsBusy = isWorkspaceBusyError(error);

  const stop = useCallback(() => {
    stopStream();
    void jsonApi["chat"].stop.$post().then(
      (res) => {
        if (!res.ok) onStopFailedRef.current?.();
      },
      () => {
        onStopFailedRef.current?.();
      }
    );
  }, [stopStream]);

  const fillSuspendedTurn = useCallback(() => {
    void sendMessage();
  }, [sendMessage]);
  useLiveViewerTools(messages, addToolOutput, busy, fillSuspendedTurn);

  const answerAskUser = useCallback(
    (toolCallId: string, output: AskUserQuestionsOutput) => {
      void Promise.resolve(
        addToolOutput({
          tool: "askUserQuestions",
          toolCallId,
          output,
        })
      ).then(() => sendMessage());
    },
    [addToolOutput, sendMessage]
  );

  const retryFailedTurn = useCallback(() => {
    const last = messages.at(-1);
    if (last?.role === "user") {
      void sendMessage();
      return;
    }
    const text = lastUserPromptText(messages);
    if (!text) return;
    void sendMessage({ text });
  }, [messages, sendMessage]);

  return {
    messages,
    status,
    errorText,
    errorIsBusy,
    busy,
    live,
    pendingAsk,
    pendingViewer,
    sendMessage,
    stop,
    answerAskUser,
    retryFailedTurn,
  };
}

export type BenchChat = ReturnType<typeof useBenchChat>;
