/**
 * Where the Wire tool draws a port. The run has no port frames, so this is
 * a deterministic client rule, not the part's real geometry: a part's ports
 * sit on a small ring around its drawn body, ordered by name. Real frames
 * come with A5c, and this rule is what they replace.
 *
 * Only an instance the open part owns directly has markers; a nested
 * instance is wired from its own part.
 */

import type {
  Domain,
  Pose,
  WorldViewNode,
  WorldViewTree,
} from "@sfab-bench/contract";

import { instanceEditTarget } from "@/lib/world-edit-target";

export type Vec3 = [number, number, number];

/** A drawn body: the run path of the instance and its half extents, in metres. */
export type PortBody = { id: string; half: Vec3 };

export type PortMarker = {
  /** The wire end, `instance.port`, as the netlist writes it. */
  ref: string;
  /** Run path of the instance the port belongs to. */
  instance: string;
  name: string;
  /** Absent on a bubbled port; such a port is never dimmed. */
  domain?: Domain;
  wired: boolean;
  /** Document frame, metres. */
  position: Vec3;
  /** Marker radius, metres. */
  radius: number;
};

/**
 * A robot's size is not in the document; only its links are drawn. Its
 * ring uses this base footprint until A5c gives real frames.
 */
export const ROBOT_HALF: Vec3 = [0.05, 0.05, 0.02];

/** How far the ring stands off the body's edge, and above its top face. */
export const RING_GAP = 0.012;
export const RING_LIFT = 0.006;

const MIN_RADIUS = 0.0015;
const MAX_RADIUS = 0.005;

/**
 * `count` slots on an ellipse in the body's XY plane, on top of the body.
 * Slot i sits at angle 2πi/count from +X, so the same names always land in
 * the same places.
 */
export function ringSlots(
  half: Vec3,
  count: number
): { position: Vec3; radius: number }[] {
  if (count <= 0) return [];
  const a = half[0] + RING_GAP;
  const b = half[1] + RING_GAP;
  const z = half[2] + RING_LIFT;
  const perimeter = 2 * Math.PI * Math.sqrt((a * a + b * b) / 2);
  const radius = Math.min(
    MAX_RADIUS,
    Math.max(MIN_RADIUS, (perimeter / count) * 0.3)
  );
  const slots: { position: Vec3; radius: number }[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (2 * Math.PI * i) / count;
    slots.push({
      position: [a * Math.cos(angle), b * Math.sin(angle), z],
      radius,
    });
  }
  return slots;
}

function rotate(q: Pose["rotation"], v: Vec3): Vec3 {
  const [w, x, y, z] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

const byName = (a: { name: string }, b: { name: string }) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

function collect(
  nodes: readonly WorldViewNode[],
  into: WorldViewNode[] = []
): WorldViewNode[] {
  for (const node of nodes) {
    into.push(node);
    collect(node.children, into);
  }
  return into;
}

/**
 * Markers for the direct children of the open part that have a drawn body.
 * The ground, a target and the open part itself have no ports to wire here.
 */
export function wireMarkers(
  tree: WorldViewTree | null,
  bodies: readonly PortBody[],
  openDocument: string
): PortMarker[] {
  if (!tree) return [];
  const half = new Map(bodies.map((body) => [body.id, body.half]));
  const markers: PortMarker[] = [];
  for (const node of collect(tree.nodes)) {
    if (node.id === "$root") continue;
    if (node.role === "ground" || node.role === "target") continue;
    const size = half.get(node.id);
    if (!size || node.ports.length === 0) continue;
    const target = instanceEditTarget(tree, node.id, openDocument);
    if (!target || target.part !== undefined) continue;
    const ports = [...node.ports].sort(byName);
    const slots = ringSlots(size, ports.length);
    ports.forEach((port, i) => {
      const slot = slots[i];
      if (!slot) return;
      const local = rotate(node.pose.rotation, slot.position);
      markers.push({
        ref: `${target.id}.${port.name}`,
        instance: node.id,
        name: port.name,
        ...(port.domain ? { domain: port.domain } : {}),
        wired: port.wired,
        position: [
          node.pose.position[0] + local[0],
          node.pose.position[1] + local[1],
          node.pose.position[2] + local[2],
        ],
        radius: slot.radius,
      });
    });
  }
  return markers;
}
