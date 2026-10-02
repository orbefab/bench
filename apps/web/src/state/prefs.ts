import { useStore as useZustandStore } from "zustand";
import {
  createJSONStorage,
  persist,
  type StateStorage,
} from "zustand/middleware";
import { createStore } from "zustand/vanilla";
import {
  type ChatEffort,
  DEFAULT_CHAT_EFFORT,
  DEFAULT_HARNESS,
  DEFAULT_HARNESS_MODEL,
  type HarnessId,
  isChatEffort,
  isHarnessId,
} from "@/lib/harness";
import { CHAT_DEFAULT_WIDTH, clampStoredChatWidth } from "@/lib/layout";

const DESKTOP_PREFS_KEY = "sfab-bench.desktop";
const MAX_RECENTS = 12;
const PREF_WRITE_MS = 250;
const PERSIST_VERSION = 0;

/**
 * Written under `sfab-bench.desktop` as `{ state, version }`.
 * Order is the JSON key order `partialize` has always emitted.
 */
const PERSISTED_PREF_KEYS = [
  "chatOpen",
  "treeOpen",
  "partsOpen",
  "axesVisible",
  "chatWidth",
  "chatHarness",
  "chatModel",
  "chatEffort",
] as const;

type DesktopPrefs = {
  chatOpen: boolean;
  treeOpen: boolean;
  partsOpen: boolean;
  axesVisible: boolean;
  chatWidth: number;
  chatHarness: HarnessId;
  chatModel: string;
  chatEffort: ChatEffort;
};

type StoredPrefs = Partial<DesktopPrefs> & { recentFiles?: unknown };
type Setter = boolean | ((open: boolean) => boolean);

const resolve = (cur: boolean, next: Setter) =>
  typeof next === "function" ? next(cur) : next;

/** Skip identical prefs JSON and keep localStorage off the XR frame. */
function deferredPrefStorage(initialRaw: string | null): StateStorage {
  let last = initialRaw ?? "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    getItem: (name) => {
      const value = localStorage.getItem(name);
      if (value != null) last = value;
      return value;
    },
    setItem: (name, value) => {
      if (value === last) return;
      last = value;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        localStorage.setItem(name, value);
      }, PREF_WRITE_MS);
    },
    removeItem: (name) => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      last = "";
      localStorage.removeItem(name);
    },
  };
}

function readDesktopBlob(): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(DESKTOP_PREFS_KEY);
  } catch {
    return null;
  }
}

/**
 * What `readDesktopPrefs` used to seed before persist's sync merge ran.
 * Missing keys fall back to defaults; present keys are checked.
 */
function validatedDesktopPrefs(stored: StoredPrefs | undefined): DesktopPrefs {
  const harness = isHarnessId(stored?.chatHarness ?? "")
    ? stored!.chatHarness!
    : DEFAULT_HARNESS;
  return {
    chatOpen: stored?.chatOpen ?? true,
    treeOpen: stored?.treeOpen ?? true,
    partsOpen: stored?.partsOpen ?? true,
    axesVisible: stored?.axesVisible ?? true,
    chatWidth:
      stored?.chatWidth != null
        ? clampStoredChatWidth(stored.chatWidth)
        : CHAT_DEFAULT_WIDTH,
    chatHarness: harness,
    chatModel:
      typeof stored?.chatModel === "string" && stored.chatModel.trim()
        ? stored.chatModel.trim()
        : DEFAULT_HARNESS_MODEL[harness],
    chatEffort: isChatEffort(stored?.chatEffort ?? "")
      ? stored!.chatEffort!
      : DEFAULT_CHAT_EFFORT,
  };
}

function pickPersisted(stored: StoredPrefs): Partial<DesktopPrefs> {
  const out: Partial<DesktopPrefs> = {};
  const bag = out as Record<(typeof PERSISTED_PREF_KEYS)[number], unknown>;
  for (const key of PERSISTED_PREF_KEYS) {
    if (key in stored) bag[key] = stored[key];
  }
  return out;
}

/**
 * One read. Persist used to merge this blob again in the same turn and
 * overwrite the validated seed with the raw fields. That settled value is
 * what we keep. A version other than 0 used to fail migration and leave
 * the validated seed in place.
 */
