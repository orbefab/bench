import { useSyncExternalStore } from "react";

export type BoardConsoleEntry =
  | { kind: "out"; text: string }
  | { kind: "sent"; text: string; by: string };

export type BoardTranscript = {
  /** Server ring offset. Trimming the console does not move this. */
  next: number;
  entries: BoardConsoleEntry[];
};

/** Retained console text per board. Older text drops off the front. */
export const CONSOLE_TEXT_CAP = 64 * 1024;

function entryChars(entry: BoardConsoleEntry): string {
  if (entry.kind === "out") return entry.text;
  const line = entry.text.endsWith("\n") ? entry.text : `${entry.text}\n`;
  return `‹ sent by ${entry.by} › ${line}`;
}

/** Drop at least `minDrop` characters, ending on a newline when one follows. */
function dropFront(text: string, minDrop: number): string {
  if (minDrop >= text.length) return "";
  const newline = text.indexOf("\n", minDrop);
  // A newline with nothing after it is the tail, not a boundary to discard.
  if (newline === -1 || newline + 1 >= text.length) return text.slice(minDrop);
  return text.slice(newline + 1);
}

/**
 * Keep at most `cap` characters. Whole leading entries go first. A remaining
 * output chunk is cut on a line boundary when a newline sits at or after the
 * cut. `next` is not an argument: the server offset stays with the caller.
 */
export function boundConsoleEntries(
  entries: readonly BoardConsoleEntry[],
  cap = CONSOLE_TEXT_CAP
): BoardConsoleEntry[] {
  const next = entries.map((entry) => ({ ...entry }));
  let total = next.reduce((sum, entry) => sum + entryChars(entry).length, 0);
  while (next.length > 0 && total > cap) {
    const first = next[0];
    if (!first) break;
    const rendered = entryChars(first);
    const overflow = total - cap;
    if (first.kind === "sent" || rendered.length <= overflow) {
      total -= rendered.length;
      next.shift();
      continue;
    }
    const trimmed = dropFront(first.text, overflow);
    total -= first.text.length - trimmed.length;
    if (!trimmed) next.shift();
    else first.text = trimmed;
    break;
  }
  return next;
}

export type BoardConsoleSnapshot = {
  boards: Record<string, BoardTranscript>;
  /** Rejected send, shown only to the client that sent it. */
  rejects: Record<string, string>;
};

const empty: BoardConsoleSnapshot = { boards: {}, rejects: {} };
let snapshot: BoardConsoleSnapshot = empty;
const listeners = new Set<() => void>();

function emit(next: BoardConsoleSnapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}

function row(board: string): BoardTranscript {
  return snapshot.boards[board] ?? { next: 0, entries: [] };
}

export function resetBoardConsole() {
  if (snapshot === empty) return;
  emit(empty);
}

export function appendBoardSerial(board: string, text: string, next: number) {
  const current = row(board);
  if (next <= current.next) return;
  if (!text) {
    emit({
      ...snapshot,
      boards: { ...snapshot.boards, [board]: { ...current, next } },
    });
    return;
  }
  const grown = current.entries.slice();
  const last = grown[grown.length - 1];
  if (last?.kind === "out") {
    grown[grown.length - 1] = { kind: "out", text: last.text + text };
  } else {
    grown.push({ kind: "out", text });
  }
  const entries = boundConsoleEntries(grown);
  emit({
    ...snapshot,
    boards: {
      ...snapshot.boards,
      [board]: { next, entries },
    },
  });
}

export function noteBoardReject(board: string, message: string) {
  emit({
    ...snapshot,
    rejects: { ...snapshot.rejects, [board]: message },
  });
}

export function clearBoardReject(board: string) {
  if (!snapshot.rejects[board]) return;
  const rejects = { ...snapshot.rejects };
  delete rejects[board];
  emit({ ...snapshot, rejects });
}

export function noteBoardSent(board: string, text: string, by: string) {
  const current = row(board);
  emit({
    ...snapshot,
    boards: {
      ...snapshot.boards,
      [board]: {
        next: current.next,
        entries: boundConsoleEntries([
          ...current.entries,
          { kind: "sent", text, by },
        ]),
      },
    },
  });
}

export function boardConsoleSnapshot(): BoardConsoleSnapshot {
  return snapshot;
}

export function useBoardConsole(): BoardConsoleSnapshot {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    boardConsoleSnapshot,
    boardConsoleSnapshot
  );
}
