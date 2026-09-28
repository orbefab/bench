/**
 * Editor keys. They do nothing while an input or the chat has focus.
 * Undo is ⌘/Ctrl+Z. Redo is ⇧⌘/Ctrl+Shift+Z, and also Ctrl+Y.
 */

export type EditorKey = {
  key: string;
  meta?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
};

export type EditorAction = "undo" | "redo" | "play" | "delete" | "rename";

export function editorKeyAction(
  event: EditorKey,
  typing: boolean
): EditorAction | null {
  if (typing) return null;
  if (event.alt) return null;
  const key = event.key;
  const mod = Boolean(event.meta || event.ctrl);
  if (mod && !event.shift && (key === "z" || key === "Z")) return "undo";
  if (mod && event.shift && (key === "z" || key === "Z")) return "redo";
  if (
    event.ctrl &&
    !event.meta &&
    !event.shift &&
    (key === "y" || key === "Y")
  ) {
    return "redo";
  }
  if (!mod && !event.shift && (key === " " || key === "Spacebar"))
    return "play";
  if (!mod && !event.shift && (key === "Delete" || key === "Backspace")) {
    return "delete";
  }
  if (!mod && !event.shift && key === "F2") return "rename";
  return null;
}
