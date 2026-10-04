import { Box, PanelRight, Scan } from "lucide-react";
import {
  type CSSProperties,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { fileLabel } from "@/cad/loadCadReview";
import {
  fitDirectionFor,
  frameFitObject,
  homeFitDirection,
} from "@/cad/review";
import { LiveDot } from "@/components/brand/LiveDot";
import { ChatPanel } from "@/components/ChatPanel";
import { CloseFolderDialog } from "@/components/CloseFolderDialog";
import { CommandPalette } from "@/components/CommandPalette";
import { CrashCard } from "@/components/CrashCard";
import {
  useViewerChat,
  ViewerChatProvider,
} from "@/components/chat/useViewerChat";
import { DesktopSidebar } from "@/components/DesktopSidebar";
import { DetailPanel } from "@/components/DetailPanel";
import { EmptyScene } from "@/components/EmptyScene";
import { BrowseFolderDialog, useOpenFolder } from "@/components/OpenFolder";
import { PairPage } from "@/components/PairPage";
import { PartTree } from "@/components/PartTree";
import { RenderErrorBoundary } from "@/components/RenderErrorBoundary";
import { Toolbar } from "@/components/Toolbar";
import { Button } from "@/components/ui/button";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { ToastProvider, Toasts } from "@/components/ui/toast";
import {
  WorldControls,
  WorldEditDialog,
  WorldProblemCard,
} from "@/components/WorldChrome";
import { WorldInspector } from "@/components/WorldInspector";
import { WorldTimeline } from "@/components/WorldTimeline";
import {
  WorldConfirmDialog,
  WorldHotkeys,
  WorldTopBar,
  WorldTree,
} from "@/components/WorldTree";
import { useCanvasFit } from "@/hooks/useCanvasFit";
import { type CatalogState, useCatalog } from "@/hooks/useCatalog";
import { useMotionReady } from "@/hooks/useMotionReady";
import {
  ProjectSessionProvider,
  useProjectSession,
} from "@/hooks/useProjectSession";
import { useWorldRun } from "@/hooks/useWorldRun";
import { useXrSession } from "@/hooks/useXrSession";
import { useXrSupport } from "@/hooks/useXrSupport";
import { fetchMe, jsonApi, type MePrincipal } from "@/lib/api";
import { filesRailToggleTitle } from "@/lib/files-rail";
import {
  chatLayoutWidth,
  detailPanelWidth,
  isCompactChat,
  overlayLayout,
  toolbarLayout,
  toolbarRightReserve,
  WORLD_PANELS_WIDTH,
} from "@/lib/layout";
import {
  displayLoadError,
  isUnavailableFolder,
  loadCardCopy,
} from "@/lib/load-copy";
import { redeemFragmentToken } from "@/lib/pairing";
import { folderName } from "@/lib/project";
import { isMacPlatform } from "@/lib/shortcuts";
import { documentTitle, emptySceneKind, PRODUCT_TITLE } from "@/lib/welcome";
import { ViewerCanvas } from "@/scene/ViewerCanvas";
import { worldFitTarget } from "@/scene/world-fit";
import { usePrefs } from "@/state/prefs";
import { useScene } from "@/state/scene";
import { useViewer } from "@/state/viewer";
import { useWorld } from "@/state/world";
import { worldCaptureHandlers } from "@/state/world-capture";
import { useXrUi } from "@/state/xr";
import { enterAR, enterVR } from "@/xrStore";

const BOOT_ME_TIMEOUT_MS = 4_000;

function useWindowWidth() {
  const [width, setWidth] = useState(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth
  );
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

function ChatToggle({
  compact,
  buttonRef,
  hidden,
}: {
  compact: boolean;
  buttonRef: RefObject<HTMLButtonElement | null>;
  hidden?: boolean;
}) {
  const setChatOpen = usePrefs((s) => s.setChatOpen);
  const setCompactChatOpen = usePrefs((s) => s.setCompactChatOpen);
  const { tabStreaming, stopTabTurn } = useViewerChat();
  const show = () => (compact ? setCompactChatOpen(true) : setChatOpen(true));
  if (tabStreaming) {
    return (
      <div className="pointer-events-auto flex items-center gap-1.5 rounded-xl border border-border bg-card/95 px-2 py-1 text-xs shadow-lg">
        <LiveDot className="animate-pulse" />
        <span>Replying…</span>
        <span className="text-muted-foreground">·</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-xs"
          tabIndex={hidden ? -1 : undefined}
          aria-hidden={hidden || undefined}
          onClick={stopTabTurn}
        >
          Stop
        </Button>
        <span className="text-muted-foreground">·</span>
        <Button
          ref={buttonRef}
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-xs"
          title="Show chat"
          aria-label="Show chat"
          tabIndex={hidden ? -1 : undefined}
          aria-hidden={hidden || undefined}
          onClick={show}
        >
          Show chat
        </Button>
      </div>
    );
  }
  return (
    <div className="pointer-events-auto rounded-xl border border-border bg-card/95 shadow-lg">
      <Button
        ref={buttonRef}
        type="button"
        variant="ghost"
        size="icon-sm"
        className="h-9 w-9"
        title="Show chat"
        aria-label="Show chat"
        tabIndex={hidden ? -1 : undefined}
        aria-hidden={hidden || undefined}
        onClick={show}
      >
        <PanelRight />
      </Button>
    </div>
  );
}

function EnterXr() {
  const { ar, vr, ready } = useXrSupport();
  if (!ready || (!ar && !vr)) return null;
  const studio = vr;
  return (
    <div className="pointer-events-auto rounded-xl border border-border bg-card/95 p-1 shadow-lg">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-9"
        onClick={() => void (studio ? enterVR() : enterAR())}
      >
        {studio ? <Box /> : <Scan />}
        {studio ? "Enter Studio" : "Enter AR"}
      </Button>
    </div>
  );
}

function Overlay({
  folder,
  catalog,
  canvasWidth,
  canvasHeight,
  compactChat,
  chatToggleRef,
}: {
  folder: ReturnType<typeof useOpenFolder>;
  catalog: CatalogState;
  canvasWidth: number;
  canvasHeight: number;
  compactChat: boolean;
  chatToggleRef: RefObject<HTMLButtonElement | null>;
}) {
  const { review, progress, error, selectedId, url, title, loadModel } =
    useViewer(
      useShallow((s) => ({
        review: s.review,
        progress: s.progress,
        error: s.error,
        selectedId: s.selectedId,
        url: s.url,
        title: s.title,
        loadModel: s.loadModel,
      }))
    );
  const { fit, sceneCrash } = useScene(
    useShallow((s) => ({
      fit: s.fit,
      sceneCrash: s.sceneCrash,
    }))
  );
  const session = useXrSession();
  const { project } = useProjectSession();
  const worldPath = useWorld((s) => s.path);
  const { files, ready: catalogReady, error: catalogError } = catalog;
  const treeOpen = usePrefs((s) => s.treeOpen);
  const chatOpen = usePrefs((s) => s.chatOpen);
  const compactChatOpen = usePrefs((s) => s.compactChatOpen);
  const partsOpen = usePrefs((s) => s.partsOpen);
  const setPartsOpen = usePrefs((s) => s.setPartsOpen);
  const tool = useViewer((s) => s.tool);
  const pickedRef = useViewer((s) => s.pickedRef);
  const switching = useXrUi((s) => s.switching);
  const folderGone = isUnavailableFolder(catalogError);
  const load =
    progress !== null ? loadCardCopy({ title, url, progress }) : null;
  const scene = emptySceneKind({
    hasReview: Boolean(review) || Boolean(worldPath),
    progress,
    loadError: Boolean(error),
    sceneCrash: Boolean(sceneCrash),
    projectPath: project.path,
    treeOpen,
    catalogReady,
    hasCad: files.length > 0,
    folderGone,
  });
  const toolbarVisible = Boolean(review) || progress !== null;
  const [partsForceExpand, setPartsForceExpand] = useState(false);
  const overlays = overlayLayout(canvasWidth);
  useEffect(() => {
    if (!overlays.autoCollapseParts) setPartsForceExpand(false);
  }, [overlays.autoCollapseParts]);
  const partsExpanded =
    Boolean(review) &&
    partsOpen &&
    (!overlays.autoCollapseParts || partsForceExpand);
  const partsChip = Boolean(review) && !partsExpanded;
  const part = selectedId !== null ? review?.parts[selectedId] : undefined;
  const worldOpen = Boolean(worldPath);
  const detailVisible =
    worldOpen ||
    (Boolean(review) &&
      (tool === "measure" || Boolean(part) || Boolean(pickedRef)));
  const detailWidth = detailVisible
    ? detailPanelWidth(canvasWidth, overlays.detailCompact, partsChip)
    : 0;
  const showChatToggle =
    Boolean(project.path) && (compactChat ? !compactChatOpen : !chatOpen);
  const { tabStreaming } = useViewerChat();
  const { ar, vr, ready: xrReady } = useXrSupport();
  const enterXr = xrReady && (ar || vr);
  const leftReserve = treeOpen ? 12 : 52;
  const rightReserve = toolbarRightReserve(
    showChatToggle,
    Boolean(enterXr),
    showChatToggle && tabStreaming
  );
  const toolbar = toolbarLayout({ canvasWidth, leftReserve, rightReserve });
  const cameraMoved = useViewer((s) => s.cameraMoved);
  const { setPartsCard, setDetailCard } = useCanvasFit({
    xrActive: Boolean(session),
    review,
    url,
    fit,
    cameraMoved,
    canvasWidth,
    canvasHeight,
    partsExpanded,
    partsChip,
    detailVisible,
    detailWidth,
  });

  if (switching) {
    return (
      <div className="pointer-events-auto absolute inset-0 z-50 flex items-center justify-center bg-background text-foreground">
        <div className="text-center">
          <div className="text-base font-medium">
            {switching === "ar"
              ? "Switching to passthrough…"
              : "Switching to Studio…"}
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
            Stay in this tab
          </div>
        </div>
      </div>
    );
  }
  return (
    <>
      {!session && (
        <>
          {!treeOpen ? (
            <div className="pointer-events-auto absolute top-4 left-3 z-10 flex flex-col items-start gap-2">
              <div className="rounded-xl border border-border bg-card/95 shadow-lg">
                <SidebarTrigger
                  className="h-9 w-9"
                  title={filesRailToggleTitle(
                    isMacPlatform(navigator.platform, navigator.userAgent),
                    "show"
                  )}
                />
              </div>
              {folder.error && scene === "none" ? (
                <p className="max-w-xs rounded-md border border-destructive/40 bg-card/95 px-2 py-1 text-xs text-error">
                  {folder.error}
                </p>
              ) : null}
            </div>
          ) : null}
          {worldPath ? (
            <WorldControls
              left={toolbar.left}
              top={toolbar.top}
              onHome={() => {
                const obj = worldFitTarget();
                if (obj) fit?.(obj, homeFitDirection());
              }}
            />
          ) : toolbarVisible ? (
            <Toolbar
              left={toolbar.left}
              top={toolbar.top}
              onHome={() => {
                const obj = frameFitObject(review, selectedId, "model");
                if (obj) fit?.(obj, fitDirectionFor("model"));
              }}
              onFit={() => {
                const obj = frameFitObject(review, selectedId, "selection");
                if (obj) fit?.(obj, fitDirectionFor("selection"));
              }}
            />
          ) : null}
          {!worldOpen ? (
            <PartTree
              canvasHeight={canvasHeight}
              cardRef={setPartsCard}
              expanded={partsExpanded}
              onCollapse={() => {
                setPartsOpen(false);
                setPartsForceExpand(false);
              }}
              onExpand={() => {
                setPartsOpen(true);
                setPartsForceExpand(true);
              }}
            />
          ) : null}
          {!worldOpen ? (
            <DetailPanel
              canvasHeight={canvasHeight}
              cardRef={setDetailCard}
              compact={overlays.detailCompact}
              width={detailWidth}
            />
          ) : null}
          <div className="pointer-events-none absolute top-4 right-3 z-10 flex items-start gap-2">
            <EnterXr />
            {project.path ? (
              <div
                className={
                  showChatToggle ? undefined : "pointer-events-none sr-only"
                }
                aria-hidden={showChatToggle ? undefined : true}
              >
                <ChatToggle
                  buttonRef={chatToggleRef}
                  compact={compactChat}
                  hidden={!showChatToggle}
                />
              </div>
            ) : null}
          </div>
        </>
      )}
      {!session && scene !== "none" ? (
        <EmptyScene folder={folder} scene={scene} />
      ) : null}
      {progress !== null && load && !sceneCrash && (
        <div className="pointer-events-none absolute inset-x-4 top-1/2 z-20 mx-auto w-full max-w-72 -translate-y-1/2 rounded-xl border border-border bg-card/95 p-4 text-center shadow-lg">
          <strong className="inline-flex items-center gap-2 text-sm">
            <LiveDot />
            {load.title}
          </strong>
          <div className="mt-1 text-xs text-muted-foreground">
            {load.detail}
          </div>
          {load.percent === null ? (
            <Spinner className="mx-auto mt-3" />
          ) : (
            <div className="mt-2 h-1 overflow-hidden rounded bg-muted">
              <div
                className="h-full bg-brand"
                style={{ width: `${load.percent}%` }}
              />
            </div>
          )}
        </div>
      )}
      {error && !sceneCrash && (
        <div className="pointer-events-auto absolute inset-x-4 top-1/2 z-20 mx-auto w-full max-w-80 -translate-y-1/2 rounded-xl border border-destructive bg-card p-4 text-sm shadow-lg">
          <strong>Couldn&apos;t open {title}</strong>
          <div className="mt-1 text-error">
            {displayLoadError(error, project.path)}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={() => void loadModel(url)}>
              Retry
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void loadModel("")}
            >
              Close
            </Button>
          </div>
        </div>
      )}
      {!session ? <WorldProblemCard /> : null}
      {sceneCrash ? (
        <div className="pointer-events-auto absolute inset-x-4 top-1/2 z-30 mx-auto flex max-w-80 justify-center">
          <CrashCard error={sceneCrash.error} onRetry={sceneCrash.reset} />
        </div>
      ) : null}
    </>
  );
}

function ViewerShell({ host }: { host: boolean }) {
  const session = useXrSession();
  const treeOpen = usePrefs((s) => s.treeOpen);
  const setTreeOpen = usePrefs((s) => s.setTreeOpen);
  const url = useViewer((s) => s.url);
  const worldPath = useWorld((s) => s.path);
  const folder = useOpenFolder(host);
  const projectPath = useProjectSession().project.path;
  useWorldRun(projectPath, worldPath, worldCaptureHandlers);
  const hasProject = Boolean(projectPath);
  const chatWidth = usePrefs((s) => s.chatWidth);
  const chatOpen = usePrefs((s) => s.chatOpen);
  const setChatOpen = usePrefs((s) => s.setChatOpen);
  const compactChatOpen = usePrefs((s) => s.compactChatOpen);
  const setCompactChatOpen = usePrefs((s) => s.setCompactChatOpen);
  const windowWidth = useWindowWidth();
  const editor = Boolean(worldPath) && !session;
  const panels = editor ? WORLD_PANELS_WIDTH : 0;
  const compactChat = isCompactChat(windowWidth, treeOpen, panels);
  const layoutWidth = chatLayoutWidth(chatWidth, windowWidth, treeOpen, panels);
  const catalog = useCatalog(hasProject);
  const canvasRef = useRef<HTMLDivElement>(null);
  const chatToggleRef = useRef<HTMLButtonElement>(null);
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    if (!compactChat) setCompactChatOpen(false);
  }, [compactChat, setCompactChatOpen]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      setCanvasSize({ w: rect.width, h: rect.height });
    });
    ro.observe(el);
    setCanvasSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [editor]);

  useEffect(() => {
    const shown = worldPath || url;
    const file = shown ? fileLabel(shown) : "";
    document.title = documentTitle({
      folderName: projectPath ? folderName(projectPath) : null,
      fileName: file && file !== "No model" ? file : null,
    });
    return () => {
      document.title = PRODUCT_TITLE;
    };
  }, [projectPath, url, worldPath]);
  return (
    <SidebarProvider
      className="h-dvh min-h-0 overflow-hidden"
      open={treeOpen}
      onOpenChange={setTreeOpen}
      style={{ "--sidebar-width": "19rem" } as CSSProperties}
    >
      {!session ? (
        <DesktopSidebar catalog={catalog} host={host} folder={folder} />
      ) : null}
      <SidebarInset className="min-h-0 overflow-hidden">
        {editor ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <WorldTopBar />
            <div className="flex min-h-0 min-w-0 flex-1">
              <WorldTree />
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <div
                  ref={canvasRef}
                  className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
                >
                  <RenderErrorBoundary
                    resetKeys={[url]}
                    fallback={({ error, reset }) => (
                      <div className="absolute inset-0 z-10 grid place-items-center bg-studio">
                        <CrashCard error={error} onRetry={reset} />
                      </div>
                    )}
                  >
                    <ViewerCanvas />
                  </RenderErrorBoundary>
                  <Overlay
                    canvasHeight={canvasSize.h}
                    canvasWidth={canvasSize.w}
                    catalog={catalog}
                    chatToggleRef={chatToggleRef}
                    compactChat={compactChat}
                    folder={folder}
                  />
                </div>
                <WorldTimeline docked />
              </div>
              <WorldInspector />
            </div>
            <WorldHotkeys />
            <WorldConfirmDialog />
            <WorldEditDialog />
          </div>
        ) : (
          <div
            ref={canvasRef}
            className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
          >
            <RenderErrorBoundary
              resetKeys={[url]}
              fallback={({ error, reset }) => (
                <div className="absolute inset-0 z-10 grid place-items-center bg-studio">
                  <CrashCard error={error} onRetry={reset} />
                </div>
              )}
            >
              <ViewerCanvas />
            </RenderErrorBoundary>
            <Overlay
              canvasHeight={canvasSize.h}
              canvasWidth={canvasSize.w}
              catalog={catalog}
              chatToggleRef={chatToggleRef}
              compactChat={compactChat}
              folder={folder}
            />
          </div>
        )}
      </SidebarInset>
      {!session && hasProject ? (
        <RenderErrorBoundary
          resetKeys={[projectPath]}
          fallback={({ error, reset }) => (
            <aside
              className="flex h-full shrink-0 items-center justify-center border-l border-border bg-background p-4"
              style={{ width: layoutWidth }}
            >
              <CrashCard error={error} onRetry={reset} />
            </aside>
          )}
        >
          <ChatPanel
            compact={compactChat}
            open={compactChat ? compactChatOpen : chatOpen}
            toggleRef={chatToggleRef}
            panels={panels}
            width={layoutWidth}
            onClose={() =>
              compactChat ? setCompactChatOpen(false) : setChatOpen(false)
            }
          />
        </RenderErrorBoundary>
      ) : null}
      {!session ? (
        <>
          <BrowseFolderDialog
            open={folder.dialogOpen}
            onOpenChange={folder.setDialogOpen}
          />
          <CloseFolderDialog />
          <CommandPalette
            catalogFiles={catalog.files}
            compactChat={compactChat}
            folder={folder}
          />
          <Toasts />
        </>
      ) : null}
    </SidebarProvider>
  );
}

