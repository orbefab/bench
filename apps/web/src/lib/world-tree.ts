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
