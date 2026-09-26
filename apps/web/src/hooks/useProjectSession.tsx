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
import { closeToast, showToast } from "@/components/ui/toast";
import { getDeviceToken, jsonApi } from "@/lib/api";
import {
  ignoreDocumentHistory,
  isWorldFilePath,
  readOpenDocument,
} from "@/lib/document-query";
import {
  CONNECTION_GRACE_MS,
  CONNECTION_RELOAD_AFTER_MS,
  CONNECTION_RETRY_MS,
  type ConnectionEvent,
  type ConnectionPhase,
  type ConnectionState,
  INITIAL_CONNECTION_STATE,
  reduceConnection,
  setLiveConnectionPhase,
} from "@/lib/feedback";
import { shouldReloadOpenFile } from "@/lib/files-rail";
import { LIBRARY_FILES_EVENT } from "@/lib/motion";
import { openWorld } from "@/lib/open-document";
import { registerAndOpenTab } from "@/lib/project";
import { projectUrl } from "@/lib/project-query";
import { redact } from "@/lib/redact";
import type {
  ProjectSession,
  SessionClient,
  SessionEvent,
  SessionSnapshot,
} from "@/lib/session";
import { emitFolderError } from "@/lib/welcome";
import { prefsStore } from "@/state/prefs";
import { viewerStore } from "@/state/viewer";
import { worldStore } from "@/state/world";

type SessionValue = {
  ready: boolean;
  you: SessionClient;
  project: ProjectSession["project"];
  fileRecents: string[];
  connectionPhase: ConnectionPhase;
  connectionLostShown: boolean;
  connectionOfferReload: boolean;
  setDoc: (file: string | null, reload?: boolean) => Promise<void>;
};

const SessionContext = createContext<SessionValue | null>(null);

function sessionWsUrl() {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const token = getDeviceToken();
  const q = token ? `?token=${encodeURIComponent(token)}` : "";
  return `${proto}//${window.location.host}/api/session/live${q}`;
}

