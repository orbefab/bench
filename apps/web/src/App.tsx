import { PanelRight } from "lucide-react";
import {
  type ReactNode,
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
import { HomeProjects } from "@/components/HomeProjects";
import { InsetHeader } from "@/components/InsetHeader";
import { BrowseFolderDialog, useOpenFolder } from "@/components/OpenFolder";
import { PairPage } from "@/components/PairPage";
import { PartTree } from "@/components/PartTree";
import { RenderErrorBoundary } from "@/components/RenderErrorBoundary";
import { Toolbar } from "@/components/Toolbar";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Shell, ShellInset } from "@/components/ui/shell";
import { useSidebar } from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { ToastProvider, Toasts } from "@/components/ui/toast";
import {
  WorldControls,
  WorldEditDialog,
  WorldProblemCard,
} from "@/components/WorldChrome";
import { WorldInspector } from "@/components/WorldInspector";
import { PartParkDialog } from "@/components/WorldPartTabs";
import { WorldTimeline } from "@/components/WorldTimeline";
import {
  WorldConfirmDialog,
  WorldHotkeys,
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
import { fetchMe, jsonApi, type MePrincipal } from "@/lib/api";
import {
  detailPanelWidth,
  OVERLAY_LEFT,
  overlayLayout,
  preferredChatWidth,
  TOOLBAR_WIDTH,
  toolbarLayout,
  toolbarRightReserve,
  WORLD_FLOAT_RIGHT,
  WORLD_TOOLBAR_WIDTH,
} from "@/lib/layout";
import {
  displayLoadError,
  isUnavailableFolder,
  loadCardCopy,
} from "@/lib/load-copy";
import { redeemFragmentToken } from "@/lib/pairing";
import { folderName } from "@/lib/project";
import { cn } from "@/lib/utils";
import { documentTitle, emptySceneKind, PRODUCT_TITLE } from "@/lib/welcome";
import { ViewerCanvas } from "@/scene/ViewerCanvas";
import { worldFitTarget } from "@/scene/world-fit";
import { usePrefs } from "@/state/prefs";
import { useScene } from "@/state/scene";
import { studioNavStore, useStudioNav } from "@/state/studio-nav";
import { useViewer } from "@/state/viewer";
import { useWorld } from "@/state/world";
import { worldCaptureHandlers } from "@/state/world-capture";
import { useXrUi } from "@/state/xr";

const BOOT_ME_TIMEOUT_MS = 4_000;

function ChatToggle({
  buttonRef,
  hidden,
}: {
  buttonRef: RefObject<HTMLButtonElement | null>;
  hidden?: boolean;
}) {
  const setChatOpen = usePrefs((s) => s.setChatOpen);
  const { tabStreaming, stopTabTurn } = useViewerChat();
  const show = () => setChatOpen(true);
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

type ToolbarPlace = { left: number; top: number } | null;

function useChromePlacement(
  canvasWidth: number,
  bar: "world" | "cad",
  docked: boolean
): ToolbarPlace & { stacked: boolean } {
  const chatOpen = usePrefs((s) => s.chatOpen);
  const projectPath = useProjectSession().project.path;
  const { tabStreaming } = useViewerChat();
  const showChatToggle = Boolean(projectPath) && !docked && !chatOpen;
  if (!(canvasWidth > 0)) return { stacked: false, left: 0, top: 0 };
  const placed = toolbarLayout({
    canvasWidth,
    leftReserve: bar === "world" ? WORLD_FLOAT_RIGHT : OVERLAY_LEFT,
    rightReserve: toolbarRightReserve(
      showChatToggle,
      false,
      showChatToggle && tabStreaming
    ),
    barWidth: bar === "world" ? WORLD_TOOLBAR_WIDTH : TOOLBAR_WIDTH,
  });
  return placed;
}

function Overlay({
  folder,
  catalog,
  canvasWidth,
  canvasHeight,
  docked,
  chatToggleRef,
  railOpen,
  toolbarPlace,
}: {
  folder: ReturnType<typeof useOpenFolder>;
  catalog: CatalogState;
  canvasWidth: number;
  canvasHeight: number;
  docked: boolean;
  chatToggleRef: RefObject<HTMLButtonElement | null>;
  railOpen: boolean;
  toolbarPlace: ToolbarPlace;
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
  const chatOpen = usePrefs((s) => s.chatOpen);
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
    treeOpen: railOpen,
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
  const showChatToggle = Boolean(project.path) && !docked && !chatOpen;
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
          {folder.error && scene === "none" ? (
            <p className="pointer-events-auto absolute top-4 left-3 z-10 max-w-xs rounded-md border border-destructive/40 bg-card/95 px-2 py-1 text-xs text-error">
              {folder.error}
            </p>
          ) : null}
          {worldPath ? (
            <WorldControls
              layout={toolbarPlace}
              onHome={() => {
                const obj = worldFitTarget();
                if (obj) fit?.(obj, homeFitDirection());
              }}
            />
          ) : toolbarVisible ? (
            <Toolbar
              layout={toolbarPlace}
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
            {project.path ? (
              <div
                className={
                  showChatToggle ? undefined : "pointer-events-none sr-only"
                }
                aria-hidden={showChatToggle ? undefined : true}
              >
                <ChatToggle
                  buttonRef={chatToggleRef}
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

function WorldFloatColumn({ stacked }: { stacked: boolean }) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute left-3 z-20 flex w-80 max-w-[calc(100%-1.5rem)] flex-col gap-2",
        stacked ? "top-16 h-[calc(100%-5rem)]" : "top-4 h-[calc(100%-2rem)]"
      )}
    >
      <WorldTree floating />
      <WorldInspector floating />
    </div>
  );
}

function StageColumn({
  folder,
  catalog,
  docked,
  chatToggleRef,
  railOpen,
  editor,
  overlay,
}: {
  folder: ReturnType<typeof useOpenFolder>;
  catalog: CatalogState;
  docked: boolean;
  chatToggleRef: RefObject<HTMLButtonElement | null>;
  railOpen: boolean;
  editor: boolean;
  overlay?: ReactNode;
}) {
  const session = useXrSession();
  const url = useViewer((s) => s.url);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });
  const placement = useChromePlacement(
    canvasSize.w,
    editor ? "world" : "cad",
    docked
  );
  const toolbarPlace: ToolbarPlace =
    canvasSize.w > 0 ? { left: placement.left, top: placement.top } : null;

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

  const stage = (
    <div
      ref={canvasRef}
      className="@container/stage relative min-h-0 min-w-0 flex-1 overflow-hidden"
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
      {editor && !session ? (
        <WorldFloatColumn stacked={canvasSize.w > 0 && placement.stacked} />
      ) : null}
      <Overlay
        canvasHeight={canvasSize.h}
        canvasWidth={canvasSize.w}
        catalog={catalog}
        chatToggleRef={chatToggleRef}
        docked={docked}
        folder={folder}
        railOpen={railOpen}
        toolbarPlace={toolbarPlace}
      />
      {overlay}
    </div>
  );

  if (!editor) return stage;
  if (session) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 min-w-0 flex-1">
          <WorldTree />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {stage}
            <WorldTimeline docked />
          </div>
          <WorldInspector />
        </div>
        <WorldHotkeys />
        <WorldConfirmDialog />
        <WorldEditDialog />
      </div>
    );
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {stage}
      <WorldTimeline docked framed />
      <WorldHotkeys />
      <WorldConfirmDialog />
      <WorldEditDialog />
    </div>
  );
}

