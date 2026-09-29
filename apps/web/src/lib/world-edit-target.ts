/**
 * Which part an edit names. A nested instance is edited in the part
 * that owns it. The run path's last segment is the local id.
 *
 * The open document is named by the tab's file path, the one name the
 * socket accepts for it on any tab. A part id names only a nested owner,
 * and that one comes with `part`.
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
  path: string,
  openDocument: string
): InstanceTarget | null {
  if (path === "$root") return null;
  const found = findParent(tree.nodes, path, null);
  if (!found) return null;
  const owner = found.parent ? found.parent.part : tree.part;
  return address(tree, owner, found.node.name, openDocument);
}

/**
 * The stage scene as the open document's own instance. Only when the
 * scene is not the document: then `$root` is one instance the document
 * owns, named by its id there.
 */
export function stageEditTarget(
  tree: WorldViewTree,
  openDocument: string
): InstanceTarget | null {
  if (tree.stage === tree.part) return null;
  const root = findViewNode(tree.nodes, "$root");
  if (!root) return null;
  return address(tree, tree.part, root.name, openDocument);
}

export function wireEditTarget(
  tree: WorldViewTree,
  ownerPath: string,
  index: number,
  openDocument: string
): WireTarget | null {
  const node = findViewNode(tree.nodes, ownerPath);
  const wire = node?.wires?.[index];
  if (!node || !wire) return null;
  const named = address(tree, node.part, node.name, openDocument);
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
  id: string,
  openDocument: string
): InstanceTarget {
  if (owner === tree.part) return { document: openDocument, id };
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
