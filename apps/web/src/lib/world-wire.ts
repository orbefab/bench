/**
 * The Wire gesture: click a port, then a second port. Pure; the store in
 * `state/world-tool.ts` holds the first port and sends the commit, and the
 * stage draws what these decide.
 */

import type { EditOp } from "@sfab-bench/contract";

import type { PortMarker } from "@/lib/world-ports";

export type WireTap = { type: "port"; ref: string } | { type: "empty" };

export type WireStep = {
  /** The first port now held, or null. */
  hold: string | null;
  /** The pair to wire, when the second port was just picked. */
  commit: { a: string; b: string } | null;
};

/**
 * First port holds. The same port again, or empty space, lets go. Any other
 * port is the second end: the pair is sent even across domains, and the
 * server's refusal is what the user reads.
 */
export function wireStep(hold: string | null, tap: WireTap): WireStep {
  if (tap.type === "empty") return { hold: null, commit: null };
  if (hold === null) return { hold: tap.ref, commit: null };
  if (hold === tap.ref) return { hold: null, commit: null };
  return { hold: null, commit: { a: hold, b: tap.ref } };
}

/**
 * While a first port is held, ports of another domain are dimmed. A port
 * whose domain is unknown (a bubbled one) is never dimmed.
 */
export function isDimmed(
  marker: Pick<PortMarker, "ref" | "domain">,
  held: Pick<PortMarker, "ref" | "domain"> | null
): boolean {
  if (!held || marker.ref === held.ref) return false;
  if (!marker.domain || !held.domain) return false;
  return marker.domain !== held.domain;
}

export type WireCommit = { ops: EditOp[]; label: string };

/** One `wire` op on the open document; one undo step. */
export function wireCommit(
  pair: { a: string; b: string },
  openDocument: string
): WireCommit {
  return {
    ops: [{ kind: "wire", document: openDocument, a: pair.a, b: pair.b }],
    label: `Wire ${pair.a} to ${pair.b}`,
  };
}
