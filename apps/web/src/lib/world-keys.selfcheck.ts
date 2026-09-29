import { matchesShortcut, SHORTCUTS } from "./shortcuts";
import { editorKeyAction } from "./world-keys";
import { toolEscape, WORLD_TOOL_START } from "./world-tool";

function expect(cond: boolean, label: string) {
  if (!cond) throw new Error(label);
}

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
expect(editorKeyAction({ key: "w" }, false) === "wire", "W enters Wire");
expect(
  editorKeyAction({ key: "W" }, false) === "wire",
  "W with caps lock is still Wire"
);
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
