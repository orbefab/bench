import type { LogicRatings, LogicThreshold } from "@sfab-bench/contract";
import { siValue } from "./si";

/** Volts at the edges of a logic input: low below `vil`, high above `vih`. */
export type LogicThresholds = { vil: number | null; vih: number | null };

export function isSupplyThreshold(
  value: LogicThreshold | undefined
): value is readonly [number, number] {
  return Array.isArray(value);
}

/** Null when absent, or `[k, b]` with no `vcc`. */
export function thresholdVolts(
  value: LogicThreshold | undefined,
  vcc: number | null
): number | null {
  if (value === undefined) return null;
  if (!isSupplyThreshold(value)) return siValue(value);
  if (vcc === null) return null;
  return value[0] * vcc + value[1];
}

/**
 * One port's input edges at `vcc`. The static check passes the cited
 * `logic.vcc`; a run passes the solved board node.
 */
export function logicThresholds(
  logic: LogicRatings | undefined,
  vcc: number | null
): LogicThresholds {
  return {
    vil: thresholdVolts(logic?.vil, vcc),
    vih: thresholdVolts(logic?.vih, vcc),
  };
}

/** The cited supply, or null. */
export function citedVcc(logic: LogicRatings | undefined): number | null {
  return logic?.vcc === undefined ? null : siValue(logic.vcc);
}

/**
 * The input's next level. Above `vih` is high, below `vil` is low, and
 * between them (the datasheet's undefined band) the previous level holds.
 */
export function logicLevel(
  volts: number,
  edges: LogicThresholds,
  previous: boolean
): boolean {
  if (edges.vih !== null && volts > edges.vih) return true;
  if (edges.vil !== null && volts < edges.vil) return false;
  return previous;
}
