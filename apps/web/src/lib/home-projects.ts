/** Recent project folders for the home grid and the sidebar list. */

export type HomeFolder = {
  path: string;
  name: string;
};

function folderTitle(path: string, name: string | undefined): string {
  const trimmed = name?.trim() ?? "";
  if (trimmed) return trimmed;
  return path.split("/").filter(Boolean).pop() || path;
}

/**
 * The open folder first, then recents. Duplicate paths collapse.
 * A blank name falls back to the last path segment.
 */
export function homeFolderList(
  current: { path: string; name?: string } | null,
  recents: readonly { path: string; name?: string }[]
): HomeFolder[] {
  const out: HomeFolder[] = [];
  const seen = new Set<string>();
  const push = (row: { path: string; name?: string } | null | undefined) => {
    const path = row?.path?.trim() ?? "";
    if (!path || seen.has(path)) return;
    seen.add(path);
    out.push({ path, name: folderTitle(path, row?.name) });
  };
  push(current);
  for (const row of recents) push(row);
  return out;
}

/** A Quest client cannot register folders. The card is host-only. */
export function homeOpenFolderCard(canRegister: boolean): boolean {
  return canRegister;
}
