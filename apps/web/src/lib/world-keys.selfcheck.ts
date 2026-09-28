import { editorKeyAction } from "./world-keys";

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

console.log("world-keys.selfcheck ok");
