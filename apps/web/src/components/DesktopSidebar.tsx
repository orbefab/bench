import type { ProjectRow } from "@sfab-bench/contract";
import { Folder, Headset, Home, Plus, RefreshCw, Search } from "lucide-react";
import { useEffect, useState } from "react";

import { LogoDots } from "@/components/brand/LogoDots";
import { ConnectionStatusDot } from "@/components/ConnectionStatusDot";
import { FileTree } from "@/components/FileTree";
import type { OpenFolderApi } from "@/components/OpenFolder";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { WorkbenchSettings } from "@/components/WorkbenchSettings";
import type { CatalogState } from "@/hooks/useCatalog";
import { useEnterStudio } from "@/hooks/useEnterStudio";
import { useProjectSession } from "@/hooks/useProjectSession";
import {
  commandPaletteShortcutLabel,
  requestOpenCommandPalette,
  requestOpenQuest,
} from "@/lib/command-palette";
import { homeFolderList } from "@/lib/home-projects";
import { refreshFilesTooltip } from "@/lib/motion";
import { fetchProject, folderName } from "@/lib/project";
import { redact } from "@/lib/redact";
import {
  isMacPlatform,
  matchesShortcut,
  shortcutTooltip,
} from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { usePrefs } from "@/state/prefs";
import { useStudioNav } from "@/state/studio-nav";
import { useViewer } from "@/state/viewer";
import { useWorld } from "@/state/world";

export function DesktopSidebar({
  host,
  folder,
  catalog,
}: {
  host: boolean;
  folder: OpenFolderApi;
  catalog: CatalogState;
}) {
  const url = useViewer((s) => s.url);
  const worldPath = useWorld((s) => s.path);
  const currentPath = worldPath || url;
  const recentFiles = usePrefs((s) => s.recentFiles);
  const {
    project,
    setDoc,
    connectionPhase,
    connectionLostShown,
    connectionOfferReload,
  } = useProjectSession();
  const atHome = useStudioNav((state) => state.atHome);
  const showHome = useStudioNav((state) => state.showHome);
  const showStudio = useStudioNav((state) => state.showStudio);
  const { files, error, ready, refreshing, reload } = catalog;
  const [filter, setFilter] = useState("");
  const [recents, setRecents] = useState<ProjectRow[]>([]);
  const [currentName, setCurrentName] = useState("");
  const [listError, setListError] = useState<string | null>(null);
  const mac = isMacPlatform(
    typeof navigator === "undefined" ? "" : navigator.platform,
    typeof navigator === "undefined" ? "" : navigator.userAgent
  );
  const { toggleSidebar } = useSidebar();
  const studio = useEnterStudio();
  const path = project.path;
  const headsetLabel = host
    ? "Pair Quest"
    : studio.mode === "ar"
      ? "Enter AR"
      : "Enter Studio";
  const headsetTitle = host || studio.available ? headsetLabel : studio.title;

  useEffect(() => {
    let cancelled = false;
    void fetchProject()
      .then((info) => {
        if (cancelled) return;
        setRecents(info.recents);
        setCurrentName(info.project?.name ?? "");
        setListError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setListError(
          redact(err instanceof Error ? err.message : "Could not load folders")
        );
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        !matchesShortcut(event, "toggle-files", {
          mac,
          activeElement: document.activeElement,
        })
      )
        return;
      event.preventDefault();
      toggleSidebar();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mac, toggleSidebar]);

  const projects = homeFolderList(
    path ? { path, name: currentName || folderName(path) } : null,
    recents
  );

  const openProject = (next: string) => {
    if (next === path) {
      showStudio();
      return;
    }
    folder.pickRecent(next);
  };

  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem className="flex items-center gap-2">
            <div className="flex size-8 shrink-0 items-center justify-center">
              <LogoDots aria-hidden className="size-5 text-foreground" />
            </div>
            <SidebarMenuButton
              className="ml-auto size-8 group-data-[collapsible=icon]:hidden"
              title="Search"
              onClick={() => requestOpenCommandPalette()}
            >
              <Search />
              <span className="sr-only">Search</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent className="overflow-x-hidden">
        <SidebarGroup>
          <SidebarGroupLabel>Menu</SidebarGroupLabel>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={atHome || !path}
                title="Home"
                onClick={showHome}
              >
                <Home />
                <span>Home</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup className="min-h-0 group-data-[collapsible=icon]:hidden">
          <SidebarGroupLabel>Projects</SidebarGroupLabel>
          {folder.canRegister ? (
            <SidebarGroupAction
              aria-label="Open folder"
              title="Open folder"
              onClick={() => void folder.requestOpen()}
            >
              <Plus />
            </SidebarGroupAction>
          ) : null}
          <SidebarGroupContent>
            <SidebarMenu>
              {projects.length === 0 ? (
                <SidebarMenuItem>
                  <span className="px-2 py-1.5 text-muted-foreground text-sm">
                    No projects yet
                  </span>
                </SidebarMenuItem>
              ) : (
                projects.map((row) => {
                  const active = !atHome && row.path === path;
                  return (
                    <SidebarMenuItem key={row.path}>
                      <SidebarMenuButton
                        isActive={active}
                        title={row.path}
                        onClick={() => openProject(row.path)}
                      >
                        <Folder />
                        <span>{row.name}</span>
                      </SidebarMenuButton>
                      {active ? (
                        <div className="mt-1 flex flex-col gap-1 px-1 pb-2">
                          {folder.error ? (
                            <p className="px-1 text-error text-xs">
                              {folder.error}
                            </p>
                          ) : null}
                          <div className="flex items-center gap-1">
                            <SidebarInput
                              className="min-w-0 flex-1"
                              placeholder={`Search files… ${commandPaletteShortcutLabel(mac)}`}
                              title={shortcutTooltip(
                                "Command palette",
                                "command-palette",
                                mac
                              )}
                              aria-label="Search files"
                              value={filter}
                              onChange={(ev) => setFilter(ev.target.value)}
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              className="size-8 shrink-0"
                              title={refreshFilesTooltip(refreshing)}
                              aria-label={refreshFilesTooltip(refreshing)}
                              aria-busy={refreshing || undefined}
                              onClick={() => reload({ explicit: true })}
                            >
                              <RefreshCw
                                className={cn(
                                  "size-3.5",
                                  refreshing && "animate-spin"
                                )}
                              />
                            </Button>
                          </div>
                          <FileTree
                            key={path}
                            projectPath={path}
                            files={files}
                            current={currentPath}
                            filter={filter}
                            recents={recentFiles}
                            error={error}
                            ready={ready}
                            onPick={(next) => void setDoc(next)}
                            onClearSearch={() => setFilter("")}
                          />
                        </div>
                      ) : null}
                    </SidebarMenuItem>
                  );
                })
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {listError ? (
          <p className="px-4 text-error text-xs group-data-[collapsible=icon]:hidden">
            {listError}
          </p>
        ) : null}
        <SidebarGroup className="mt-auto">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  title={headsetTitle}
                  disabled={!host && !studio.available}
                  onClick={() => {
                    if (host) {
                      requestOpenQuest();
                      return;
                    }
                    studio.enter();
                  }}
                >
                  <Headset />
                  <span>{headsetLabel}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1">
            <WorkbenchSettings host={host} />
          </div>
          <ConnectionStatusDot
            lostShown={connectionLostShown}
            offerReload={connectionOfferReload}
            phase={connectionPhase}
          />
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
