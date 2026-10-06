import { ok as expect } from "node:assert/strict";
import {
  CHAT_DEFAULT_WIDTH,
  CHAT_MAX_WIDTH,
  CHAT_MIN_WIDTH,
  chatWidthAfterKey,
} from "./layout";
import {
  activeEscLayer,
  ESC_ORDER,
  escBelongsTo,
  formatShortcut,
  formatShortcutChips,
  formatShortcutKeys,
  formatShortcutToken,
  isEditableTarget,
  isMacPlatform,
  matchesShortcut,
  popupChatEscape,
  popupChatOwnsEscape,
  probeEscLayers,
  SETTINGS_SHORTCUTS,
  SHORTCUTS,
  shortcut,
  shortcutTooltip,
} from "./shortcuts";

expect(isMacPlatform("MacIntel"), "mac platform");
expect(isMacPlatform("Win32", "Mozilla/5.0") === false, "windows is not mac");

expect(
  SHORTCUTS.some((row) => row.id === "toggle-files" && row.scope === "global"),
  "files in registry"
);
expect(
  SHORTCUTS.some((row) => row.id === "open-folder" && row.scope === "global"),
  "open folder in registry"
);
expect(
  SHORTCUTS.some(
    (row) => row.id === "command-palette" && row.scope === "global"
  ),
  "palette in registry"
);
expect(
  SHORTCUTS.some(
    (row) => row.id === "composer-send" && row.scope === "composer"
  ),
  "send in registry"
);
expect(
  SHORTCUTS.some(
    (row) => row.id === "composer-newline" && row.scope === "composer"
  ),
  "newline in registry"
);
expect(
  SHORTCUTS.some(
    (row) => row.id === "composer-mention" && row.scope === "composer"
  ),
  "mention in registry"
);
expect(
  SHORTCUTS.some((row) => row.id === "escape"),
  "esc in registry"
);
expect(
  SHORTCUTS.some(
    (row) => row.id === "ask-user-choose" && row.scope === "ask-user"
  ),
  "ask-user in registry"
);
expect(
  SETTINGS_SHORTCUTS.length === SHORTCUTS.length,
  "settings list is the registry"
);
expect(
  SETTINGS_SHORTCUTS.every(
    (row, i) =>
      row.action === SHORTCUTS[i]?.label && row.keys === SHORTCUTS[i]?.keys
  ),
  "settings rows alias SHORTCUTS"
);

expect(formatShortcutToken("Mod", true) === "⌘", "mac mod");
expect(formatShortcutToken("Mod", false) === "Ctrl", "other mod");
expect(formatShortcut("toggle-files", true) === "⌘B", "mac files chord");
expect(formatShortcut("toggle-files", false) === "Ctrl+B", "other files chord");
expect(formatShortcut("open-folder", true) === "⌘O", "mac open chord");
expect(formatShortcut("open-folder", false) === "Ctrl+O", "other open chord");
expect(formatShortcut("command-palette", true) === "⌘K", "mac palette chord");
expect(
  formatShortcut("command-palette", false) === "Ctrl+K",
  "other palette chord"
);
expect(formatShortcut("composer-send", true) === "Enter", "send chord");
expect(
  formatShortcut("composer-newline", true) === "Shift+Enter",
  "newline chord"
);
expect(formatShortcut("composer-mention", true) === "#", "mention chord");
expect(formatShortcut("ask-user-choose", true) === "1–9", "ask-user chord");
expect(formatShortcut("escape", true) === "Esc", "esc chord");
expect(formatShortcut("timeline-live", true) === "End", "timeline live chord");
expect(
  matchesShortcut({ key: "End" }, "timeline-live", { mac: true }),
  "End returns to live"
);
expect(
  matchesShortcut(
    { key: "End", target: { tagName: "INPUT" } },
    "timeline-live",
    {
      mac: true,
    }
  ) === false,
  "End stays in a field"
);
expect(
  formatShortcutChips(["Mod", "B"], true).join(" ") === "⌘ B",
  "mac files chips"
);
expect(
  formatShortcutKeys(["Mod", "O"], false) === "Ctrl+O",
  "other keys join with plus"
);
expect(
  shortcutTooltip("Toggle files", "toggle-files", true) === "Toggle files (⌘B)",
  "files tooltip"
);
expect(
  shortcutTooltip("Open folder", "open-folder", true) === "Open folder (⌘O)",
  "open tooltip"
);
expect(
  shortcut("command-palette").ignoreEditable !== true,
  "palette works while typing"
);
expect(
  shortcut("toggle-files").ignoreEditable === true,
  "files ignore editables"
);
expect(
  shortcut("open-folder").ignoreEditable === true,
  "open folder ignore editables"
);

