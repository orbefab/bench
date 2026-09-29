/**
 * Undo buttons follow the server. Each `edited` answer names one part
 * and, when present, every open part history. A local stack only
 * remembers which part to ask next, and it is trimmed to those flags.
 */

export type PartHistory = {
  /** Absent for the open document. */
  part?: string;
  canUndo: boolean;
  canRedo: boolean;
};

export type HistoryAnswer = {
  part?: string;
  canUndo: boolean;
  canRedo: boolean;
  histories?: readonly PartHistory[];
};

export type HistoryModel = {
  /** Most recent undo target first. "" is the open document. */
  undoOrder: string[];
  redoOrder: string[];
  parts: PartHistory[];
};

export type HistoryButtons = {
  canUndo: boolean;
  canRedo: boolean;
  /** Set when the next undo names a nested part. */
  undoPart?: string;
  redoPart?: string;
};

export function emptyHistory(): HistoryModel {
  return { undoOrder: [], redoOrder: [], parts: [] };
}

export function partKey(part?: string): string {
  return part ?? "";
}

export function sameHistory(a: HistoryModel, b: HistoryModel): boolean {
  if (a === b) return true;
  if (
    a.undoOrder.length !== b.undoOrder.length ||
    a.redoOrder.length !== b.redoOrder.length ||
    a.parts.length !== b.parts.length
  ) {
    return false;
  }
  for (let i = 0; i < a.undoOrder.length; i++) {
    if (a.undoOrder[i] !== b.undoOrder[i]) return false;
  }
  for (let i = 0; i < a.redoOrder.length; i++) {
    if (a.redoOrder[i] !== b.redoOrder[i]) return false;
  }
  for (let i = 0; i < a.parts.length; i++) {
    const left = a.parts[i];
    const right = b.parts[i];
    if (!left || !right) return false;
    if (
      partKey(left.part) !== partKey(right.part) ||
      left.canUndo !== right.canUndo ||
      left.canRedo !== right.canRedo
    ) {
      return false;
    }
  }
  return true;
}

export function applyHistory(
  model: HistoryModel,
  answer: HistoryAnswer
): HistoryModel {
  const parts = replacePart(
    answer.histories
      ? answer.histories.map((row) => ({ ...row }))
      : model.parts.map((row) => ({ ...row })),
    {
      ...(answer.part ? { part: answer.part } : {}),
      canUndo: answer.canUndo,
      canRedo: answer.canRedo,
    }
  );
  const touched = partKey(answer.part);
  return {
    parts,
    undoOrder: orderOf(
      model.undoOrder,
      parts,
      "canUndo",
      touched,
      answer.canUndo
    ),
    redoOrder: orderOf(
      model.redoOrder,
      parts,
      "canRedo",
      touched,
      answer.canRedo
    ),
  };
}

/** The server refused this undo or redo. That part can no longer do it. */
export function refuseHistory(
  model: HistoryModel,
  kind: "undo" | "redo",
  part?: string
): HistoryModel {
  const existing = model.parts.find(
    (row) => partKey(row.part) === partKey(part)
  );
  return applyHistory(model, {
    ...(part ? { part } : {}),
    canUndo: kind === "undo" ? false : (existing?.canUndo ?? false),
    canRedo: kind === "redo" ? false : (existing?.canRedo ?? false),
  });
}

/**
 * Replace flags with the server's list and keep the local order for
 * parts that can still undo or redo. A reconnect has no "just edited"
 * part, so nothing is moved to the front.
 */
export function syncHistories(
  model: HistoryModel,
  rows: readonly PartHistory[]
): HistoryModel {
  const parts = rows.map((row) => ({ ...row }));
  const undoAllowed = new Set(
    parts.filter((row) => row.canUndo).map((row) => partKey(row.part))
  );
  const redoAllowed = new Set(
    parts.filter((row) => row.canRedo).map((row) => partKey(row.part))
  );
  return {
    parts,
    undoOrder: mergeOrder(model.undoOrder, undoAllowed),
    redoOrder: mergeOrder(model.redoOrder, redoAllowed),
  };
}

function mergeOrder(
  previous: readonly string[],
  allowed: Set<string>
): string[] {
  const next = previous.filter((key) => allowed.has(key));
  for (const key of allowed) {
    if (!next.includes(key)) next.push(key);
  }
  return next;
}

export function historyButtons(model: HistoryModel): HistoryButtons {
  const undoKey = model.undoOrder[0];
  const redoKey = model.redoOrder[0];
  return {
    canUndo: undoKey !== undefined,
    canRedo: redoKey !== undefined,
    ...(undoKey ? { undoPart: undoKey } : {}),
    ...(redoKey ? { redoPart: redoKey } : {}),
  };
}

function replacePart(parts: PartHistory[], next: PartHistory): PartHistory[] {
  const key = partKey(next.part);
  const kept = parts.filter((row) => partKey(row.part) !== key);
  kept.push(next);
  return kept;
}

function orderOf(
  previous: readonly string[],
  parts: readonly PartHistory[],
  flag: "canUndo" | "canRedo",
  touched: string,
  touchedOn: boolean
): string[] {
  const allowed = new Set(
    parts.filter((row) => row[flag]).map((row) => partKey(row.part))
  );
  const next = previous.filter((key) => allowed.has(key) && key !== touched);
  if (touchedOn && allowed.has(touched)) next.unshift(touched);
  for (const key of allowed) {
    if (!next.includes(key)) next.push(key);
  }
  return next;
}
