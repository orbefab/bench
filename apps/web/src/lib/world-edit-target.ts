/**
 * Which part an edit names. A nested instance is edited in the part
 * that owns it. The run path's last segment is the local id.
 */

import type { WorldViewNode, WorldViewTree } from "@sfab-bench/contract";

import { findViewNode } from "@/lib/world-tree";

export type InstanceTarget = {
  /** Part id the socket `part` field names. The root document when omitted. */
  part?: string;
  /** Document name on the operation. */
  document: string;
  /** Instance id inside that part. */
  id: string;
};

export type WireTarget = {
  part?: string;
  document: string;
  a: string;
  b: string;
};

export function instanceEditTarget(
  tree: WorldViewTree,
  path: string
): InstanceTarget | null {
  if (path === "$root") return null;
  const found = findParent(tree.nodes, path, null);
  if (!found) return null;
  const owner = found.parent ? found.parent.part : tree.part;
  return address(tree, owner, found.node.name);
}

export function wireEditTarget(
  tree: WorldViewTree,
  ownerPath: string,
  index: number
): WireTarget | null {
  const node = findViewNode(tree.nodes, ownerPath);
  const wire = node?.wires?.[index];
  if (!node || !wire) return null;
  const named = address(tree, node.part, node.name);
  return {
    ...(named.part ? { part: named.part } : {}),
    document: named.document,
    a: wire.a,
    b: wire.b,
  };
}

function address(
  tree: WorldViewTree,
  owner: string,
  id: string
): InstanceTarget {
  if (owner === tree.part) return { document: owner, id };
  return { part: owner, document: owner, id };
}

function findParent(
  nodes: readonly WorldViewNode[],
  id: string,
  parent: WorldViewNode | null
): { node: WorldViewNode; parent: WorldViewNode | null } | null {
  for (const node of nodes) {
    if (node.id === id) return { node, parent };
    const child = findParent(node.children, id, node);
    if (child) return child;
  }
  return null;
}
