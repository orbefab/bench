/**
 * Read-only shortcut registry. Every global and in-context chord that exists
 * on this branch is named once; Settings, palette chips, tooltips, and
 * keydown handlers all read from here. There is no remapper and no JSON config.
 *
 * Esc consumes in this order; only the first matching layer runs:
 * mention list → open popover/select → command palette/dialogs →
 * voice recording cancel → compact chat sheet.
 * Esc never hides docked chat or clears the CAD selection.
 * In a world, with none of those layers open, Esc cancels a tool gesture,
 * then leaves the tool (`world-tool-escape`), and only then clears the
 * selection.
 */

export type ShortcutScope = "global" | "composer" | "ask-user";

export type ShortcutId =
  | "toggle-files"
  | "open-folder"
  | "command-palette"
  | "composer-send"
  | "composer-newline"
  | "composer-mention"
  | "escape"
  | "world-tool-escape"
  | "world-tool-wire"
  | "ask-user-choose"
  | "timeline-live";

export type Shortcut = {
  id: ShortcutId;
  keys: readonly string[];
  label: string;
  scope: ShortcutScope;
  /**
   * When true, `matchesShortcut` returns false if the event target (or active
   * element) is an input / textarea / select / contenteditable. ⌘K stays false
   * so the palette still opens while typing.
   */
  ignoreEditable?: boolean;
};

export const SHORTCUTS: readonly Shortcut[] = [
  {
    id: "command-palette",
    keys: ["Mod", "K"],
    label: "Command palette",
    scope: "global",
  },
  {
    id: "toggle-files",
    keys: ["Mod", "B"],
    label: "Toggle sidebar",
    scope: "global",
    ignoreEditable: true,
  },
  {
    id: "open-folder",
    keys: ["Mod", "O"],
    label: "Open folder",
    scope: "global",
    ignoreEditable: true,
  },
  { id: "composer-send", keys: ["Enter"], label: "Send", scope: "composer" },
  {
    id: "composer-newline",
    keys: ["Shift", "Enter"],
    label: "New line",
    scope: "composer",
  },
  {
    id: "composer-mention",
    keys: ["#"],
    label: "Mention a part",
    scope: "composer",
  },
  {
    id: "ask-user-choose",
    keys: ["1–9"],
    label: "Choose an answer",
    scope: "ask-user",
    ignoreEditable: true,
  },
  {
    id: "escape",
    keys: ["Esc"],
    label: "Cancel voice, close mention, or close a dialog",
    scope: "global",
  },
  {
    id: "world-tool-escape",
    keys: ["Esc"],
    label: "Cancel a tool gesture, then leave the tool",
    scope: "global",
    ignoreEditable: true,
  },
  {
    id: "world-tool-wire",
    keys: ["W"],
    label: "Wire tool: enter it, or leave it again",
    scope: "global",
    ignoreEditable: true,
  },
  {
    id: "timeline-live",
    keys: ["End"],
    label: "Return the timeline to live",
    scope: "global",
    ignoreEditable: true,
  },
];

const SHORTCUT_BY_ID = Object.fromEntries(
  SHORTCUTS.map((row) => [row.id, row])
) as Record<ShortcutId, Shortcut>;

/** Settings list shape — same rows as `SHORTCUTS`, no second table. */
export type ShortcutSpec = {
  action: string;
  keys: readonly string[];
};

export const SETTINGS_SHORTCUTS: readonly ShortcutSpec[] = SHORTCUTS.map(
  (row) => ({
    action: row.label,
    keys: row.keys,
  })
);

export function shortcut(id: ShortcutId): Shortcut {
  return SHORTCUT_BY_ID[id];
}

export function isMacPlatform(platform: string, userAgent = ""): boolean {
  return /Mac|iPhone|iPad|iPod/.test(platform) || /Mac OS X/.test(userAgent);
}

type EditableProbe = {
  tagName?: string;
  isContentEditable?: boolean;
  parentElement?: EditableProbe | null;
  closest?: (selector: string) => unknown;
};

/** True when ⌘B / Ctrl+B should stay with the field (Bold in TipTap, etc.). */
export function isEditableTarget(
  target: unknown,
  activeElement: unknown = null
): boolean {
  return (
    probeIsEditable(toProbe(target)) || probeIsEditable(toProbe(activeElement))
  );
}

function toProbe(value: unknown): EditableProbe | null {
  if (!value || typeof value !== "object") return null;
  return value as EditableProbe;
}

function probeIsEditable(probe: EditableProbe | null): boolean {
  if (!probe) return false;
  const tag = probe.tagName?.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (probe.isContentEditable) return true;
  if (typeof probe.closest === "function") {
    if (
      probe.closest(
        "input, textarea, select, [contenteditable]:not([contenteditable='false'])"
      )
    ) {
      return true;
    }
  }
  if (probe.parentElement) return probeIsEditable(probe.parentElement);
  return false;
}

