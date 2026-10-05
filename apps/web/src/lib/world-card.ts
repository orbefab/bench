/**
 * What the card shows for one instance: ports, params, and one picker
 * per axis. A grayed option is not runnable. The resolved option is
 * never grayed: a placeholder mesh still resolves, and the plan draws
 * the lower box instead.
 */

import {
  type AxisName,
  isStructured,
  type StructuredDecl,
  type StructuredValue,
  type WorldViewCapture,
  type WorldViewLevelOption,
  type WorldViewNode,
  type WorldViewPort,
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

export type CardParam = {
  name: string;
  value: number | string | boolean;
  /** Set when this param was filled from the parent via `$param`. */
  forward?: { from: string; param: string };
};

/**
 * A program or a value set. `decl` is what the instance's form declares,
 * null when the param only reaches a child (`$param`); `value` is null
 * when the instance does not set it yet.
 */
export type CardStructured = {
  name: string;
  decl: StructuredDecl | null;
  value: StructuredValue | null;
  forward?: { from: string; param: string };
};

/** `from nano.firmware`. The names are the forward record, not a literal. */
export function forwardLabel(forward: { from: string; param: string }): string {
  return `from ${forward.from}.${forward.param}`;
}

export type InstanceCard = {
  ports: WorldViewPort[];
  params: CardParam[];
  structured: CardStructured[];
  axes: CardAxis[];
};

export function instanceCard(node: WorldViewNode): InstanceCard {
  const params: CardParam[] = [];
  const structured: CardStructured[] = [];
  for (const name of Object.keys(node.params)) {
    const value = node.params[name];
    if (value === undefined) continue;
    const forward = node.forwards?.[name];
    const from = forward
      ? { forward: { from: forward.from, param: forward.param } }
      : {};
    if (isStructured(value)) {
      const decl = node.structured?.[name] ?? null;
      structured.push({ name, decl, value, ...from });
    } else {
      params.push({ name, value, ...from });
    }
  }
  for (const [name, decl] of Object.entries(node.structured ?? {})) {
    if (Object.hasOwn(node.params, name)) continue;
    structured.push({ name, decl, value: null });
  }
  return {
    ports: node.ports.map((port) => ({ ...port })),
    params,
    structured,
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
