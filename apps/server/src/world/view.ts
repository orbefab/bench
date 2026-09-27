/** The client view of a run plan. Not a file format. */

import type { WorldView } from "@sfab-bench/contract";

import type { RunPlan } from "./plan";
import { powerFeedsOf } from "./wiring";

export function viewOf(plan: RunPlan): WorldView {
  return {
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
  };
}
