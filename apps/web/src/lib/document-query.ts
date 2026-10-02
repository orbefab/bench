import { isRunDocumentPath } from "@sfab-bench/contract";

/** `?world=` beside `?file=`. Opening one clears the other. See ADR 0009 D-004. */

export type OpenDocument =
  | { kind: "none" }
  | { kind: "file"; path: string }
  | { kind: "world"; path: string };

/** A legacy `.world.json`, or a root part under `parts/<pub>/`. */
export function isWorldFilePath(path: string): boolean {
  return isRunDocumentPath(path);
}

/** `?world=` wins when a hand-edited URL names both. Opening either clears the other. */
export function readOpenDocument(search: string): OpenDocument {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(raw);
  const world = params.get("world")?.trim() ?? "";
  const file = params.get("file")?.trim() ?? "";
  if (world) return { kind: "world", path: world };
  if (file) return { kind: "file", path: file };
  return { kind: "none" };
}

/** Drop both document params, then set the one this open names. `?project=` stays. */
export function applyOpenDocument(
  params: URLSearchParams,
  doc: OpenDocument
): void {
  params.delete("file");
  params.delete("world");
  if (doc.kind === "file" && doc.path) params.set("file", doc.path);
  else if (doc.kind === "world" && doc.path) params.set("world", doc.path);
}

let suppressHistory = false;

/** Popstate applies the URL the browser already restored, so it must not write history. */
export function ignoreDocumentHistory(fn: () => void) {
  const prev = suppressHistory;
  suppressHistory = true;
  try {
    fn();
  } finally {
    suppressHistory = prev;
  }
}

/**
 * Keep the open document in the page URL.
 * `push` is a user open (back/forward returns to the previous document).
 * `replace` is a boot sync, a retry, or a folder change.
 */
export function syncOpenDocument(doc: OpenDocument, mode: "push" | "replace") {
  if (typeof window === "undefined" || suppressHistory) return;
  const next = new URL(window.location.href);
  applyOpenDocument(next.searchParams, doc);
  const want = next.pathname + next.search + next.hash;
  const have =
    window.location.pathname + window.location.search + window.location.hash;
  if (want === have) return;
  if (mode === "push") window.history.pushState(null, "", want);
  else window.history.replaceState(null, "", want);
}
