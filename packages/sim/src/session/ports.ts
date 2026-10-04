/**
 * An instance read at one of its own ports, whatever level it runs at. A
 * group running in detail and the same group running as its snapshot read
 * the same way, so a check can hold one against the other port by port.
 *
 * - A port on a rail: the node its net sits on, and the current the
 *   elements under the instance draw out of that node. A snapshot run as
 *   a circuit form finds the node through its watch, which names the
 *   form port behind each of the part's own ports. A form the rail holds
 *   as a lumped slot, not as elements, reads its own draw on its power
 *   port.
 * - A port no electrical wire reaches: the angle of the joint the
 *   instance drives. An electrical port no rail holds has no reading.
 */

import type { RailCircuit } from "../rail-circuit";
import type { SessionState } from "./state";

export type PortReading = {
  /** Volts at the port's node against ground. Null off a rail. */
  voltage: number | null;
  /**
   * Amperes out of the node into the instance. Null on ground, off a
   * rail, and where the run does not attribute a current to this port.
   */
  current: number | null;
  /** Radians of the joint the instance drives. Null on a wired port. */
  angle: number | null;
};

/** Every `path.port` on the same electrical net as `full`, `full` first. */
function netOf(wires: readonly [string, string][], full: string): string[] {
  const head =
    wires.find(([first, other]) => first === full || other === full)?.[0] ??
    full;
  const out = [full];
  if (head !== full) out.push(head);
  for (const [first, other] of wires) {
    if (first === head && other !== full) out.push(other);
  }
  return out;
}

export function portReading(
  s: SessionState,
  path: string,
  port: string
): PortReading | null {
  if (!s.runPlan) return null;
  const full = `${path}.${port}`;
  const net = netOf(s.runPlan.wires, full);
  const seen = new Set<RailCircuit>();
  for (const group of s.rails.values()) {
    const circuit = group.circuit;
    if (seen.has(circuit)) continue;
    seen.add(circuit);
    let node: string | null = null;
    for (const member of net) {
      node = circuit.stampedNode(member);
      if (node !== null) break;
    }
    const elements = circuit.elementsUnder(path);
    if (node === null && elements.length > 0) node = watchedNode(s, path, port);
    if (node === null) continue;
    if (node === "0") return { voltage: 0, current: null, angle: null };
    return {
      voltage: circuit.nodeVoltage(node),
      current:
        elements.length > 0
          ? circuit.currentLeaving(elements, node)
          : slotDraw(s, path, port),
      angle: null,
    };
  }
  const wired = s.runPlan.wires.some(
    ([first, other]) => first === full || other === full
  );
  if (wired) return null;
  const angle = drivenAngle(s, path);
  return angle === null ? null : { voltage: null, current: null, angle };
}

/** The node a form-run snapshot stamped behind its part's own `port`. */
function watchedNode(
  s: SessionState,
  path: string,
  port: string
): string | null {
  const plan = s.runPlan;
  if (!plan) return null;
  const stamped = [
    ...(plan.spans ?? []).map((row) => row.part),
    ...[...plan.boards, ...plan.supplies].flatMap(
      (holder) => holder.stamp?.parts ?? []
    ),
  ];
  const part = stamped.find((row) => row.path === path);
  if (!part?.watch) return null;
  const form = Object.entries(part.watch.ports).find(
    ([, own]) => own === port
  )?.[0];
  return form === undefined ? null : (part.nodes[form] ?? null);
}

/** A lumped part's own draw, read on the port its type calls power. */
function slotDraw(s: SessionState, path: string, port: string): number | null {
  const part = s.runPlan?.parts.find((row) => row.id === path);
  if (part?.pins[port]?.kind !== "power") return null;
  return s.loads.find((load) => load.partId === path)?.current ?? null;
}

/** The joint a shaft or a lumped part named `path` drives. */
function drivenAngle(s: SessionState, path: string): number | null {
  const plan = s.runPlan;
  if (!plan || !s.sim || !s.layout) return null;
  const drives =
    plan.shafts?.find((row) => row.id === path)?.drives ??
    plan.parts.find((row) => row.id === path)?.drives;
  if (!drives) return null;
  const joint = s.layout.joints.find(
    (row) => row.robot === drives.robot && row.joint === drives.joint
  );
  if (!joint) return null;
  return (s.sim.data.qpos as Float64Array)[joint.qposadr] ?? null;
}
