import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { stripViewerStamp } from "@/chat/composer-recovery";
import { shouldPersistMessages } from "@/chat/persist-thread";
import type { GalleryChatMessage } from "@/components/chat/mock-chat-messages";
import { showNetworkErrorToast } from "@/components/ui/toast";
import { useProjectSession } from "@/hooks/useProjectSession";
import { jsonApi } from "@/lib/api";
import {
  type ChatEffort,
  DEFAULT_CHAT_EFFORT,
  DEFAULT_HARNESS,
  DEFAULT_HARNESS_MODEL,
  type HarnessId,
  isChatEffort,
  isHarnessId,
} from "@/lib/harness";
import { prefsStore, usePrefs } from "@/state/prefs";
import { useXrUi } from "@/state/xr";

export type ThreadRow = {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  harness?: string | null;
  model?: string | null;
  effort?: string | null;
};

type ViewerChatValue = {
  threads: ThreadRow[];
  threadId: string | null;
  initialMessages: GalleryChatMessage[];
  refreshThreads: () => Promise<ThreadRow[] | undefined>;
  newThread: () => Promise<void>;
  openThread: (id: string) => Promise<void>;
  tabStreaming: boolean;
  stopTabTurn: () => void;
  registerTabTurn: (streaming: boolean, stop: (() => void) | null) => void;
};

const ViewerChatContext = createContext<ViewerChatValue | null>(null);

function threadKey(path: string) {
  return `sfab-bench.thread:${path}`;
}

/** Last thread id this origin wrote for the folder (shared across same-browser tabs). */
export function readSavedThread(path: string) {
  if (!path) return null;
  try {
    return localStorage.getItem(threadKey(path));
  } catch {
    return null;
  }
}

function writeSavedThread(path: string, id: string | null) {
  if (!path) return;
  try {
    if (id) localStorage.setItem(threadKey(path), id);
    else localStorage.removeItem(threadKey(path));
  } catch {
    /* private mode */
  }
}

function applyThreadPrefs(row: {
  harness?: string | null;
  model?: string | null;
  effort?: string | null;
}) {
  const harness: HarnessId =
    row.harness && isHarnessId(row.harness) ? row.harness : DEFAULT_HARNESS;
  const model =
    typeof row.model === "string" && row.model.trim()
      ? row.model.trim()
      : DEFAULT_HARNESS_MODEL[harness];
  const effort: ChatEffort =
    row.effort && isChatEffort(row.effort) ? row.effort : DEFAULT_CHAT_EFFORT;
  prefsStore.getState().setChatSelection(harness, model);
  prefsStore.getState().setChatEffort(effort);
}

function persistOpenPrefs(id: string) {
  const s = prefsStore.getState();
  return jsonApi.threads[":id"].prefs.$put({
    param: { id },
    json: { harness: s.chatHarness, model: s.chatModel, effort: s.chatEffort },
  });
}

