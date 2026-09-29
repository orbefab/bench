/**
 * The operations the card and the tree send. Pure: each builder returns the
 * one operation, or null when there is nothing to change. `commitEdit` in
 * `state/world-edit.ts` sends them.
 */

import {
  DEFAULT_TIMESTEP_S,
  type EditOp,
  type WorldViewNode,
  type WorldViewPlay,
} from "@sfab-bench/contract";

import type { InstanceTarget, WireTarget } from "@/lib/world-edit-target";

/** A card field: the text typed, against the value the card showed. */
export function setParamOp(
  target: InstanceTarget,
  name: string,
  raw: string,
  previous: number | string | boolean
): EditOp | null {
  let value: number | string | boolean = raw;
  if (typeof previous === "number") {
    const next = Number(raw);
    if (!Number.isFinite(next) || next === previous) return null;
    value = next;
  } else if (typeof previous === "boolean") {
    value = raw === "true";
    if (value === previous) return null;
  } else if (raw === previous) {
    return null;
  }
  return {
    kind: "set-param",
    document: target.document,
    id: target.id,
    name,
    value,
  };
}

export type LevelOption = {
  class: 0 | 1 | 2 | 3;
  variant: string;
  runnable: boolean;
  chosen: boolean;
};

export function setLevelOp(
  document: string,
  path: string,
  axis: WorldViewNode["levels"][number]["axis"],
  option: LevelOption
): EditOp | null {
  if (!option.runnable || option.chosen) return null;
  return {
    kind: "set-level",
    document,
    scope: "path",
    key: path,
    axis,
    class: option.class,
    variant: option.variant,
  };
}

export type PlayChange = {
  gravity?: [number, number, number];
  seed?: number;
  timestep?: number;
};

export function setPlayOp(
  document: string,
  current: WorldViewPlay,
  next: PlayChange
): EditOp | null {
  if (next.gravity?.every((value, index) => value === current.gravity[index])) {
    return null;
  }
  if (next.seed !== undefined && next.seed === current.seed) return null;
  if (
    next.timestep !== undefined &&
    next.timestep === (current.timestep ?? DEFAULT_TIMESTEP_S)
  ) {
    return null;
  }
  return { kind: "set-play", document, ...next };
}

/** The new file name is trimmed; an empty or unchanged one is no edit. */
export function renamePartOp(
  document: string,
  name: string,
  draft: string
): EditOp | null {
  const to = draft.trim();
  if (!to || to === name) return null;
  return { kind: "rename-part", document, to };
}

export function unwireOp(target: WireTarget): EditOp {
  return {
    kind: "unwire",
    document: target.document,
    a: target.a,
    b: target.b,
  };
}

export function removeInstanceOp(target: InstanceTarget): EditOp {
  return { kind: "remove-instance", document: target.document, id: target.id };
}

export function renameInstanceOp(
  target: InstanceTarget,
  name: string,
  draft: string
): EditOp | null {
  const to = draft.trim();
  if (!to || to === name) return null;
  return {
    kind: "rename-instance",
    document: target.document,
    id: target.id,
    to,
  };
}
