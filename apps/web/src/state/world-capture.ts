/**
 * The open world's capture job. One per world, so one store. The socket
 * layer calls `noteCaptureMessage`; the card and the bar read it.
 */

import type { CaptureAxisName } from "@sfab-bench/contract";
import { useStore as useZustandStore } from "zustand";
import { createStore } from "zustand/vanilla";

import { showToast } from "@/components/ui/toast";
import {
  abortWorldCapture,
  sendWorldCapture,
  type WorldCaptureHandlers,
} from "@/hooks/useWorldRun";
import {
  beginCapture,
  CAPTURE_ABORTED,
  type CaptureMessage,
  type CaptureState,
  capturedLabel,
  IDLE_CAPTURE,
  settleCapture,
  takeCaptureMessage,
} from "@/lib/world-capture";
import { setLevelOp } from "@/lib/world-ops";
import { worldStore } from "@/state/world";
import { commitEdit } from "@/state/world-edit";

export const captureStore = createStore<CaptureState>()(() => IDLE_CAPTURE);

export function useCapture<T>(selector: (state: CaptureState) => T): T {
  return useZustandStore(captureStore, selector);
}

/** Capture the part at `path`. The part need not be open. */
export function startWorldCapture(path: string, axis: CaptureAxisName) {
  if (captureStore.getState().phase === "running") return;
  const nonce = sendWorldCapture(path, axis);
  if (!nonce) return;
  captureStore.setState(
    beginCapture(captureStore.getState(), { nonce, path, axis }),
    true
  );
}

export function stopWorldCapture() {
  const state = captureStore.getState();
  if (state.phase === "running") abortWorldCapture(state.nonce);
}

/** The selection moved: a failure or landing is over; a running job is not. */
export function settleWorldCapture() {
  const next = settleCapture(captureStore.getState());
  if (next !== captureStore.getState()) captureStore.setState(next, true);
}

function noteCaptureMessage(message: CaptureMessage) {
  const before = captureStore.getState();
  const after = takeCaptureMessage(before, message);
  if (after === before) return;
  captureStore.setState(after, true);
  if (after.phase === "landed") {
    const landed = after;
    showToast({
      type: "success",
      title: `Captured ${capturedLabel(landed)}: use it?`,
      action: {
        label: "Use it",
        onClick: () => {
          const op = setLevelOp(
            worldStore.getState().path,
            landed.path,
            landed.axis,
            {
              class: landed.level as 0 | 1 | 2 | 3,
              variant: landed.variant,
              runnable: true,
              chosen: false,
            }
          );
          if (op) commitEdit([op]);
        },
      },
    });
    return;
  }
  if (after.phase !== "failed") return;
  if (after.message === CAPTURE_ABORTED) {
    showToast({ type: "info", title: "Capture stopped" });
    return;
  }
  showToast({
    type: "error",
    title: "Capture failed",
    description: after.message,
  });
}

export const worldCaptureHandlers: WorldCaptureHandlers = {
  message: noteCaptureMessage,
  reset: () => captureStore.setState(IDLE_CAPTURE, true),
};