function DesktopWorkbench({
  folder,
  catalog,
}: {
  folder: ReturnType<typeof useOpenFolder>;
  catalog: CatalogState;
}) {
  const { open: railOpen } = useSidebar();
  const projectPath = useProjectSession().project.path;
  const worldPath = useWorld((s) => s.path);
  const atHome = useStudioNav((s) => s.atHome);
  const hasProject = Boolean(projectPath);
  const showStudio = hasProject && !atHome;
  const chatWidth = usePrefs((s) => s.chatWidth);
  const chatOpen = usePrefs((s) => s.chatOpen);
  const setChatOpen = usePrefs((s) => s.setChatOpen);
  const chatDock = usePrefs((s) => s.chatDock);
  const setChatDock = usePrefs((s) => s.setChatDock);
  const editor = Boolean(worldPath) && showStudio;
  const width = preferredChatWidth(chatWidth);
  const chatToggleRef = useRef<HTMLButtonElement>(null);
  const docked = showStudio && chatDock === "docked";

  const dockChat = () => {
    setChatOpen(true);
    setChatDock("docked");
  };
  const floatChat = () => setChatDock("popup");

  const floatingChat =
    showStudio && !docked ? (
      <ChatPanel
        open={chatOpen}
        toggleRef={chatToggleRef}
        width={width}
        onClose={() => setChatOpen(false)}
      />
    ) : null;

  const stage = (
    <StageColumn
      catalog={catalog}
      chatToggleRef={chatToggleRef}
      docked={docked}
      editor={editor}
      folder={folder}
      overlay={floatingChat}
      railOpen={railOpen}
    />
  );

  const header = (pressed: boolean) => (
    <InsetHeader
      docked={pressed}
      path={projectPath}
      showDockToggle={showStudio}
      onToggleDock={pressed ? floatChat : dockChat}
    />
  );

  return (
    <>
      <ShellInset
        className={
          showStudio && !docked
            ? "min-h-0 overflow-hidden bg-studio"
            : "min-h-0 overflow-hidden bg-background"
        }
      >
        {showStudio ? (
          // The group stays mounted across popup and docked. Only the chat
          // panel comes and goes, so the canvas and the cards keep their state.
          <ResizablePanelGroup
            className="min-h-0 flex-1"
            orientation="horizontal"
          >
            <ResizablePanel
              className="flex min-h-0 flex-col overflow-hidden"
              defaultSize={docked ? "68%" : "100%"}
              id="viewer"
              minSize={docked ? "45%" : "0%"}
            >
              <div
                data-slot="viewer-pane"
                className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-studio"
              >
                {header(docked)}
                <PartParkDialog />
                {stage}
              </div>
            </ResizablePanel>
            {docked ? <ResizableHandle className="bg-transparent" /> : null}
            {docked ? (
              <ResizablePanel
                className="flex min-h-0 flex-col overflow-hidden"
                defaultSize="32%"
                id="chat"
                maxSize="55%"
                minSize="22%"
              >
                <div
                  data-slot="chat-side-panel"
                  className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden border-l border-border bg-background"
                >
                  <ChatPanel
                    docked
                    open
                    toggleRef={chatToggleRef}
                    width={width}
                    onClose={floatChat}
                  />
                </div>
              </ResizablePanel>
            ) : null}
          </ResizablePanelGroup>
        ) : (
          <>
            {header(false)}
            <HomeProjects folder={folder} path={projectPath} />
          </>
        )}
      </ShellInset>
      <BrowseFolderDialog
        open={folder.dialogOpen}
        onOpenChange={folder.setDialogOpen}
      />
      <CloseFolderDialog />
      <CommandPalette catalogFiles={catalog.files} folder={folder} />
      <Toasts />
    </>
  );
}

