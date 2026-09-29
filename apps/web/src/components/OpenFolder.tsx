import type { ProjectRow } from "@sfab-bench/contract";
import { Folder } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { StartTruncatedPath } from "@/components/StartTruncatedPath";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useXrSession } from "@/hooks/useXrSession";
import { desktopBridge } from "@/lib/desktop";
import {
  type BrowseInfo,
  browsePath,
  fetchProject,
  openTabProject,
  registerAndOpenTab,
  shortPath,
} from "@/lib/project";
import { redact } from "@/lib/redact";
import { isMacPlatform, matchesShortcut } from "@/lib/shortcuts";
import {
  browseListingApply,
  emitFolderError,
  FOLDER_ERROR_EVENT,
  fileRecentLines,
  openFolderButtonTitle,
  pathFieldEnterAction,
  STARTER_HINT_LEAD,
  STARTER_HINT_LINK,
  STARTER_HINT_TRAIL,
  STARTER_REPO_URL,
  WELCOME_OPEN_COPY,
} from "@/lib/welcome";

function openErrorMessage(
  err: unknown,
  fallback = "Could not open that folder"
) {
  return redact(err instanceof Error ? err.message : fallback);
}

export function RecentFolders({
  recents,
  busy,
  onPick,
}: {
  recents: ProjectRow[];
  busy?: boolean;
  onPick: (path: string) => void;
}) {
  if (recents.length === 0) return null;
  return (
    <ul className="max-h-48 w-full overflow-y-auto text-left">
      {recents.map((row) => (
        <li key={row.path}>
          <button
            type="button"
            disabled={busy}
            className="flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left hover:bg-accent disabled:opacity-50"
            onClick={() => onPick(row.path)}
          >
            <span className="text-sm text-foreground">{row.name}</span>
            <StartTruncatedPath
              path={shortPath(row.path)}
              title={row.path}
              className="w-full font-mono text-[11px] text-muted-foreground"
            />
          </button>
        </li>
      ))}
    </ul>
  );
}

