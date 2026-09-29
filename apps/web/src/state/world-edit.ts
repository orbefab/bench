/**
 * The one way a document edit leaves the web. A playing run asks first,
 * because an edit restarts it; a paused or idle run applies at once. Undo
 * and redo do not ask and keep `sendWorldUndo` and `sendWorldRedo`.
 */

import type { EditOp } from "@sfab-bench/contract";
import { useStore as useZustandStore } from "zustand";
import { createStore } from "zustand/vanilla";

import { sendWorldCommand, sendWorldEdit } from "@/hooks/useWorldRun";
import { type ParkChoice, parkGuard, parkOutcome } from "@/lib/world-park";
import { clearPreviews, previewPose } from "@/scene/world-preview";
import { phaseNow } from "@/state/part-tabs";
import { worldStore } from "@/state/world";

export type EditRequest = {
  ops: EditOp[];
  part?: string;
  label?: string;
  /** Run path of the previewed instance, put back on Stay. */
  previewPath?: string;
};

type WorldEditStore = {
  /** The edit a playing run is asking about. */
  pending: EditRequest | null;
  /** Counts Stay choices, so a card field drops the value that was refused. */
  stays: number;
};

export const worldEditStore = createStore<WorldEditStore>()(() => ({
  pending: null,
  stays: 0,
}));

export function useWorldEdit<T>(selector: (state: WorldEditStore) => T): T {
  return useZustandStore(worldEditStore, selector);
}

export type EditOutcome = "asked" | "sent";

/**
 * `confirm` is the answer to a needs-confirm, which was already asked
 * about: it goes out without asking again.
 */
export function commitEdit(
  ops: EditOp[],
  options: {
    part?: string;
    label?: string;
    previewPath?: string;
    confirm?: "break";
  } = {}
): EditOutcome {
  const { confirm, ...request } = options;
  if (!confirm && parkGuard(phaseNow()) === "ask") {
    worldEditStore.setState({ pending: { ops, ...request } });
    return "asked";
  }
  sendWorldEdit({ ops, ...request, ...(confirm ? { confirm } : {}) });
  return "sent";
}

/** Break N: the same operations, with confirm. */
export function breakWorldEdit() {
  const confirm = worldStore.getState().confirm;
  if (!confirm || confirm.ops.length === 0) return;
  commitEdit(confirm.ops, {
    part: confirm.part,
    label: confirm.label,
    confirm: "break",
  });
}

function answer(choice: ParkChoice) {
  const pending = worldEditStore.getState().pending;
  if (!pending) return;
  if (parkOutcome(choice) === "stay") {
    worldEditStore.setState((s) => ({ pending: null, stays: s.stays + 1 }));
    if (pending.previewPath) previewPose(pending.previewPath, null);
    else clearPreviews();
    return;
  }
  worldEditStore.setState({ pending: null });
  sendWorldCommand("pause");
  sendWorldEdit(pending);
}

export function stayPendingEdit() {
  answer("stay");
}

export function stopPendingEdit() {
  answer("stop");
}

export function dropPendingEdit() {
  if (worldEditStore.getState().pending) {
    worldEditStore.setState({ pending: null });
  }
}
