/** Tab folder, next to `?file=`. See ADR 0006. */

export function projectUrl(): string {
  if (typeof window === "undefined") return "";
  return (
    new URLSearchParams(window.location.search).get("project")?.trim() ?? ""
  );
}

/**
 * Keep `?project=` in the page URL. Switching folders drops `?file=` and
 * `?world=` unless `clearFile` is false (a deep link must not lose its
 * document while the folder query is filled in).
 */
export function syncProjectQuery(path: string, opts?: { clearFile?: boolean }) {
  if (typeof window === "undefined") return;
  const next = new URL(window.location.href);
  const prev = next.searchParams.get("project")?.trim() ?? "";
  const abs = path.trim();
  const changed = prev !== abs;
  if (abs) next.searchParams.set("project", abs);
  else next.searchParams.delete("project");
  if (changed && opts?.clearFile !== false) {
    next.searchParams.delete("file");
    next.searchParams.delete("world");
  }
  const want = next.pathname + next.search + next.hash;
  const have =
    window.location.pathname + window.location.search + window.location.hash;
  if (want !== have) window.history.replaceState(null, "", want);
  if (changed) window.dispatchEvent(new Event("sfab-project"));
}
