/**
 * Rename part file, from a view node. A project file renames. A
 * library or catalog part stays disabled, with the reason on the button.
 */

import type { WorldViewPartSource } from "@sfab-bench/contract";

export const RENAME_LIBRARY_REASON =
  "Library part — read-only; renaming library parts comes later";

export type RenamePartTarget =
  | { enabled: true }
  | { enabled: false; reason: string };

export function partFileName(id: string): string {
  const slash = id.lastIndexOf("/");
  const at = id.indexOf("@", slash + 1);
  if (slash < 0 || at <= slash) return id;
  return id.slice(slash + 1, at);
}

export function renamePartTarget(node: {
  source?: WorldViewPartSource;
}): RenamePartTarget {
  if (node.source === "library" || node.source === "catalog") {
    return { enabled: false, reason: RENAME_LIBRARY_REASON };
  }
  if (node.source === "project") return { enabled: true };
  return { enabled: false, reason: "This part has no project file" };
}
