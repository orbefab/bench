/**
 * Capture from the card, as the client sees it. Pure: the socket layer
 * feeds it messages, and the card and the under-stage bar read it. It is
 * keyed by nonce, so a message for another job is ignored.
 */

import type {
  CaptureAxisName,
  LevelClass,
  WorldServerMessage,
  WorldViewLevelAxis,
  WorldViewLevelOption,
  WorldViewLevelSource,
  WorldViewNode,
  WorldViewPartSource,
} from "@sfab-bench/contract";

/** The message the server sends when the owner aborted. */
export const CAPTURE_ABORTED = "aborted";

export type CaptureState =
  | { phase: "idle" }
  | {
      phase: "running";
      nonce: string;
      path: string;
      axis: CaptureAxisName;
      done: number;
      total: number;
      label: string;
    }
  | {
      phase: "landed";
      nonce: string;
      path: string;
      axis: CaptureAxisName;
      level: LevelClass;
      variant: string;
      ref: string;
    }
  | {
      phase: "failed";
      nonce: string;
      path: string;
      axis: CaptureAxisName;
      message: string;
    };

export type CaptureMessage = Extract<
  WorldServerMessage,
  { type: "capture-progress" | "captured" | "capture-failed" }
>;

export const IDLE_CAPTURE: CaptureState = { phase: "idle" };

export function isCaptureMessage(
  message: WorldServerMessage
): message is CaptureMessage {
  return (
    message.type === "capture-progress" ||
    message.type === "captured" ||
    message.type === "capture-failed"
  );
}

/** The user pressed Capture. A capture already running keeps its place. */
export function beginCapture(
  state: CaptureState,
  request: { nonce: string; path: string; axis: CaptureAxisName }
): CaptureState {
  if (state.phase === "running") return state;
  return { phase: "running", ...request, done: 0, total: 0, label: "" };
}

/** Only a message for the running job's nonce changes anything. */
export function takeCaptureMessage(
  state: CaptureState,
  message: CaptureMessage
): CaptureState {
  if (state.phase !== "running" || message.nonce !== state.nonce) return state;
  if (message.type === "capture-progress") {
    return {
      ...state,
      done: message.done,
      total: message.total,
      label: message.label,
    };
  }
  if (message.type === "captured") {
    return {
      phase: "landed",
      nonce: state.nonce,
      path: message.path,
      axis: message.axis,
      level: message.level,
      variant: message.variant,
      ref: message.ref,
    };
  }
  return {
    phase: "failed",
    nonce: state.nonce,
    path: state.path,
    axis: state.axis,
    message: message.message,
  };
}

/** A failure or a landing is over once the selection changes; a run is not. */
export function settleCapture(state: CaptureState): CaptureState {
  return state.phase === "running" ? state : IDLE_CAPTURE;
}

/** Why Capture is off for this axis, or null when it can run. */
export function captureDisabledReason(
  state: CaptureState,
  axis: Pick<WorldViewLevelAxis, "capture">
): string | null {
  if (!axis.capture) return "this axis cannot be captured";
  if (!axis.capture.ready) return axis.capture.reason;
  if (state.phase === "running") return "a capture is running";
  return null;
}

/** The card's error block. An abort is not an error. */
export function captureFailure(
  state: CaptureState,
  path: string
): string | null {
  if (state.phase !== "failed" || state.path !== path) return null;
  return state.message === CAPTURE_ABORTED ? null : state.message;
}

export type CaptureProgress = {
  label: string;
  done: number;
  total: number;
  /** 0 to 1. Zero until the first step names a total. */
  fraction: number;
};

export function captureProgress(state: CaptureState): CaptureProgress | null {
  if (state.phase !== "running") return null;
  const fraction =
    state.total > 0 ? Math.min(1, Math.max(0, state.done / state.total)) : 0;
  return {
    label: state.label || "Capturing",
    done: state.done,
    total: state.total,
    fraction,
  };
}

/** Instance name and the new level, for the toast: `power capture-1`. */
export function capturedLabel(
  landed: Extract<CaptureState, { phase: "landed" }>
): string {
  const name = landed.path.slice(landed.path.lastIndexOf(".") + 1);
  return `${name} ${landed.variant}`;
}

const SOURCE_WORDS: Record<WorldViewLevelSource, string> = {
  part: "Defined in the part file.",
  snapshot: "A captured snapshot stored with the part.",
  overlay:
    "Added by this project's level overlay. The library part is unchanged.",
};

/** The short word and its tooltip for an option's source. Null when the view names none. */
export function levelSourceWords(
  source: WorldViewLevelSource | undefined
): { word: string; title: string } | null {
  return source ? { word: source, title: SOURCE_WORDS[source] } : null;
}

/**
 * Only a capture can be deleted: an overlay variant, or a snapshot in a
 * project part. A level the part document defines is not one, and a
 * library part's own snapshot is read-only.
 */
export function levelDeletable(
  nodeSource: WorldViewPartSource | undefined,
  option: Pick<WorldViewLevelOption, "source">
): boolean {
  if (option.source === "overlay") return true;
  return option.source === "snapshot" && nodeSource === "project";
}

/**
 * Where a capture edit goes, as the capture job lands it: a project
 * part on its own document session, a library part through the open
 * document (its overlay).
 */
export function captureEditTarget(
  node: Pick<WorldViewNode, "part" | "source">,
  openDocument: string
): { document: string; part: string; session?: string } {
  const own = node.source === "project";
  return {
    document: own ? node.part : openDocument,
    part: node.part,
    ...(own ? { session: node.part } : {}),
  };
}