function ViewerShell({ host }: { host: boolean }) {
  const session = useXrSession();
  const url = useViewer((s) => s.url);
  const worldPath = useWorld((s) => s.path);
  const folder = useOpenFolder(host);
  const projectPath = useProjectSession().project.path;
  useWorldRun(projectPath, worldPath, worldCaptureHandlers);
  const hasProject = Boolean(projectPath);
  const catalog = useCatalog(hasProject);
  const chatToggleRef = useRef<HTMLButtonElement>(null);
  const pathRef = useRef(projectPath);

  useEffect(() => {
    if (!projectPath) studioNavStore.getState().showHome();
    else if (projectPath !== pathRef.current) {
      studioNavStore.getState().showStudio();
    }
    pathRef.current = projectPath;
  }, [projectPath]);

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

  if (session) {
    return (
      <div className="flex h-dvh min-h-0 w-full flex-col">
        <StageColumn
          catalog={catalog}
          chatToggleRef={chatToggleRef}
          docked={false}
          editor={Boolean(worldPath)}
          folder={folder}
          railOpen={false}
        />
      </div>
    );
  }

  return (
    <Shell
      defaultOpen={false}
      sidebar={<DesktopSidebar catalog={catalog} folder={folder} host={host} />}
    >
      <DesktopWorkbench catalog={catalog} folder={folder} />
    </Shell>
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
