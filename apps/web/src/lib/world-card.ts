/**
 * What the card shows for one instance: ports, params, and one picker
 * per axis. A grayed option is not runnable. The resolved option is
 * never grayed: a placeholder mesh still resolves, and the plan draws
 * the lower box instead.
 */

import type {
  AxisName,
  WorldViewCapture,
  WorldViewLevelOption,
  WorldViewNode,
  WorldViewPort,
} from "@sfab-bench/contract";

export type CardOption = WorldViewLevelOption & {
  chosen: boolean;
  /** Grayed. The resolved option stays available even when it is not runnable. */
  gray: boolean;
};

export type CardAxis = {
  axis: AxisName;
  options: CardOption[];
  /** Whether Capture can run here. Absent on an axis that never captures. */
  capture?: WorldViewCapture;
};

export type InstanceCard = {
  ports: WorldViewPort[];
  params: { name: string; value: number | string | boolean }[];
  axes: CardAxis[];
};

export function instanceCard(node: WorldViewNode): InstanceCard {
  const params: InstanceCard["params"] = [];
  for (const name of Object.keys(node.params)) {
    const value = node.params[name];
    if (value === undefined) continue;
    params.push({ name, value });
  }
  return {
    ports: node.ports.map((port) => ({ ...port })),
    params,
    axes: node.levels.map((axis) => ({
      axis: axis.axis,
      ...(axis.capture ? { capture: axis.capture } : {}),
      options: axis.options.map((option) => {
        const chosen =
          axis.chosen !== null &&
          axis.chosen.class === option.class &&
          axis.chosen.variant === option.variant;
        return {
          ...option,
          chosen,
          gray: !option.runnable && !chosen,
        };
      }),
    })),
  };
}
