import { ok as expect } from "node:assert/strict";
import { matchesShortcut, SHORTCUTS } from "./shortcuts";
import { editorKeyAction } from "./world-keys";
import { toolEscape, WORLD_TOOL_START, WORLD_TOOLS } from "./world-tool";

expect(
  editorKeyAction({ key: "z", meta: true }, false) === "undo",
  "⌘Z undoes"
);
expect(
  editorKeyAction({ key: "z", ctrl: true }, false) === "undo",
  "Ctrl+Z undoes"
);
expect(
  editorKeyAction({ key: "z", meta: true, shift: true }, false) === "redo",
  "⇧⌘Z redoes"
);
expect(
  editorKeyAction({ key: "Z", ctrl: true, shift: true }, false) === "redo",
  "Ctrl+Shift+Z redoes"
);
expect(
  editorKeyAction({ key: "y", ctrl: true }, false) === "redo",
  "Ctrl+Y redoes"
);
expect(
  editorKeyAction({ key: "y", meta: true }, false) === null,
  "⌘Y is not redo"
);
expect(
  editorKeyAction({ key: " ", meta: false }, false) === "play",
  "Space plays"
);
expect(
  editorKeyAction({ key: "Delete" }, false) === "delete",
  "Delete removes"
);
expect(
  editorKeyAction({ key: "Backspace" }, false) === "delete",
  "Backspace removes"
);
expect(editorKeyAction({ key: "F2" }, false) === "rename", "F2 renames");
expect(
  editorKeyAction({ key: "z", meta: true }, true) === null,
  "undo does not fire while typing"
);
expect(
  editorKeyAction({ key: " " }, true) === null,
  "Space does not fire while typing"
);
expect(
  editorKeyAction({ key: "Delete" }, true) === null,
  "Delete does not fire while typing"
);
expect(
  editorKeyAction({ key: "z", meta: true, alt: true }, false) === null,
  "⌥⌘Z is not undo"
);

// Esc belongs to the tool layer, not to the editor actions. W is the Wire
// tool's; no other tool takes a letter key yet.
expect(
  editorKeyAction({ key: "Escape" }, false) === null,
  "Esc is not an editor action"
);
for (const key of ["m", "r", "v"]) {
  expect(
    editorKeyAction({ key }, false) === null,
    `${key} is not claimed by a tool yet`
  );
}
const toolOf = (key: string) => {
  const action = editorKeyAction({ key }, false);
  return typeof action === "object" && action ? action.tool : null;
};
expect(toolOf("w") === "wire", "W enters Wire");
expect(toolOf("W") === "wire", "W with caps lock is still Wire");
// The key map is the table's: each hotkey in it, and no other key, is a tool key.
for (const tool of WORLD_TOOLS) {
  const key = "hotkey" in tool ? tool.hotkey : null;
  expect(
    key ? toolOf(key) === tool.mode : toolOf(tool.label[0]) === null,
    `${tool.mode} key comes from the table`
  );
}
expect(
  editorKeyAction({ key: "w", meta: true }, false) === null,
  "⌘W stays the browser's"
);
expect(
  editorKeyAction({ key: "w", ctrl: true }, false) === null,
  "Ctrl+W stays the browser's"
);
expect(
  editorKeyAction({ key: "W", shift: true }, false) === null,
  "Shift+W is not Wire"
);
expect(
  editorKeyAction({ key: "w", alt: true }, false) === null,
  "Alt+W is not Wire"
);
expect(
  editorKeyAction({ key: "w" }, true) === null,
  "W is a letter while typing, not Wire"
);
expect(
  SHORTCUTS.some(
    (row) =>
      row.id === "world-tool-wire" &&
      row.scope === "global" &&
      row.keys.join() === "W" &&
      row.ignoreEditable === true
  ),
  "the Wire key is in the registry, and yields to a field"
);
expect(
  matchesShortcut({ key: "w" }, "world-tool-wire", { mac: true }),
  "w matches the Wire row"
);
expect(
  !matchesShortcut({ key: "w", metaKey: true }, "world-tool-wire", {
    mac: true,
  }),
  "⌘W does not match the Wire row"
);
expect(
  !matchesShortcut(
    { key: "w", target: { tagName: "TEXTAREA" } },
    "world-tool-wire",
    { mac: true }
  ),
  "the Wire row yields to a field"
);
expect(
  SHORTCUTS.some(
    (row) =>
      row.id === "world-tool-escape" &&
      row.scope === "global" &&
      row.keys.join() === "Esc"
  ),
  "the tool Esc is in the registry"
);
expect(
  matchesShortcut({ key: "Escape" }, "world-tool-escape", { mac: true }),
  "Escape matches the tool Esc"
);
expect(
  !matchesShortcut(
    { key: "Escape", target: { tagName: "INPUT" } },
    "world-tool-escape",
    { mac: true }
  ),
  "the tool Esc yields to a field"
);
expect(
  toolEscape(WORLD_TOOL_START).did === null,
  "Esc in Select is left to the selection clear"
);

console.log("world-keys.selfcheck ok");