export function RecentFiles({
  recents,
  onPick,
}: {
  recents: string[];
  onPick: (path: string) => void;
}) {
  if (recents.length === 0) return null;
  return (
    <div className="w-full">
      <p className="px-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        Recent
      </p>
      <ul className="max-h-48 w-full overflow-y-auto text-left">
        {recents.map((path) => {
          const { name, extra } = fileRecentLines(path);
          return (
            <li key={path}>
              <button
                type="button"
                title={path}
                className="flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left hover:bg-accent"
                onClick={() => onPick(path)}
              >
                <span className="text-sm text-foreground">{name}</span>
                {extra ? (
                  <StartTruncatedPath
                    path={extra}
                    title={path}
                    className="w-full font-mono text-[11px] text-muted-foreground"
                  />
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function useOpenFolder(canRegister: boolean) {
  const xrSession = useXrSession();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [recents, setRecents] = useState<ProjectRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    void fetchProject()
      .then((info) => {
        setRecents(info.recents);
        setError(null);
      })
      .catch((err: unknown) => {
        setRecents([]);
        setError(openErrorMessage(err, "Could not load folders"));
      });
  }, []);

  useEffect(() => {
    reload();
    window.addEventListener("sfab-project", reload);
    return () => window.removeEventListener("sfab-project", reload);
  }, [reload]);

  useEffect(() => {
    const onErr = (ev: Event) => {
      const detail = (ev as CustomEvent<string | null>).detail;
      setError(typeof detail === "string" && detail.trim() ? detail : null);
    };
    window.addEventListener(FOLDER_ERROR_EVENT, onErr);
    return () => window.removeEventListener(FOLDER_ERROR_EVENT, onErr);
  }, []);

  const pickRecent = useCallback(
    (path: string) => {
      if (canRegister) {
        void registerAndOpenTab(path).catch((err: unknown) => {
          setError(openErrorMessage(err));
        });
      } else {
        openTabProject(path);
      }
    },
    [canRegister]
  );

  const requestOpen = useCallback(async () => {
    if (!canRegister) return;
    const bridge = desktopBridge();
    if (bridge) {
      let picked: string | null;
      try {
        picked = await bridge.pickFolder();
      } catch {
        setError("Could not open the folder chooser");
        return;
      }
      if (!picked) return;
      try {
        await registerAndOpenTab(picked);
        setError(null);
      } catch (err) {
        setError(openErrorMessage(err));
      }
      return;
    }
    setDialogOpen(true);
  }, [canRegister]);

  useEffect(() => {
    if (!canRegister || desktopBridge() || xrSession) return;
    const mac = isMacPlatform(navigator.platform, navigator.userAgent);
    const onKey = (event: KeyboardEvent) => {
      if (
        !matchesShortcut(event, "open-folder", {
          mac,
          activeElement: document.activeElement,
        })
      )
        return;
      event.preventDefault();
      void requestOpen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canRegister, requestOpen, xrSession]);

  return {
    canRegister,
    recents,
    error,
    dialogOpen,
    setDialogOpen,
    requestOpen,
    pickRecent,
  };
}

export type OpenFolderApi = ReturnType<typeof useOpenFolder>;

function OpenFolderButton({
  folder,
  className,
}: {
  folder: OpenFolderApi;
  className?: string;
}) {
  const mac = isMacPlatform(navigator.platform, navigator.userAgent);
  return (
    <Button
      type="button"
      size="sm"
      className={className}
      title={openFolderButtonTitle(mac)}
      onClick={() => void folder.requestOpen()}
    >
      <Folder className="size-3.5" />
      Open folder
    </Button>
  );
}

export function BrowseFolderDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [browse, setBrowse] = useState<BrowseInfo | null>(null);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const latestBrowseRef = useRef(0);
  const editedRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    editedRef.current = false;
    setError(null);
    const id = ++latestBrowseRef.current;
    void fetchProject()
      .then(async (info) => {
        const start = info.project?.path ?? "";
        const listing = await browsePath(start || undefined);
        if (cancelled) return;
        const decision = browseListingApply({
          requestId: id,
          latestId: latestBrowseRef.current,
          fieldEdited: editedRef.current,
          seed: true,
        });
        if (!decision.apply) return;
        setBrowse(listing);
        if (decision.writePath) setPath(listing.path);
      })
      .catch((err: unknown) => {
        if (cancelled || id !== latestBrowseRef.current) return;
        setError(openErrorMessage(err, "Could not browse"));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const go = async (next: string): Promise<BrowseInfo | null> => {
    const value = next.trim();
    if (!value) return null;
    setError(null);
    const id = ++latestBrowseRef.current;
    try {
      const listing = await browsePath(value);
      const decision = browseListingApply({
        requestId: id,
        latestId: latestBrowseRef.current,
        fieldEdited: editedRef.current,
        seed: false,
      });
      if (!decision.apply) return null;
      setBrowse(listing);
      if (decision.writePath) setPath(listing.path);
      return listing;
    } catch (err) {
      if (id !== latestBrowseRef.current) return null;
      setError(openErrorMessage(err, "Could not open that path"));
      return null;
    }
  };

  const openHere = async (next?: string) => {
    const value = (next ?? path).trim() || browse?.path?.trim() || "";
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      await registerAndOpenTab(value);
      onOpenChange(false);
    } catch (err) {
      const message = openErrorMessage(err);
      setError(message);
      emitFolderError(message);
    } finally {
      setBusy(false);
    }
  };

  const onPathEnter = async () => {
    const typed = path.trim();
    const action = pathFieldEnterAction(typed, browse?.path ?? null);
    if (action === "idle") return;
    if (action === "open") {
      await openHere(typed);
      return;
    }
    const listing = await go(typed);
    if (listing) await openHere(typed);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Open folder</DialogTitle>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(ev) => {
            ev.preventDefault();
            void onPathEnter();
          }}
        >
          <Input
            value={path}
            onChange={(ev) => {
              editedRef.current = true;
              setPath(ev.target.value);
            }}
            placeholder="~/Projects/my-cad"
            className="h-8 flex-1 font-mono text-[12px]"
            disabled={busy}
            aria-label="Folder path"
          />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-8"
            disabled={busy || !path.trim()}
            onClick={() => void go(path)}
          >
            Go
          </Button>
        </form>
        {browse ? (
          <div className="mt-3 min-h-0 flex-1">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2"
                disabled={!browse.parent || busy}
                aria-label="Parent folder"
                title="Parent folder"
                onClick={() => {
                  if (!browse.parent) return;
                  void go(browse.parent);
                }}
              >
                Up
              </Button>
              <span
                className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground"
                title={browse.path}
              >
                {shortPath(browse.path)}
              </span>
            </div>
            <ul className="mt-2 max-h-56 overflow-auto rounded-md border border-border">
              {browse.dirs.length === 0 ? (
                <li className="px-2 py-2 text-[13px] text-muted-foreground">
                  No folders here.
                </li>
              ) : (
                browse.dirs.map((dir) => (
                  <li key={dir.path}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 truncate px-2 py-1.5 text-left text-sm hover:bg-accent"
                      onClick={() => void go(dir.path)}
                    >
                      <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                      {dir.name}
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        ) : null}
        {error ? <p className="mt-2 text-xs text-error">{error}</p> : null}
        <div className="mt-3 flex justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-8"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-8"
            disabled={busy || !(path.trim() || browse?.path)}
            onClick={() => void openHere()}
          >
            Open
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function StarterHint() {
  return (
    <p className="text-[13px] text-muted-foreground">
      {STARTER_HINT_LEAD}{" "}
      <a
        className="underline underline-offset-2 hover:text-foreground"
        href={STARTER_REPO_URL}
        rel="noreferrer"
        target="_blank"
      >
        {STARTER_HINT_LINK}
      </a>
      {STARTER_HINT_TRAIL}
    </p>
  );
}

export function WelcomeFolders({ folder }: { folder: OpenFolderApi }) {
  return (
    <div className="flex w-full flex-col items-center gap-3">
      <p className="text-sm text-muted-foreground">
        {folder.canRegister
          ? WELCOME_OPEN_COPY
          : "Pick a folder the Mac has opened. Opening a new path is Mac-only."}
      </p>
      {folder.canRegister ? <OpenFolderButton folder={folder} /> : null}
      {folder.canRegister ? <StarterHint /> : null}
      {folder.recents.length > 0 ? (
        <div className="w-full">
          <p className="px-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            Recent
          </p>
          <RecentFolders recents={folder.recents} onPick={folder.pickRecent} />
        </div>
      ) : null}
      {!folder.canRegister && folder.recents.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          Open a folder on the Mac first, then it shows up here.
        </p>
      ) : null}
      {folder.error ? (
        <p className="text-xs text-error">{folder.error}</p>
      ) : null}
    </div>
  );
}

export function EmptyFolderRail({ folder }: { folder: OpenFolderApi }) {
  return (
    <div className="flex flex-col gap-3 p-3">
      <p className="text-[13px] text-muted-foreground">
        {folder.canRegister
          ? "Open a folder to see its files."
          : "Pick a folder the Mac has opened."}
      </p>
      {folder.canRegister ? (
        <>
          <OpenFolderButton folder={folder} className="h-8" />
          <StarterHint />
        </>
      ) : null}
      <RecentFolders recents={folder.recents} onPick={folder.pickRecent} />
      {!folder.canRegister && folder.recents.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          Open a folder on the Mac first, then it shows up here.
        </p>
      ) : null}
      {folder.error ? (
        <p className="text-xs text-error">{folder.error}</p>
      ) : null}
    </div>
  );
}

export { OpenFolderButton };
