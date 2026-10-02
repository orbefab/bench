import {
  applyHistory,
  refuseHistory,
  sameHistory,
  syncHistories,
} from "@/lib/world-history";
import type { WorldSlice } from "./types";

/** Server undo flags, the last edit's label and refusal, and the confirm dialog. */
export const historySlice: WorldSlice<
  | "setEditError"
  | "setConfirm"
  | "applyHistory"
  | "refuseHistory"
  | "replaceHistory"
  | "syncHistory"
> = (set, get) => ({
  setEditError: (message) => {
    if (get().editError === message) return;
    set({ editError: message });
  },
  setConfirm: (confirm) => {
    set({ confirm });
  },
  applyHistory: (answer, label) => {
    const history = applyHistory(get().history, answer);
    const current = get();
    if (
      sameHistory(current.history, history) &&
      current.editLabel === label &&
      current.editError === null &&
      current.confirm === null
    ) {
      return;
    }
    set({ history, editLabel: label, editError: null, confirm: null });
  },
  refuseHistory: (kind, part) => {
    set({ history: refuseHistory(get().history, kind, part) });
  },
  replaceHistory: (history) => {
    if (sameHistory(get().history, history)) return;
    set({ history, editLabel: null, editError: null, confirm: null });
  },
  syncHistory: (rows) => {
    if (!rows) return;
    const history = syncHistories(get().history, rows);
    if (sameHistory(get().history, history)) return;
    set({ history });
  },
});