export function ProjectSessionProvider({
  you: youProp,
  children,
}: {
  you: SessionClient;
  children: ReactNode;
}) {
  const [ready, setReady] = useState(false);
  const [you, setYou] = useState(youProp);
  const [project, setProject] = useState<ProjectSession["project"]>(() => ({
    path: projectUrl(),
  }));
  const [fileRecents, setFileRecents] = useState<string[]>([]);
  const [connection, setConnection] = useState<ConnectionState>(
    INITIAL_CONNECTION_STATE
  );
  const appliedDeepLink = useRef(false);
  const lastPath = useRef(projectUrl());

  const applyLibrary = useCallback((path: string, recents: string[]) => {
    const pathChanged = lastPath.current !== path;
    if (pathChanged) {
      const { url, error, progress } = viewerStore.getState();
      // Clear a leftover document boot, or the previous folder's document.
      if (
        lastPath.current ||
        url ||
        worldStore.getState().path ||
        error ||
        progress !== null
      ) {
        void viewerStore.getState().loadModel("");
      }
    }
    lastPath.current = path;
    setProject({ path });
    setFileRecents(recents);
    prefsStore.getState().setRecentFiles(recents);
    window.dispatchEvent(new Event(LIBRARY_FILES_EVENT));
  }, []);

  const adoptTab = useCallback(
    (path: string, recents: string[]) => {
      applyLibrary(path, recents);
      if (!path) {
        if (
          readOpenDocument(window.location.search).kind !== "none" ||
          viewerStore.getState().url ||
          worldStore.getState().path ||
          viewerStore.getState().progress !== null
        ) {
          void viewerStore.getState().loadModel("");
        }
        return;
      }
      if (!appliedDeepLink.current) {
        appliedDeepLink.current = true;
        const doc = readOpenDocument(window.location.search);
        if (doc.kind === "world") {
          if (worldStore.getState().path !== doc.path) {
            openWorld(doc.path, { history: "replace" });
          }
        } else if (doc.kind === "file") {
          void viewerStore.getState().loadModel(doc.path);
        }
      }
    },
    [applyLibrary]
  );

  const loadTabLibrary = useCallback(
    (path: string) => {
      if (!path) {
        adoptTab("", []);
        return;
      }
      void jsonApi.project
        .$get()
        .then(async (res) => {
          if (!res.ok) throw new Error("Could not load project");
          return res.json() as Promise<{ fileRecents?: string[] }>;
        })
        .then((body) => {
          if (projectUrl() !== path) return;
          adoptTab(path, body.fileRecents ?? []);
        })
        .catch(() => {
          if (projectUrl() === path) adoptTab(path, []);
        });
    },
    [adoptTab]
  );

  const applySnapshot = useCallback(
    (snap: SessionSnapshot) => {
      if (snap.you) setYou(snap.you);
      const tab = projectUrl();
      if (!tab) {
        adoptTab("", []);
        return;
      }
      if (tab === snap.project.path) {
        adoptTab(tab, snap.fileRecents ?? []);
        return;
      }
      loadTabLibrary(tab);
    },
    [adoptTab, loadTabLibrary]
  );

  useEffect(() => {
    const onUrl = () => {
      const path = projectUrl();
      if (path === lastPath.current) return;
      loadTabLibrary(path);
    };
    const onPopDocument = () => {
      ignoreDocumentHistory(() => {
        const doc = readOpenDocument(window.location.search);
        if (doc.kind === "world") openWorld(doc.path, { history: "replace" });
        else {
          void viewerStore
            .getState()
            .loadModel(doc.kind === "file" ? doc.path : "");
        }
      });
    };
    window.addEventListener("sfab-project", onUrl);
    window.addEventListener("popstate", onUrl);
    window.addEventListener("popstate", onPopDocument);
    return () => {
      window.removeEventListener("sfab-project", onUrl);
      window.removeEventListener("popstate", onUrl);
      window.removeEventListener("popstate", onPopDocument);
    };
  }, [loadTabLibrary]);

  useEffect(() => {
    const onOpen = (ev: Event) => {
      const path = (ev as CustomEvent<string>).detail;
      if (typeof path !== "string" || !path.trim()) return;
      void registerAndOpenTab(path)
        .then(() => {
          emitFolderError(null);
        })
        .catch((err: unknown) => {
          emitFolderError(
            redact(
              err instanceof Error ? err.message : "Could not open that folder"
            )
          );
        });
    };
    window.addEventListener("sfab-open-folder", onOpen);
    return () => window.removeEventListener("sfab-open-folder", onOpen);
  }, []);

  useEffect(() => {
    let closed = false;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    let current = INITIAL_CONNECTION_STATE;
    setLiveConnectionPhase(current.phase);

    const clearDownTimers = () => {
      if (graceTimer) clearTimeout(graceTimer);
      if (reloadTimer) clearTimeout(reloadTimer);
      graceTimer = null;
      reloadTimer = null;
    };

    const applyConnection = (event: ConnectionEvent) => {
      if (closed) return;
      const prev = current;
      const { state, notice } = reduceConnection(current, event);
      current = state;
      setLiveConnectionPhase(state.phase);
      setConnection(state);
      if (prev.phase !== "down" && state.phase === "down") {
        graceTimer = setTimeout(
          () => applyConnection({ type: "grace" }),
          CONNECTION_GRACE_MS
        );
        reloadTimer = setTimeout(
          () => applyConnection({ type: "reload" }),
          CONNECTION_RELOAD_AFTER_MS
        );
      }
      if (state.phase !== "down") clearDownTimers();
      if (notice === "lost") {
        closeToast("connection-reconnected");
        showToast({
          id: "connection-lost",
          type: "error",
          title: "Lost connection to this Mac",
          description: "This page can't reach the workbench process.",
        });
      } else if (notice === "reconnected") {
        closeToast("connection-lost");
        closeToast("connection-offline");
        showToast({
          id: "connection-reconnected",
          type: "success",
          title: "Reconnected",
        });
      }
    };

    const connect = () => {
      ws = new WebSocket(sessionWsUrl());
      ws.onmessage = (ev) => {
        if (closed) return;
        let event: SessionEvent;
        try {
          event = JSON.parse(String(ev.data)) as SessionEvent;
        } catch {
          return;
        }
        if (event.type === "snapshot") {
          applySnapshot(event.session);
          setReady(true);
          applyConnection({ type: "snapshot" });
          return;
        }
        if (event.type === "library") {
          if (event.project.path === projectUrl()) {
            adoptTab(event.project.path, event.fileRecents);
          }
        }
      };
      ws.onclose = () => {
        if (closed) return;
        setReady(false);
        applyConnection({ type: "close" });
        retry = setTimeout(connect, CONNECTION_RETRY_MS);
      };
    };

    connect();
    return () => {
      closed = true;
      clearDownTimers();
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  }, [applySnapshot, adoptTab]);

  const setDoc = useCallback(async (file: string | null, reload = false) => {
    const next = file ?? "";
    if (isWorldFilePath(next)) {
      const world = worldStore.getState();
      const failed =
        world.assetIssues.length > 0 ||
        Boolean(world.runMessage) ||
        world.runErrors.length > 0;
      if (!reload && !shouldReloadOpenFile(next, world.path, failed)) return;
      openWorld(next, { history: "push", force: reload || failed });
      return;
    }
    const { url, error, loadModel } = viewerStore.getState();
    if (!reload && next && !shouldReloadOpenFile(next, url, Boolean(error)))
      return;
    await loadModel(next, { history: "push" });
    if (file) {
      void jsonApi.recents.$post({ json: { path: file } });
    }
  }, []);

  const value = useMemo<SessionValue>(
    () => ({
      ready,
      you,
      project,
      fileRecents,
      connectionPhase: connection.phase,
      connectionLostShown: connection.lostShown,
      connectionOfferReload: connection.offerReload,
      setDoc,
    }),
    [
      ready,
      you,
      project,
      fileRecents,
      connection.phase,
      connection.lostShown,
      connection.offerReload,
      setDoc,
    ]
  );

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function useProjectSession() {
  const ctx = useContext(SessionContext);
  if (!ctx)
    throw new Error("useProjectSession requires ProjectSessionProvider");
  return ctx;
}