const macModK = {
  key: "k",
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
};
expect(matchesShortcut(macModK, "command-palette", { mac: true }), "mac ⌘K");
expect(
  matchesShortcut({ ...macModK, key: "K" }, "command-palette", { mac: true }),
  "mac ⌘K uppercase"
);
expect(
  matchesShortcut(
    { key: "k", metaKey: false, ctrlKey: true, altKey: false, shiftKey: false },
    "command-palette",
    {
      mac: true,
    }
  ) === false,
  "mac ignores Ctrl+K"
);
expect(
  matchesShortcut(
    { key: "k", metaKey: false, ctrlKey: true, altKey: false, shiftKey: false },
    "command-palette",
    {
      mac: false,
    }
  ),
  "other Ctrl+K"
);
expect(
  matchesShortcut(
    { key: "k", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false },
    "command-palette",
    {
      mac: false,
    }
  ) === false,
  "other ignores ⌘K"
);
expect(
  matchesShortcut({ ...macModK, altKey: true }, "command-palette", {
    mac: true,
  }) === false,
  "alt blocks palette"
);
expect(
  matchesShortcut({ ...macModK, shiftKey: true }, "command-palette", {
    mac: true,
  }) === false,
  "shift blocks palette"
);

const macModB = {
  key: "b",
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
};
expect(matchesShortcut(macModB, "toggle-files", { mac: true }), "mac ⌘B");
expect(
  matchesShortcut(
    { key: "b", metaKey: false, ctrlKey: true, altKey: false, shiftKey: false },
    "toggle-files",
    {
      mac: false,
    }
  ),
  "other Ctrl+B"
);
expect(
  matchesShortcut(
    { ...macModB, target: { tagName: "INPUT" } },
    "toggle-files",
    { mac: true }
  ) === false,
  "⌘B ignores input"
);
expect(
  matchesShortcut(
    { ...macModB, target: { tagName: "BUTTON" } },
    "toggle-files",
    { mac: true, activeElement: { tagName: "DIV", isContentEditable: true } }
  ) === false,
  "⌘B ignores active composer"
);
expect(
  matchesShortcut(
    { ...macModK, target: { tagName: "TEXTAREA" } },
    "command-palette",
    { mac: true }
  ),
  "⌘K works in textarea"
);
expect(
  matchesShortcut(
    { ...macModK, target: { tagName: "DIV", isContentEditable: true } },
    "command-palette",
    { mac: true }
  ),
  "⌘K works in composer"
);

const macModO = {
  key: "o",
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
};
expect(matchesShortcut(macModO, "open-folder", { mac: true }), "mac ⌘O");
expect(
  matchesShortcut({ ...macModO, target: { tagName: "INPUT" } }, "open-folder", {
    mac: true,
  }) === false,
  "⌘O ignores input"
);
expect(
  matchesShortcut(macModO, "command-palette", { mac: true }) === false,
  "O is not palette"
);

expect(
  matchesShortcut({ key: "Enter", shiftKey: false }, "composer-send", {
    mac: true,
  }),
  "Enter sends"
);
expect(
  matchesShortcut({ key: "Enter", shiftKey: true }, "composer-send", {
    mac: true,
  }) === false,
  "Shift+Enter is not send"
);
expect(
  matchesShortcut({ key: "Enter", shiftKey: true }, "composer-newline", {
    mac: true,
  }),
  "Shift+Enter newline"
);
expect(
  matchesShortcut({ key: "#", shiftKey: true }, "composer-mention", {
    mac: true,
  }),
  "hash mention"
);
expect(matchesShortcut({ key: "Escape" }, "escape", { mac: true }), "Escape");
expect(
  matchesShortcut({ key: "5" }, "ask-user-choose", { mac: true }),
  "digit 5"
);
expect(
  matchesShortcut({ key: "0" }, "ask-user-choose", { mac: true }) === false,
  "0 is not 1–9"
);
expect(
  matchesShortcut(
    { key: "3", target: { tagName: "TEXTAREA" } },
    "ask-user-choose",
    { mac: true }
  ) === false,
  "digits ignore editables"
);

expect(isEditableTarget({ tagName: "INPUT" }), "input is editable");
expect(
  isEditableTarget({ tagName: "BUTTON" }) === false,
  "button is not editable"
);

expect(
  ESC_ORDER.join(",") === "mention,popover-select,dialog,voice,popup-chat",
  "esc order"
);