export function formatShortcutToken(token: string, mac: boolean): string {
  if (token === "Mod") return mac ? "⌘" : "Ctrl";
  return token;
}

export function formatShortcutChips(
  keys: readonly string[],
  mac: boolean
): string[] {
  return keys.map((token) => formatShortcutToken(token, mac));
}

export function formatShortcutKeys(
  keys: readonly string[],
  mac: boolean
): string {
  const chips = formatShortcutChips(keys, mac);
  if (mac && keys[0] === "Mod") return chips.join("");
  return chips.join("+");
}

export function formatShortcut(id: ShortcutId, mac: boolean): string {
  return formatShortcutKeys(shortcut(id).keys, mac);
}

export function shortcutTooltip(
  label: string,
  id: ShortcutId,
  mac: boolean
): string {
  return `${label} (${formatShortcut(id, mac)})`;
}

export type KeyEventLike = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  target?: unknown;
};

export function matchesShortcut(
  event: KeyEventLike,
  id: ShortcutId,
  options: { mac: boolean; activeElement?: unknown }
): boolean {
  const spec = SHORTCUT_BY_ID[id];
  if (!spec) return false;
  if (
    spec.ignoreEditable &&
    isEditableTarget(event.target, options.activeElement)
  )
    return false;
  return keysMatchEvent(event, spec.keys, options.mac);
}

const EVENT_KEY_ALIASES: Record<string, readonly string[]> = {
  Esc: ["Escape"],
  Escape: ["Escape"],
  End: ["End"],
  "↑": ["ArrowUp"],
  ArrowUp: ["ArrowUp"],
  Enter: ["Enter"],
  "#": ["#"],
};

function keysMatchEvent(
  event: KeyEventLike,
  keys: readonly string[],
  mac: boolean
): boolean {
  const meta = Boolean(event.metaKey);
  const ctrl = Boolean(event.ctrlKey);
  const alt = Boolean(event.altKey);
  const shift = Boolean(event.shiftKey);
  const wantsMod = keys.includes("Mod");
  const wantsShift = keys.includes("Shift");
  const wantsAlt = keys.includes("Alt");
  const keyTokens = keys.filter(
    (token) =>
      token !== "Mod" &&
      token !== "Shift" &&
      token !== "Ctrl" &&
      token !== "Alt"
  );
  const keyToken = keyTokens[0] ?? "";

  if (alt !== wantsAlt) return false;

  if (wantsMod) {
    if (mac) {
      if (!meta || ctrl) return false;
    } else if (!ctrl || meta) {
      return false;
    }
    if (shift !== wantsShift) return false;
  } else {
    if (meta || ctrl) return false;
    if (keyToken !== "#" && shift !== wantsShift) return false;
  }

  if (keyToken === "1–9") return /^[1-9]$/.test(event.key);
  const aliases = EVENT_KEY_ALIASES[keyToken] ?? [keyToken];
  return aliases.some(
    (alias) =>
      alias === event.key || alias.toLowerCase() === event.key.toLowerCase()
  );
}

export const ESC_ORDER = [
  "mention",
  "popover-select",
  "dialog",
  "voice",
  "compact-chat",
] as const;
export type EscLayer = (typeof ESC_ORDER)[number];

export type EscLayersOpen = {
  mention?: boolean;
  popoverOrSelect?: boolean;
  dialog?: boolean;
  compactChat?: boolean;
  voice?: boolean;
};

type QueryRoot = { querySelector: (sel: string) => unknown };

export type EscProbe = {
  mention: boolean;
  popoverOrSelect: boolean;
  dialog: boolean;
  voice: boolean;
};

export function probeEscLayers(root: QueryRoot | null): EscProbe {
  if (!root)
    return {
      mention: false,
      popoverOrSelect: false,
      dialog: false,
      voice: false,
    };
  return {
    mention: Boolean(root.querySelector("[data-mention-list]")),
    popoverOrSelect: Boolean(
      root.querySelector(
        "[data-slot='popover-content'], [data-slot='select-content']"
      )
    ),
    dialog: Boolean(
      root.querySelector(
        "[data-slot='dialog-content'], [data-slot='alert-dialog-content']"
      )
    ),
    voice: Boolean(root.querySelector("[data-voice-recording]")),
  };
}

export function activeEscLayer(open: EscLayersOpen): EscLayer | null {
  if (open.mention) return "mention";
  if (open.popoverOrSelect) return "popover-select";
  if (open.dialog) return "dialog";
  if (open.voice) return "voice";
  if (open.compactChat) return "compact-chat";
  return null;
}

export function escBelongsTo(layer: EscLayer, open: EscLayersOpen): boolean {
  return activeEscLayer(open) === layer;
}

export function compactChatSheetOpen(root: QueryRoot | null): boolean {
  if (!root) return false;
  return Boolean(root.querySelector("[data-compact-chat]"));
}