export function ViewerChatProvider({ children }: { children: ReactNode }) {
  const chatOpen = usePrefs((s) => s.chatOpen);
  const compactChatOpen = usePrefs((s) => s.compactChatOpen);
  const xrChatOpen = useXrUi((s) => s.xrChatOpen);
  const xrDock = useXrUi((s) => s.bringChat);
  const active = chatOpen || compactChatOpen || xrChatOpen || xrDock != null;
  const projectPath = useProjectSession().project.path;
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [initialMessages, setInitialMessages] = useState<GalleryChatMessage[]>(
    []
  );
  const [tabStreaming, setTabStreaming] = useState(false);
  const stopTabTurnRef = useRef<(() => void) | null>(null);

  const registerTabTurn = useCallback(
    (streaming: boolean, stop: (() => void) | null) => {
      setTabStreaming(streaming);
      stopTabTurnRef.current = stop;
    },
    []
  );

  const stopTabTurn = useCallback(() => {
    stopTabTurnRef.current?.();
  }, []);

  const refreshThreads = useCallback(async () => {
    if (!projectPath) return [];
    try {
      const res = await jsonApi.threads.$get();
      if (!res.ok) return;
      const rows = (await res.json()) as ThreadRow[];
      setThreads(rows);
      return rows;
    } catch {
      return;
    }
  }, [projectPath]);

  const openThread = useCallback(
    async (id: string) => {
      if (!projectPath) return;
      try {
        const res = await jsonApi.threads[":id"].$get({ param: { id } });
        if (!res.ok) {
          showNetworkErrorToast({ title: "Couldn't open that chat" });
          return;
        }
        const body = (await res.json()) as {
          thread?: ThreadRow;
          messages?: GalleryChatMessage[];
        };
        setThreadId(id);
        setInitialMessages(body.messages ?? []);
        if (body.thread) applyThreadPrefs(body.thread);
        writeSavedThread(projectPath, id);
        await refreshThreads();
      } catch {
        showNetworkErrorToast({ title: "Couldn't open that chat" });
      }
    },
    [projectPath, refreshThreads]
  );

  const newThread = useCallback(async () => {
    if (!projectPath) return;
    try {
      const res = await jsonApi.threads.$post();
      if (!res.ok) {
        showNetworkErrorToast({ title: "Couldn't start a new chat" });
        return;
      }
      const row = (await res.json()) as ThreadRow;
      await persistOpenPrefs(row.id);
      setThreadId(row.id);
      setInitialMessages([]);
      writeSavedThread(projectPath, row.id);
      await refreshThreads();
    } catch {
      showNetworkErrorToast({ title: "Couldn't start a new chat" });
    }
  }, [projectPath, refreshThreads]);

  useEffect(() => {
    setThreadId(null);
    setInitialMessages([]);
    setThreads([]);
    setTabStreaming(false);
    stopTabTurnRef.current = null;
  }, [projectPath]);

  useEffect(() => {
    if (!active || !projectPath || threadId) return;
    let cancelled = false;
    void (async () => {
      const rows = (await refreshThreads()) ?? [];
      if (cancelled) return;
      const saved = readSavedThread(projectPath);
      if (saved && rows.some((row) => row.id === saved)) {
        await openThread(saved);
        return;
      }
      if (cancelled) return;
      if (rows[0]) {
        await openThread(rows[0].id);
        return;
      }
      await newThread();
    })();
    return () => {
      cancelled = true;
    };
  }, [active, projectPath, threadId, refreshThreads, openThread, newThread]);

  useEffect(() => {
    if (!threadId) return;
    let prev = prefsStore.getState();
    return prefsStore.subscribe((next) => {
      const was = prev;
      prev = next;
      if (
        next.chatHarness === was.chatHarness &&
        next.chatModel === was.chatModel &&
        next.chatEffort === was.chatEffort
      ) {
        return;
      }
      void persistOpenPrefs(threadId);
    });
  }, [threadId]);

  const value = useMemo(
    () => ({
      threads,
      threadId,
      initialMessages,
      refreshThreads,
      newThread,
      openThread,
      tabStreaming,
      stopTabTurn,
      registerTabTurn,
    }),
    [
      threads,
      threadId,
      initialMessages,
      refreshThreads,
      newThread,
      openThread,
      tabStreaming,
      stopTabTurn,
      registerTabTurn,
    ]
  );

  return (
    <ViewerChatContext.Provider value={value}>
      {children}
    </ViewerChatContext.Provider>
  );
}

export function useViewerChat() {
  const ctx = useContext(ViewerChatContext);
  if (!ctx) throw new Error("useViewerChat requires ViewerChatProvider");
  return ctx;
}

export function persistThread(
  threadId: string,
  messages: GalleryChatMessage[]
) {
  if (!shouldPersistMessages(messages)) return Promise.resolve();
  return jsonApi.threads[":id"].$put({
    param: { id: threadId },
    json: { messages },
  });
}

/** GET messages without opening the thread. `null` if the fetch failed. */
export async function peekThreadMessages(
  id: string
): Promise<GalleryChatMessage[] | null> {
  try {
    const res = await jsonApi.threads[":id"].$get({ param: { id } });
    if (!res.ok) return null;
    const body = (await res.json()) as { messages?: GalleryChatMessage[] };
    return body.messages ?? [];
  } catch {
    return null;
  }
}

export function messagePlainText(message: GalleryChatMessage) {
  return stripViewerStamp(
    (message.parts ?? [])
      .flatMap((part) =>
        part.type === "text" && "text" in part ? [part.text] : []
      )
      .join("\n")
  );
}
