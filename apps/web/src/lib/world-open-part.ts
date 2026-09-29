/**
 * Open part, from a view node. A project file opens. A library or
 * catalog part stays disabled, with the reason on the button.
 */

import type { WorldViewPartSource } from "@sfab-bench/contract";

export const LIBRARY_PART_REASON =
  "Library part — read-only; opening library parts comes later";

export type OpenPartTarget =
  | { enabled: true; file: string }
  | { enabled: false; reason: string };

export function openPartTarget(node: {
  source?: WorldViewPartSource;
  file?: string;
}): OpenPartTarget {
  if (node.source === "library" || node.source === "catalog") {
    return { enabled: false, reason: LIBRARY_PART_REASON };
  }
  if (node.source === "project" && node.file) {
    return { enabled: true, file: node.file };
  }
  return { enabled: false, reason: "This part has no project file" };
}
