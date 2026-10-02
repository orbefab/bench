/** The client view of a run plan. Not a file format. */

import type { WorldView, WorldViewNode } from "@sfab-bench/contract";

import type { RunPlan } from "./plan";
import { powerFeedsOf } from "./wiring";

const EMPTY_TREE: WorldView["tree"] = {
  part: "",
  stage: "",
  play: { gravity: [0, 0, -9.81], seed: 0 },
  nodes: [],
};

export function viewOf(plan: RunPlan): WorldView {
  const view: WorldView = {
    environment: {
      ground: { plane: plan.environment.ground.plane },
      ...(plan.environment.primitives
        ? { primitives: plan.environment.primitives }
        : {}),
      ...(plan.environment.stepProps
        ? { stepProps: plan.environment.stepProps }
        : {}),
      ...(plan.environment.targets.length > 0
        ? { targets: plan.environment.targets }
        : {}),
    },
    robots: plan.robots.map((robot) => ({
      id: robot.id,
      urdf: robot.urdf,
      pose: robot.pose,
    })),
    boards: plan.boards.map((board) => ({
      id: board.id,
      chip: board.chip,
      firmware: board.firmware,
      ...(board.source ? { source: board.source } : {}),
      pose: board.pose,
      size: board.size,
      brownoutVoltage: board.brownoutVoltage,
      minOperatingVoltage: board.minOperatingVoltage,
      clock: board.clock,
      pins: board.pinOrder,
      ledPin: board.stamp?.ledPin ?? null,
    })),
    supplies: plan.supplies.map((supply) => ({
      id: supply.id,
      voltage: supply.voltage,
      currentLimit: supply.currentLimit,
      rSeries: supply.rSeries,
    })),
    parts: [
      ...plan.parts.map((part) => ({
        id: part.id,
        model: part.model,
        ...(part.drives ? { drives: part.drives } : {}),
        signalPin: part.drive.kind === "servo" ? part.drive.pin : null,
      })),
      ...(plan.rangers ?? []).map((ranger) => ({
        id: ranger.id,
        model: ranger.model,
        signalPin: null,
        ranger: true as const,
      })),
      ...(plan.leaves ?? [])
        .filter(
          (leaf) =>
            !plan.parts.some((part) => part.id === leaf.id) &&
            !(plan.rangers ?? []).some((ranger) => ranger.id === leaf.id)
        )
        .map((leaf) => ({
          id: leaf.id,
          model: leaf.model,
          signalPin: null,
        })),
    ],
    boxes: (plan.boxes ?? []).map((box) => ({
      id: box.id,
      pose: box.pose,
      size: box.size,
      pick: box.pick,
    })),
    wires: plan.shownWires.map((wire) => [wire[0], wire[1]]),
    feeds: powerFeedsOf(plan),
    tree: plan.tree ?? EMPTY_TREE,
  };
  if (plan.tree) {
    const missing = missingViewIds(view);
    if (missing.length > 0) {
      throw new Error(
        `a view id is missing from the part tree: ${missing.join(", ")}`
      );
    }
  }
  return view;
}

/**
 * Every robot, board, supply, part, and box id is a node. A box whose
 * id is not in `parts` or `supplies` is a leaf.
 */
export function viewIdsAreNodes(view: WorldView): boolean {
  return missingViewIds(view).length === 0;
}

function missingViewIds(view: WorldView): string[] {
  const roles = new Map<string, WorldViewNode["role"]>();
  const walk = (nodes: readonly WorldViewNode[]) => {
    for (const node of nodes) {
      roles.set(node.id, node.role);
      walk(node.children);
    }
  };
  walk(view.tree.nodes);
  const has = (id: string, role: WorldViewNode["role"]) =>
    roles.get(id) === role;
  const missing: string[] = [];
  for (const row of view.robots) {
    if (!has(row.id, "robot")) missing.push(`robot ${row.id}`);
  }
  for (const row of view.boards) {
    if (!has(row.id, "board")) missing.push(`board ${row.id}`);
  }
  for (const row of view.supplies) {
    if (!has(row.id, "supply")) missing.push(`supply ${row.id}`);
  }
  for (const row of view.parts) {
    if (!has(row.id, "part")) missing.push(`part ${row.id}`);
  }
  for (const row of view.boxes) {
    const role = roles.get(row.id);
    const ok =
      row.pick === "supply"
        ? role === "supply"
        : role === "part" || role === "leaf";
    if (!ok) missing.push(`box ${row.id}`);
  }
  return missing;
}
