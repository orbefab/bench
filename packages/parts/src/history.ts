import type { EditOp } from "@sfab-bench/contract";

/**
 * One undo step. `before` and `after` are SHA-256 of the part file
 * text. A new edit clears redo. The stack keeps `HISTORY_DEPTH` steps.
 */
export const HISTORY_DEPTH = 200;

export type HistoryStep = {
  label: string;
  op: EditOp;
  inverse: EditOp;
  before: string;
  after: string;
};

export type History = {
  undo: HistoryStep[];
  redo: HistoryStep[];
};

export function emptyHistory(): History {
  return { undo: [], redo: [] };
}
