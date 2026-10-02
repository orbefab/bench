import { ok as expect } from "node:assert/strict";
import {
  buildCommands,
  clampActiveIndex,
  commandMatches,
  type PaletteCommand,
  paletteOptionId,
  queryTokens,
  visiblePalette,
  wrapActiveIndex,
} from "./command-palette";

expect(
  queryTokens("  Foo   BAR ").join(",") === "foo,bar",
  "tokens lowercased"
);
expect(queryTokens("").length === 0, "empty tokens");

const sample: PaletteCommand = {
  id: "file:cad/bracket.step",
  title: "Open bracket.step",
  subtitle: "cad/bracket.step",
};
expect(commandMatches(sample, ["bracket"]), "title hit");
expect(commandMatches(sample, ["cad/bracket"]), "subtitle hit");
expect(commandMatches(sample, ["open", "cad"]), "AND title+subtitle");
expect(commandMatches(sample, ["OPEN", "STEP"]), "case-insensitive");
expect(commandMatches(sample, ["glb"]) === false, "missing token fails AND");

expect(wrapActiveIndex(0, 1, 3) === 1, "down");
expect(wrapActiveIndex(2, 1, 3) === 0, "down wrap");
expect(wrapActiveIndex(0, -1, 3) === 2, "up wrap");
expect(clampActiveIndex(5, 3) === 2, "clamp high");
expect(clampActiveIndex(-1, 3) === 0, "clamp low");

const files = Array.from({ length: 12 }, (_, i) => ({
  name: `part-${i}.step`,
  path: `cad/part-${i}.step`,
  current: i === 0,
}));
const folders = Array.from({ length: 7 }, (_, i) => ({
  name: `proj-${i}`,
  path: `/abs/path/proj-${i}`,
  subtitle: `~/cad/proj-${i}`,
}));

const full = buildCommands({
  mac: true,
  canOpenFolder: true,
  hasProject: true,
  filesOpen: true,
  chatOpen: false,
  files,
  folders,
});

expect(
  full.some(
    (c) =>
      c.id === "action:open-folder" &&
      c.title === "Open folder…" &&
      c.shortcut === "⌘O"
  ),
  "open folder"
);
expect(
  full.some(
    (c) =>
      c.id === "action:toggle-files" &&
      c.title === "Hide files" &&
      c.shortcut === "⌘B"
  ),
  "hide files"
);
expect(
  full.some((c) => c.id === "action:toggle-chat" && c.title === "Show chat"),
  "show chat"
);
expect(
  full.some((c) => c.id === "action:settings"),
  "settings"
);
expect(
  full.some((c) => c.id === "action:close-folder"),
  "close folder"
);
expect(
  full.some(
    (c) =>
      c.id === "file:cad/part-0.step" &&
      c.current &&
      c.payload === "cad/part-0.step"
  ),
  "open file routes on payload"
);
expect(
  full.some(
    (c) =>
      c.id === "folder:/abs/path/proj-1" && c.payload === "/abs/path/proj-1"
  ),
  "switch folder routes on payload"
);
expect(
  full.some((c) => c.id === "theme:dark" && c.payload === "dark"),
  "theme dark"
);
expect(
  full.some((c) => c.id === "theme:light" && c.payload === "light"),
  "theme light"
);
expect(
  full.some((c) => c.id === "theme:system" && c.payload === "system"),
  "theme system"
);
expect(
  full.some((c) => c.id === "action:frame-model") === false,
  "no frame model"
);
expect(full.some((c) => c.id.startsWith("part:")) === false, "no parts");
expect(
  full.some((c) => c.id === "action:refresh-files") === false,
  "no refresh"
);
expect(full.some((c) => c.id === "action:new-chat") === false, "no new chat");
expect(full.some((c) => c.id === "action:enter-quest") === false, "no quest");

const empty = visiblePalette(full, "");
expect(empty.length === full.length, "empty query is the full list");
expect(
  empty.some((c) => c.id === "theme:system"),
  "empty query includes theme"
);
expect(
  empty.filter((c) => c.id.startsWith("file:")).length === 12,
  "no empty-query file cap"
);
expect(
  empty.filter((c) => c.id.startsWith("folder:")).length === 7,
  "empty-query folder cap gone"
);

const theme = visiblePalette(full, "theme dark");
expect(
  theme.some((c) => c.id === "theme:dark"),
  "AND appearance"
);
expect(
  theme.some((c) => c.id === "theme:light") === false,
  "AND excludes light"
);

const none = visiblePalette(full, "definitely-not-a-command");
expect(none.length === 0, "no results");

const guest = buildCommands({
  mac: false,
  canOpenFolder: false,
  hasProject: false,
  filesOpen: false,
  chatOpen: false,
  files: [],
  folders: [],
});
expect(
  guest.some((c) => c.id === "action:open-folder") === false,
  "guest cannot open folder"
);
expect(
  guest.some((c) => c.id === "action:close-folder") === false,
  "no folder to close"
);
expect(
  guest.some((c) => c.id === "action:toggle-chat") === false,
  "no chat without folder"
);
expect(
  guest.some(
    (c) =>
      c.id === "action:toggle-files" &&
      c.title === "Show files" &&
      c.shortcut === "Ctrl+B"
  ),
  "guest files"
);
expect(
  guest.some((c) => c.id === "action:settings"),
  "settings always listed"
);

expect(
  paletteOptionId("file:cad/bracket.step") ===
    "command-option-file-cad-bracket-step",
  "stable option id"
);
expect(
  paletteOptionId("action:settings") === "command-option-action-settings",
  "action option id"
);

console.log("command-palette.selfcheck ok");
