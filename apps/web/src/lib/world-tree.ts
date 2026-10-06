/**
 * Rows for the part tree. Wires sit under the assembly that owns them.
 * A collapsed parent carries a descendant's warning.
 */

import type { WorldViewNode } from "@sfab-bench/contract";

export type TreeRow = {
  key: string;
  kind: "instance" | "wire";
  depth: number;
  name: string;
  /** Instance path, or the assembly that owns a wire. */
  path: string;
  warning: boolean;
  /** The row is collapsed and a hidden descendant has a warning. */
  collapsedWarning: boolean;
  wireIndex?: number;
};

export function findViewNode(
  nodes: readonly WorldViewNode[],
  id: string
): WorldViewNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = findViewNode(node.children, id);
    if (child) return child;
  }
  return null;
}

export function viewPaths(
  nodes: readonly WorldViewNode[],
  into: string[] = []
): string[] {
  for (const node of nodes) {
    into.push(node.id);
    viewPaths(node.children, into);
  }
  return into;
}

export function treeRows(
  nodes: readonly WorldViewNode[],
  warnings: ReadonlySet<string>,
  collapsed: ReadonlySet<string>,
  depth = 0
): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const node of nodes) {
    const hidden = collapsed.has(node.id);
    const childWarning = descendantWarned(node, warnings);
    rows.push({
      key: node.id,
      kind: "instance",
      depth,
      name: node.name,
      path: node.id,
      warning: warnings.has(node.id),
      collapsedWarning: hidden && childWarning,
    });
    if (hidden) continue;
    rows.push(...treeRows(node.children, warnings, collapsed, depth + 1));
    const wires = node.wires ?? [];
    for (let index = 0; index < wires.length; index++) {
      const wire = wires[index];
      if (!wire) continue;
      rows.push({
        key: `${node.id}#wire:${index}`,
        kind: "wire",
        depth: depth + 1,
        name: `${wire.a} → ${wire.b}`,
        path: node.id,
        warning: false,
        collapsedWarning: false,
        wireIndex: index,
      });
    }
  }
  return rows;
}

/**
 * Keep a name match, the ancestors that lead to it, and that row's
 * subtree. A blank query returns every row.
 */
export function filterTreeRows(
  rows: readonly TreeRow[],
  query: string
): TreeRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows.slice();
  const keep = new Array<boolean>(rows.length).fill(false);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row?.name.toLowerCase().includes(q)) continue;
    keep[i] = true;
    let depth = row.depth;
    for (let j = i - 1; j >= 0 && depth > 0; j--) {
      const parent = rows[j];
      if (!parent || parent.depth >= depth) continue;
      keep[j] = true;
      depth = parent.depth;
    }
    for (let j = i + 1; j < rows.length; j++) {
      const child = rows[j];
      if (!child || child.depth <= row.depth) break;
      keep[j] = true;
    }
  }
  return rows.filter((_, index) => keep[index]);
}

/** Deeper than the stage's own children. Depth 0 stays open. */
export function initialCollapsed(nodes: readonly WorldViewNode[]): Set<string> {
  const collapsed = new Set<string>();
  collectCollapsed(nodes, 0, collapsed);
  return collapsed;
}

function collectCollapsed(
  nodes: readonly WorldViewNode[],
  depth: number,
  into: Set<string>
) {
  for (const node of nodes) {
    const foldable = node.children.length > 0 || (node.wires?.length ?? 0) > 0;
    if (depth >= 1 && foldable) into.add(node.id);
    collectCollapsed(node.children, depth + 1, into);
  }
}

/** Open every ancestor so a stage pick is visible. A wire also opens its owner. */
export function revealCollapsed(
  collapsed: ReadonlySet<string>,
  nodes: readonly WorldViewNode[],
  path: string,
  kind: "instance" | "wire"
): ReadonlySet<string> {
  const ancestors = ancestorIds(nodes, path);
  if (!ancestors) return collapsed;
  let changed = false;
  const next = new Set(collapsed);
  for (const id of ancestors) {
    if (next.delete(id)) changed = true;
  }
  if (kind === "wire" && next.delete(path)) changed = true;
  return changed ? next : collapsed;
}

/**
 * One pass of the part-tree fold. Seeds only when the document path
 * changes, then opens a selection. Returns the same set when neither
 * changes, so a set-play reload does not write state.
 */
export function nextCollapse(input: {
  collapsed: ReadonlySet<string>;
  nodes: readonly WorldViewNode[];
  documentPath: string;
  seededPath: string | null;
  target: string | null;
  kind: "instance" | "wire";
}): { collapsed: ReadonlySet<string>; seededPath: string; wrote: boolean } {
  const seeding = input.seededPath !== input.documentPath;
  const base = seeding ? initialCollapsed(input.nodes) : input.collapsed;
  const collapsed = input.target
    ? revealCollapsed(base, input.nodes, input.target, input.kind)
    : base;
  return {
    collapsed,
    seededPath: input.documentPath,
    wrote: collapsed !== input.collapsed,
  };
}

function ancestorIds(
  nodes: readonly WorldViewNode[],
  id: string,
  prefix: string[] = []
): string[] | null {
  for (const node of nodes) {
    if (node.id === id) return prefix;
    const child = ancestorIds(node.children, id, [...prefix, node.id]);
    if (child) return child;
  }
  return null;
}

function descendantWarned(
  node: WorldViewNode,
  warnings: ReadonlySet<string>
): boolean {
  for (const child of node.children) {
    if (warnings.has(child.id) || descendantWarned(child, warnings))
      return true;
  }
  return false;
}