function settledDesktopPrefs(raw: string | null): DesktopPrefs {
  if (!raw) return validatedDesktopPrefs(undefined);
  try {
    const parsed = JSON.parse(raw) as {
      state?: StoredPrefs;
      version?: number;
    };
    const stored = parsed.state;
    if (!stored || typeof stored !== "object") {
      return validatedDesktopPrefs(undefined);
    }
    const validated = validatedDesktopPrefs(stored);
    if (
      typeof parsed.version === "number" &&
      parsed.version !== PERSIST_VERSION
    ) {
      return validated;
    }
    return { ...validated, ...pickPersisted(stored) };
  } catch {
    return validatedDesktopPrefs(undefined);
  }
}

const desktopBlob = readDesktopBlob();
const seededPrefs = settledDesktopPrefs(desktopBlob);

export type PrefsState = DesktopPrefs & {
  /** Not persisted. The server sends the folder's list. */
  recentFiles: string[];
  /** Compact-sheet open state. Not persisted — must not rewrite `chatOpen`. */
  compactChatOpen: boolean;
  setRecentFiles: (paths: string[]) => void;
  setTreeOpen: (open: Setter) => void;
  setPartsOpen: (open: Setter) => void;
  setChatOpen: (open: Setter) => void;
  setCompactChatOpen: (open: Setter) => void;
  setChatWidth: (width: number) => void;
  setChatHarness: (harness: HarnessId) => void;
  setChatModel: (model: string) => void;
  setChatSelection: (harness: HarnessId, model: string) => void;
  setChatEffort: (effort: ChatEffort) => void;
  setAxesVisible: (open: Setter) => void;
};

export const prefsStore = createStore<PrefsState>()(
  persist(
    (set, get) => ({
      ...seededPrefs,
      recentFiles: [],
      compactChatOpen: false,
      setRecentFiles: (paths) => {
        const recentFiles = paths
          .filter((p): p is string => typeof p === "string" && p.length > 0)
          .slice(0, MAX_RECENTS);
        const cur = get().recentFiles;
        if (
          cur.length === recentFiles.length &&
          cur.every((p, i) => p === recentFiles[i])
        ) {
          return;
        }
        set({ recentFiles });
      },
      setTreeOpen: (open) =>
        set((s) => ({ treeOpen: resolve(s.treeOpen, open) })),
      setPartsOpen: (open) =>
        set((s) => ({ partsOpen: resolve(s.partsOpen, open) })),
      setChatOpen: (open) =>
        set((s) => ({ chatOpen: resolve(s.chatOpen, open) })),
      setCompactChatOpen: (open) =>
        set((s) => ({ compactChatOpen: resolve(s.compactChatOpen, open) })),
      setChatWidth: (width) => {
        const chatWidth = clampStoredChatWidth(width);
        if (get().chatWidth !== chatWidth) set({ chatWidth });
      },
      setChatHarness: (harness) => {
        if (get().chatHarness === harness) return;
        set({
          chatHarness: harness,
          chatModel: DEFAULT_HARNESS_MODEL[harness],
        });
      },
      setChatModel: (model) => {
        const chatModel = model.trim();
        if (chatModel && get().chatModel !== chatModel) set({ chatModel });
      },
      setChatSelection: (harness, model) => {
        const chatModel = model.trim() || DEFAULT_HARNESS_MODEL[harness];
        const cur = get();
        if (cur.chatHarness === harness && cur.chatModel === chatModel) return;
        set({ chatHarness: harness, chatModel });
      },
      setChatEffort: (effort) => {
        if (get().chatEffort !== effort) set({ chatEffort: effort });
      },
      setAxesVisible: (open) =>
        set((s) => ({ axesVisible: resolve(s.axesVisible, open) })),
    }),
    {
      name: DESKTOP_PREFS_KEY,
      version: PERSIST_VERSION,
      // The blob above is the only read. Persist still owns writes.
      skipHydration: true,
      storage: createJSONStorage(() => {
        if (typeof localStorage === "undefined") {
          throw new Error("localStorage unavailable");
        }
        return deferredPrefStorage(desktopBlob);
      }),
      partialize: (s): DesktopPrefs => ({
        chatOpen: s.chatOpen,
        treeOpen: s.treeOpen,
        partsOpen: s.partsOpen,
        axesVisible: s.axesVisible,
        chatWidth: s.chatWidth,
        chatHarness: s.chatHarness,
        chatModel: s.chatModel,
        chatEffort: s.chatEffort,
      }),
      merge: (persisted, current) => {
        const stored = persisted as StoredPrefs | undefined;
        if (!stored) return current;
        const { recentFiles: _ignored, ...rest } = stored;
        return { ...current, ...rest, recentFiles: current.recentFiles };
      },
    }
  )
);

export function usePrefs<T>(selector: (state: PrefsState) => T): T {
  return useZustandStore(prefsStore, selector);
}
