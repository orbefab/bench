import { Check, Search } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useShallow } from "zustand/react/shallow";
import type { OpenFolderApi } from "@/components/OpenFolder";
import { StartTruncatedPath } from "@/components/StartTruncatedPath";
import { useTheme } from "@/components/theme/theme-provider";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { useProjectSession } from "@/hooks/useProjectSession";
import {
  buildCommands,
  COMMAND_PALETTE_LIST_ID,
  clampActiveIndex,
  type PaletteCommand,
  paletteOptionId,
  requestOpenSettings,
  visiblePalette,
  wrapActiveIndex,
} from "@/lib/command-palette";
import { isCompactChat } from "@/lib/layout";
import { requestCloseFolder } from "@/lib/motion";
import { folderName, shortPath } from "@/lib/project";
import { isMacPlatform, matchesShortcut } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import type { CatalogEntry } from "@/lib/viewer-snapshot";
import { prefsStore, usePrefs } from "@/state/prefs";
import { useViewer } from "@/state/viewer";
import { useWorld } from "@/state/world";

const EMPTY_COMMANDS: PaletteCommand[] = [];

function restoreFocus(el: HTMLElement | null) {
  if (!el?.isConnected) return;
  el.focus();
}

export function CommandPalette({
  folder,
  compactChat,
  catalogFiles,
}: {
  folder: OpenFolderApi;
  compactChat: boolean;
  catalogFiles: CatalogEntry[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const restoreRef = useRef<HTMLElement | null>(null);
  const skipRestoreRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRowRef = useRef<HTMLButtonElement | null>(null);
  const { setTheme } = useTheme();
  const { project, setDoc } = useProjectSession();
  const url = useViewer((s) => s.url);
  const worldPath = useWorld((s) => s.path);
  const currentPath = worldPath || url;
  const { treeOpen, chatOpen, compactChatOpen } = usePrefs(
    useShallow((s) => ({
      treeOpen: s.treeOpen,
      chatOpen: s.chatOpen,
      compactChatOpen: s.compactChatOpen,
    }))
  );
  const mac = isMacPlatform(
    typeof navigator === "undefined" ? "" : navigator.platform,
    typeof navigator === "undefined" ? "" : navigator.userAgent
  );
  const chatVisible = compactChat ? compactChatOpen : chatOpen;

  const commands = useMemo(() => {
    if (!open) return EMPTY_COMMANDS;
    const currentPath = project.path;
    return buildCommands({
      mac,
      canOpenFolder: folder.canRegister,
      hasProject: Boolean(currentPath),
      filesOpen: treeOpen,
      chatOpen: chatVisible,
      files: catalogFiles.map((file) => ({
        name: folderName(file.path),
        path: file.path,
        current: file.path === currentPath,
      })),
      folders: folder.recents
        .filter((row) => row.path !== currentPath)
        .map((row) => ({
          name: row.name || folderName(row.path),
          path: row.path,
          subtitle: shortPath(row.path),
        })),
    });
  }, [
    open,
    mac,
    folder.canRegister,
    folder.recents,
    project.path,
    treeOpen,
    chatVisible,
    catalogFiles,
    currentPath,
  ]);

  const items = useMemo(
    () => visiblePalette(commands, query),
    [commands, query]
  );
  const active = clampActiveIndex(activeIndex, items.length);
  const activeCommand = items[active];
  const activeOptionId = activeCommand
    ? paletteOptionId(activeCommand.id)
    : undefined;

  const finishClose = useCallback((restore: boolean) => {
    setOpen(false);
    setQuery("");
    setActiveIndex(0);
    const el = restoreRef.current;
    restoreRef.current = null;
    if (restore) restoreFocus(el);
  }, []);

  const execute = useCallback(
    (cmd: PaletteCommand) => {
      const s = prefsStore.getState();
      const compact = isCompactChat(window.innerWidth, s.treeOpen);
      if (cmd.id === "action:open-folder") {
        void folder.requestOpen();
        return;
      }
      if (cmd.id === "action:toggle-files") {
        s.setTreeOpen(!s.treeOpen);
        return;
      }
      if (cmd.id === "action:toggle-chat") {
        if (compact) s.setCompactChatOpen(!s.compactChatOpen);
        else s.setChatOpen(!s.chatOpen);
        return;
      }
      if (cmd.id === "action:settings") {
        requestOpenSettings();
        return;
      }
      if (cmd.id === "action:close-folder") {
        requestCloseFolder();
        return;
      }
      if (cmd.id.startsWith("file:") && cmd.payload) {
        void setDoc(cmd.payload);
        return;
      }
      if (cmd.id.startsWith("folder:") && cmd.payload) {
        folder.pickRecent(cmd.payload);
        return;
      }
      if (cmd.id.startsWith("theme:") && cmd.payload) {
        setTheme(cmd.payload);
      }
    },
    [folder, setDoc, setTheme]
  );

  const run = useCallback(
    (cmd: PaletteCommand | undefined) => {
      if (!cmd) return;
      skipRestoreRef.current = true;
      finishClose(false);
      window.setTimeout(() => execute(cmd), 0);
    },
    [execute, finishClose]
  );

  const dialogOpen = folder.dialogOpen;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (!matchesShortcut(event, "command-palette", { mac })) return;
      event.preventDefault();
      event.stopPropagation();
      if (open) {
        finishClose(!skipRestoreRef.current);
        skipRestoreRef.current = false;
        return;
      }
      // Settings, Quest and the Close-folder alert keep focus inside their popup.
      const target = event.target instanceof Element ? event.target : null;
      if (
        dialogOpen ||
        target?.closest(
          "[data-slot='dialog-content'], [data-slot='alert-dialog-content']"
        )
      )
        return;
      restoreRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      skipRestoreRef.current = false;
      setQuery("");
      setActiveIndex(0);
      setOpen(true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dialogOpen, finishClose, mac, open]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [active, items]);

  const onListKeyDown = (event: ReactKeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex(wrapActiveIndex(active, 1, items.length));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(wrapActiveIndex(active, -1, items.length));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      run(items[active]);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setOpen(true);
          return;
        }
        const restore = !skipRestoreRef.current;
        skipRestoreRef.current = false;
        finishClose(restore);
      }}
    >
      <DialogContent
        data-command-palette=""
        showCloseButton={false}
        className="mt-[12vh] max-h-[min(28rem,calc(100dvh-8rem))] max-w-lg gap-0 self-start p-0 sm:mt-[15vh]"
        onKeyDownCapture={onListKeyDown}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <Input
            ref={inputRef}
            role="combobox"
            aria-expanded={open}
            aria-controls={COMMAND_PALETTE_LIST_ID}
            aria-activedescendant={activeOptionId}
            aria-autocomplete="list"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Type a command…"
            aria-label="Search commands"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            className="h-10 border-0 shadow-none focus-visible:ring-0"
          />
        </div>
        <div
          id={COMMAND_PALETTE_LIST_ID}
          role="listbox"
          aria-label="Commands"
          className="min-h-0 flex-1 overflow-y-auto p-1"
        >
          {items.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              No results
            </p>
          ) : (
            <ul>
              {items.map((cmd, index) => {
                const selected = index === active;
                return (
                  <li key={cmd.id}>
                    <button
                      id={paletteOptionId(cmd.id)}
                      ref={selected ? activeRowRef : undefined}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      tabIndex={-1}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                        selected
                          ? "bg-accent text-accent-foreground"
                          : "text-foreground"
                      )}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => run(cmd)}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-2">
                          {cmd.current ? (
                            <Check className="size-3.5 shrink-0" />
                          ) : null}
                          <span className="min-w-0 truncate">{cmd.title}</span>
                        </span>
                        {cmd.subtitle ? (
                          <StartTruncatedPath
                            path={cmd.subtitle}
                            className="font-mono text-[11px] text-muted-foreground"
                          />
                        ) : null}
                      </span>
                      {cmd.shortcut ? (
                        <Kbd className="shrink-0">{cmd.shortcut}</Kbd>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
