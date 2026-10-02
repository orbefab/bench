import type { ChatStatus } from "ai";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { AskUserQuestionsOutput } from "@/chat/ask-user-questions";
import { useBenchChat } from "@/chat/useBenchChat";
import type { GalleryChatMessage } from "@/components/chat/mock-chat-messages";
import {
  messagePlainText,
  useViewerChat,
} from "@/components/chat/useViewerChat";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import { setXrChatChars, useXrUi, xrUiStore } from "@/state/xr";

type Voice = ReturnType<typeof useVoiceInput>;

export type XrChatRuntime = {
  messages: GalleryChatMessage[];
  busy: boolean;
  status: ChatStatus;
  /** Mapped chat error. Null when the stream has no error. */
  error: string | null;
  draft: string;
  setDraft: (value: string | ((cur: string) => string)) => void;
  send: () => void;
  stop: () => void;
  pendingAsk: ReturnType<typeof useBenchChat>["pendingAsk"];
  answerAskUser: (toolCallId: string, output: AskUserQuestionsOutput) => void;
  voice: Voice;
};

const XrChatRuntimeContext = createContext<XrChatRuntime | null>(null);

export function useXrChatRuntime() {
  return useContext(XrChatRuntimeContext);
}

function appendDraft(cur: string, text: string) {
  if (!cur.trim()) return text;
  return /[\s\n]$/.test(cur) ? `${cur}${text}` : `${cur} ${text}`;
}

function XrChatSessionRuntime({
  threadId,
  initialMessages,
  onPersist,
  children,
}: {
  threadId: string;
  initialMessages: GalleryChatMessage[];
  onPersist: () => void;
  children: ReactNode;
}) {
  const xrChatOpen = useXrUi((s) => s.xrChatOpen);
  const openRef = useRef(xrChatOpen);
  openRef.current = xrChatOpen;
  const [draft, setDraft] = useState("");
  const busyRef = useRef(false);
  const sendRef = useRef<(text: string) => void>(() => {});

  const {
    messages,
    sendMessage,
    status,
    errorText,
    live,
    pendingAsk,
    stop,
    answerAskUser,
  } = useBenchChat({
    threadId,
    initialMessages,
    // A rejected PUT does not refresh. An HTTP error response still does,
    // matching persistThread().then(onPersist) with no rejection handler.
    onPersistSettled: (outcome) => {
      if (!outcome.ok && outcome.reason === "network") return;
      onPersist();
    },
  });

  busyRef.current = live;

  const sendFreeform = (
    pending: NonNullable<typeof pendingAsk>,
    text: string
  ) => {
    const question = pending.input.questions[0];
    if (!question?.allowFreeForm) return false;
    answerAskUser(pending.toolCallId, {
      action: "answered",
      answers: { [question.id]: { optionIds: [], freeform: text } },
    });
    return true;
  };

  const send = () => {
    const text = draft.trim();
    if (!text || busyRef.current) return;
    if (pendingAsk) {
      if (!sendFreeform(pendingAsk, text)) return;
      setDraft("");
      return;
    }
    setDraft("");
    void sendMessage({ text });
  };

  // Voice can start a turn while the chat card is closed.
  sendRef.current = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busyRef.current) return;
    if (pendingAsk) {
      sendFreeform(pendingAsk, trimmed);
      return;
    }
    void sendMessage({ text: trimmed });
  };

  const voice = useVoiceInput((text) => {
    if (openRef.current) {
      setDraft((cur) => appendDraft(cur, text));
      return;
    }
    sendRef.current(text);
  });

  useEffect(() => {
    const phase = live
      ? status === "streaming"
        ? "streaming"
        : "submitted"
      : "idle";
    xrUiStore.getState().setXrChatPhase(phase);
    return () => xrUiStore.getState().setXrChatPhase("idle");
  }, [live, status]);
  useEffect(() => {
    const last = [...messages].reverse().find((m) => m.role === "assistant");
    setXrChatChars(
      last ? messagePlainText(last as GalleryChatMessage).length : 0
    );
    return () => setXrChatChars(0);
  }, [messages]);

  const value: XrChatRuntime = {
    messages,
    busy: live,
    status,
    error: errorText,
    draft,
    setDraft,
    send,
    stop,
    pendingAsk,
    answerAskUser,
    voice,
  };

  return (
    <XrChatRuntimeContext.Provider value={value}>
      {children}
    </XrChatRuntimeContext.Provider>
  );
}

export function XrChatRuntimeProvider({ children }: { children: ReactNode }) {
  const { threadId, initialMessages, refreshThreads } = useViewerChat();
  if (!threadId) return children;
  return (
    <XrChatSessionRuntime
      key={threadId}
      threadId={threadId}
      initialMessages={initialMessages}
      onPersist={() => void refreshThreads()}
    >
      {children}
    </XrChatSessionRuntime>
  );
}
