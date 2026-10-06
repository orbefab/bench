import { formatShortcut } from "./shortcuts";

export const OPEN_SETTINGS_EVENT = "sfab-open-settings";
export const OPEN_QUEST_EVENT = "sfab-open-quest";
export const OPEN_COMMAND_PALETTE_EVENT = "sfab-open-command-palette";

export type PaletteCommand = {
  id: string;
  title: string;
  subtitle?: string;
  shortcut?: string;
  current?: boolean;
  payload?: string;
};

export type PaletteFile = {
  name: string;
  path: string;
  current?: boolean;
};

export type PaletteFolder = {
  name: string;
  path: string;
  subtitle: string;
};

export type BuildCommandsInput = {
  mac: boolean;
  canOpenFolder: boolean;
  hasProject: boolean;
  filesOpen: boolean;
  chatOpen: boolean;
  files: readonly PaletteFile[];
  folders: readonly PaletteFolder[];
};

export function commandPaletteShortcutLabel(mac: boolean): string {
  return formatShortcut("command-palette", mac);
}

export const COMMAND_PALETTE_LIST_ID = "command-palette-list";

export function paletteOptionId(commandId: string): string {
  return `command-option-${commandId.replace(/[^A-Za-z0-9_-]+/g, "-")}`;
}

export function queryTokens(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

export function commandMatches(
  command: PaletteCommand,
  tokens: string[]
): boolean {
  if (tokens.length === 0) return true;
  const haystack = `${command.title} ${command.subtitle ?? ""}`.toLowerCase();
  return tokens.every((token) => haystack.includes(token.toLowerCase()));
}

export function wrapActiveIndex(
  index: number,
  delta: number,
  length: number
): number {
  if (length <= 0) return 0;
  const step = delta % length;
  return (index + step + length) % length;
}

export function clampActiveIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  if (index < 0) return 0;
  if (index >= length) return length - 1;
  return index;
}

export function buildCommands(input: BuildCommandsInput): PaletteCommand[] {
  const commands: PaletteCommand[] = [];
  const filesChord = formatShortcut("toggle-files", input.mac);
  const openChord = formatShortcut("open-folder", input.mac);

  if (input.canOpenFolder) {
    commands.push({
      id: "action:open-folder",
      title: "Open folder…",
      shortcut: openChord,
    });
  }

  commands.push({
    id: "action:toggle-files",
    title: input.filesOpen ? "Hide files" : "Show files",
    shortcut: filesChord,
  });

  if (input.hasProject) {
    commands.push({
      id: "action:toggle-chat",
      title: input.chatOpen ? "Hide chat" : "Show chat",
    });
  }

  commands.push({ id: "action:settings", title: "Settings" });

  if (input.hasProject) {
    commands.push({ id: "action:close-folder", title: "Close folder" });
  }

  for (const file of input.files) {
    commands.push({
      id: `file:${file.path}`,
      title: `Open ${file.name}`,
      subtitle: file.path,
      current: Boolean(file.current),
      payload: file.path,
    });
  }

  for (const folder of input.folders) {
    commands.push({
      id: `folder:${folder.path}`,
      title: `Switch to ${folder.name}`,
      subtitle: folder.subtitle,
      payload: folder.path,
    });
  }

  commands.push(
    { id: "theme:light", title: "Theme: Light", payload: "light" },
    { id: "theme:dark", title: "Theme: Dark", payload: "dark" },
    { id: "theme:system", title: "Theme: System", payload: "system" }
  );

  return commands;
}

/** Case-insensitive substring; multi-word AND. Empty query returns the full list. */
export function visiblePalette(
  commands: readonly PaletteCommand[],
  query: string
): PaletteCommand[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [...commands];
  return commands.filter((command) => commandMatches(command, tokens));
}

export function requestOpenSettings() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OPEN_SETTINGS_EVENT));
}

export function requestOpenQuest() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OPEN_QUEST_EVENT));
}

export function requestOpenCommandPalette() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT));
}