expect(
  activeEscLayer({ mention: true, dialog: true }) === "mention",
  "mention before dialog"
);
expect(
  activeEscLayer({ popoverOrSelect: true, dialog: true }) === "popover-select",
  "popover before dialog"
);
expect(
  activeEscLayer({ dialog: true, popupChat: true }) === "dialog",
  "dialog before popup chat"
);
expect(
  activeEscLayer({ popupChat: true, voice: true }) === "voice",
  "voice before popup chat"
);
expect(activeEscLayer({ voice: true }) === "voice", "voice without popup chat");
expect(activeEscLayer({ popupChat: true }) === "popup-chat", "popup chat last");
expect(
  escBelongsTo("popup-chat", { popupChat: true, voice: true }) === false,
  "popup chat yields to voice"
);
expect(
  escBelongsTo("voice", { popupChat: true, voice: true }),
  "voice wins over popup chat"
);
expect(
  escBelongsTo("voice", { dialog: true, voice: true }) === false,
  "voice yields to dialog"
);
expect(
  escBelongsTo("popup-chat", { dialog: true, popupChat: true }) === false,
  "popup chat yields to dialog"
);
expect(
  escBelongsTo("popup-chat", { popupChat: true }),
  "popup chat when nothing higher"
);
expect(
  escBelongsTo("popup-chat", { popupChat: true, popoverOrSelect: true }) ===
    false,
  "popup chat yields to file context menu"
);
expect(
  probeEscLayers({
    querySelector(sel: string) {
      return sel.includes("popover-content") ? { id: "file-menu" } : null;
    },
  }).popoverOrSelect,
  "file context menu slot is a popover layer"
);

const probe = probeEscLayers({
  querySelector(sel: string) {
    if (sel.includes("data-mention-list")) return { id: "mention" };
    return null;
  },
});
expect(
  Boolean(probe.mention && !probe.dialog && !probe.voice),
  "probe finds mention"
);
expect(
  probeEscLayers({
    querySelector(sel: string) {
      return sel.includes("data-voice-recording") ? { id: "voice" } : null;
    },
  }).voice,
  "probe finds voice"
);
expect(
  probeEscLayers({
    querySelector(sel: string) {
      return sel.includes("alert-dialog-content") ? { id: "alert" } : null;
    },
  }).dialog,
  "alert-dialog slot is a dialog layer"
);
const composer = { id: "composer" };
const grownCard = {
  contains(node: unknown) {
    return node === composer;
  },
};
expect(
  popupChatOwnsEscape({
    activeElement: composer,
    querySelector(sel: string) {
      return sel.includes("data-chat-popup") ? grownCard : null;
    },
  }),
  "focus inside the grown card owns escape"
);
expect(
  popupChatOwnsEscape({
    activeElement: { id: "canvas" },
    querySelector(sel: string) {
      return sel.includes("data-chat-popup") ? grownCard : null;
    },
  }) === false,
  "focus outside the card does not own escape"
);
expect(
  popupChatOwnsEscape({
    activeElement: composer,
    querySelector() {
      return null;
    },
  }) === false,
  "a missing card does not own escape"
);
expect(
  popupChatEscape({
    popup: true,
    open: true,
    grown: true,
    focusInside: true,
    layers: {},
  }),
  "escape collapses a focused grown popup"
);
expect(
  popupChatEscape({
    popup: true,
    open: true,
    grown: true,
    focusInside: false,
    layers: {},
  }) === false,
  "escape outside the card leaves it open"
);
expect(
  popupChatEscape({
    popup: true,
    open: true,
    grown: false,
    focusInside: true,
    layers: {},
  }) === false,
  "the bare composer has nothing to collapse"
);
expect(
  popupChatEscape({
    popup: false,
    open: true,
    grown: true,
    focusInside: true,
    layers: {},
  }) === false,
  "docked chat does not collapse"
);
expect(
  popupChatEscape({
    popup: true,
    open: false,
    grown: true,
    focusInside: true,
    layers: {},
  }) === false,
  "a closed popup does not take escape"
);
expect(
  popupChatEscape({
    popup: true,
    open: true,
    grown: true,
    focusInside: true,
    layers: { voice: true },
  }) === false,
  "voice keeps escape"
);
expect(
  popupChatEscape({
    popup: true,
    open: true,
    grown: true,
    focusInside: true,
    layers: { dialog: true },
  }) === false,
  "a dialog keeps escape"
);

expect(
  chatWidthAfterKey("ArrowLeft", false, 384) === 400,
  "arrow left grows 16"
);
expect(
  chatWidthAfterKey("ArrowRight", false, 384) === 368,
  "arrow right shrinks 16"
);
expect(chatWidthAfterKey("ArrowLeft", true, 384) === 448, "shift arrow 64");
expect(chatWidthAfterKey("Home", false, 500) === CHAT_MIN_WIDTH, "Home is min");
expect(
  chatWidthAfterKey("End", false, 384) === CHAT_MAX_WIDTH,
  "End is the floating max"
);
expect(
  chatWidthAfterKey("ArrowLeft", false, 710) === CHAT_MAX_WIDTH,
  "step still clamps"
);
expect(
  chatWidthAfterKey("ArrowRight", false, 290) === CHAT_MIN_WIDTH,
  "shrink still floors"
);
expect(chatWidthAfterKey("Enter", false, 384) === null, "other keys ignored");
expect(
  chatWidthAfterKey("Home", false, CHAT_DEFAULT_WIDTH) === CHAT_MIN_WIDTH,
  "Home from default"
);

console.log("shortcuts.selfcheck ok");
