/**
 * The words for a refused edit. The server sends the refusal's parts; for
 * the two Wire refusals the detail is already the whole sentence, so the
 * edit line shows only that. Every other refusal shows the message as sent.
 */

import type { WorldServerMessage } from "@sfab-bench/contract";

type EditRefused = Extract<WorldServerMessage, { type: "edit-refused" }>;

export function editRefusalText(
  refused: Pick<EditRefused, "message" | "refusal">
): string {
  const { refusal } = refused;
  return refusal?.code ? refusal.detail : refused.message;
}

/** The quiet line for undo or redo with nothing to step to. */
export function historyRefusalTitle(kind: "undo" | "redo"): string {
  return kind === "redo" ? "Nothing to redo." : "Nothing to undo.";
}