function ViewerApp({
  host,
  you,
}: {
  host: boolean;
  you: { id: string; label: string };
}) {
  useEffect(() => {
    const onSelect = (ev: Event) => ev.preventDefault();
    document.addEventListener("beforexrselect", onSelect);
    return () => document.removeEventListener("beforexrselect", onSelect);
  }, []);
  return (
    <ToastProvider>
      <ProjectSessionProvider you={you}>
        <ViewerChatProvider>
          <ViewerShell host={host} />
        </ViewerChatProvider>
      </ProjectSessionProvider>
    </ToastProvider>
  );
}

async function probeMe(): Promise<
  { me: MePrincipal } | { reason: "unauth" | "down" }
> {
  try {
    const res = await jsonApi.me.$get();
    if (!res.ok) return { reason: "unauth" };
    const body = await res.json();
    const me = (body.principal ?? null) as MePrincipal | null;
    if (!me) return { reason: "unauth" };
    return { me };
  } catch {
    return { reason: "down" };
  }
}

export function App() {
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [host, setHost] = useState(false);
  const [you, setYou] = useState<{ id: string; label: string }>({
    id: "loopback",
    label: "Mac",
  });
  const [bootStuck, setBootStuck] = useState(false);
  useMotionReady(!ready ? "boot" : authed ? "workbench" : "pair");

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (!cancelled) setBootStuck(true);
    }, BOOT_ME_TIMEOUT_MS);
    void (async () => {
      try {
        await redeemFragmentToken();
      } catch {
        /* pair page will explain a bad fragment */
      }
      const result = await probeMe();
      if (cancelled) return;
      window.clearTimeout(timer);
      if ("me" in result) {
        setAuthed(true);
        setHost(result.me.kind === "loopback");
        setYou(youFromMe(result.me));
        setReady(true);
        return;
      }
      if (result.reason === "unauth") {
        setAuthed(false);
        setReady(true);
        const path = window.location.pathname;
        if (path !== "/pair" && path !== "/pair/") {
          window.history.replaceState(
            null,
            "",
            "/pair" + window.location.search
          );
        }
        return;
      }
      setBootStuck(true);
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  if (!ready) {
    return (
      <div className="grid h-dvh place-items-center bg-studio px-4 text-sm text-muted-foreground">
        {bootStuck ? (
          <div className="flex max-w-sm flex-col items-center gap-3 text-center">
            <p className="text-base font-medium text-foreground">
              Couldn&apos;t reach this Mac
            </p>
            <p>
              This page didn&apos;t get a response from the workbench process.
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => window.location.reload()}
            >
              Reload
            </Button>
          </div>
        ) : (
          <span className="inline-flex items-center gap-2">
            <LiveDot />
            Loading…
          </span>
        )}
      </div>
    );
  }
  if (!authed)
    return (
      <PairPage
        onPaired={() => {
          void fetchMe().then((me) => {
            setAuthed(me != null);
            setHost(me?.kind === "loopback");
            setYou(youFromMe(me));
          });
        }}
      />
    );
  return <ViewerApp host={host} you={you} />;
}

function youFromMe(me: MePrincipal | null): { id: string; label: string } {
  if (!me || me.kind === "loopback") return { id: "loopback", label: "Mac" };
  return { id: me.deviceId, label: me.label || "Quest" };
}
