/**
 * What the card shows for one instance: ports, params, and one picker
 * per axis. A grayed option is not runnable. The resolved one is chosen.
 */

import type {
  AxisName,
  WorldViewLevelOption,
  WorldViewNode,
  WorldViewPort,
} from "@sfab-bench/contract";

export type CardOption = WorldViewLevelOption & { chosen: boolean };

export type CardAxis = {
  axis: AxisName;
  options: CardOption[];
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
      options: axis.options.map((option) => ({
        ...option,
        chosen:
          axis.chosen !== null &&
          axis.chosen.class === option.class &&
          axis.chosen.variant === option.variant,
      })),
    })),
  };
}
