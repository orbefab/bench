/** Shared viewer context for get_viewer / catalog. Client and server both import this. */

export type ViewerTreeItem = {
  name: string;
  ref?: string;
};

export type ViewerSnapshot = {
  file: string;
  empty: boolean;
  selected: string | null;
  selectedName: string | null;
  tree: ViewerTreeItem[];
  partCount: number;
  /** Present when the open document is a world. */
  playing?: boolean;
  /** Seconds. Present when the open document is a world. */
  simTime?: number;
  /**
   * This client's world selection (D-015). Present only when a world is
   * open. An instance path, plus `link` when the pick is one link of a
   * robot. Null when nothing in that world is selected.
   */
  selection?: { kind: "instance"; path: string; link?: string } | null;
};

export type CatalogEntry = {
  path: string;
  kind: "step" | "glb" | "world";
};

export function emptySnapshot(file = ""): ViewerSnapshot {
  return {
    file,
    empty: true,
    selected: null,
    selectedName: null,
    tree: [],
    partCount: 0,
  };
}

export function catalogLabel(path: string): string {
  const name = path.split("/").filter(Boolean).pop() ?? path;
  return name
    .replace(/\.world\.json$/i, "")
    .replace(/\.(step|stp|glb|gltf)$/i, "");
}

function flattenCatalog(files: CatalogEntry[]): CatalogEntry[] {
  return [...files].sort((a, b) =>
    catalogLabel(a.path).localeCompare(catalogLabel(b.path), undefined, {
      sensitivity: "base",
    })
  );
}

/** Recents that still exist, then the rest of the catalog A–Z (no duplicate rows). */
export function catalogSections(
  files: CatalogEntry[],
  recents: string[]
): { recents: CatalogEntry[]; rest: CatalogEntry[] } {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const recentRows: CatalogEntry[] = [];
  const seen = new Set<string>();
  for (const path of recents) {
    const hit = byPath.get(path);
    if (!hit || seen.has(path)) continue;
    recentRows.push(hit);
    seen.add(path);
  }
  return {
    recents: recentRows,
    rest: flattenCatalog(files).filter((f) => !seen.has(f.path)),
  };
}

export type CatalogDir = {
  type: "dir";
  name: string;
  path: string;
  children: CatalogNode[];
};

export type CatalogFile = {
  type: "file";
  name: string;
  path: string;
  kind: CatalogEntry["kind"];
  entry: CatalogEntry;
};

export type CatalogNode = CatalogDir | CatalogFile;

type MutableDir = {
  name: string;
  path: string;
  dirs: Map<string, MutableDir>;
  files: CatalogFile[];
};

function posixParts(path: string) {
  return path.replace(/\\/g, "/").split("/").filter(Boolean);
}

/** Folder tree of catalog documents. Empty dirs never appear. */
export function catalogTree(files: CatalogEntry[]): CatalogNode[] {
  const root: MutableDir = { name: "", path: "", dirs: new Map(), files: [] };
  for (const entry of files) {
    const parts = posixParts(entry.path);
    if (parts.length === 0) continue;
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i]!;
      const dirPath = parts.slice(0, i + 1).join("/");
      let next = cur.dirs.get(name);
      if (!next) {
        next = { name, path: dirPath, dirs: new Map(), files: [] };
        cur.dirs.set(name, next);
      }
      cur = next;
    }
    const name = parts[parts.length - 1]!;
    cur.files.push({
      type: "file",
      name,
      path: entry.path,
      kind: entry.kind,
      entry,
    });
  }
  const freeze = (dir: MutableDir): CatalogNode[] => {
    const dirs: CatalogDir[] = [...dir.dirs.values()]
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      )
      .map((child) => ({
        type: "dir" as const,
        name: child.name,
        path: child.path,
        children: freeze(child),
      }));
    const listed = dir.files.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    );
    return [...dirs, ...listed];
  };
  return freeze(root);
}

/** Parent folder paths of a document, e.g. cad/STEP/parts/foo.step → cad, cad/STEP, cad/STEP/parts. */
export function catalogAncestors(filePath: string): string[] {
  const parts = posixParts(filePath);
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

function catalogQueryHit(path: string, name: string, q: string) {
  return (
    name.toLowerCase().includes(q) ||
    path.toLowerCase().includes(q) ||
    catalogLabel(path).toLowerCase().includes(q)
  );
}

export function filterCatalogTree(
  nodes: CatalogNode[],
  query: string
): CatalogNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;
  const walk = (list: CatalogNode[]): CatalogNode[] => {
    const out: CatalogNode[] = [];
    for (const node of list) {
      if (node.type === "file") {
        if (catalogQueryHit(node.path, node.name, q)) out.push(node);
        continue;
      }
      if (catalogQueryHit(node.path, node.name, q)) {
        out.push(node);
        continue;
      }
      const children = walk(node.children);
      if (children.length) out.push({ ...node, children });
    }
    return out;
  };
  return walk(nodes);
}

/** Documents under a tree node (a file is 1). */
export function catalogNodeCount(node: CatalogNode): number {
  if (node.type === "file") return 1;
  return node.children.reduce((n, child) => n + catalogNodeCount(child), 0);
}

export function catalogDirPaths(nodes: CatalogNode[]): string[] {
  const out: string[] = [];
  const walk = (list: CatalogNode[]) => {
    for (const node of list) {
      if (node.type !== "dir") continue;
      out.push(node.path);
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}
