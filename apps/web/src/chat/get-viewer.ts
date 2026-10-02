import {
  type DynamicToolUIPart,
  getToolName,
  isToolUIPart,
  type ToolUIPart,
} from "ai";

export const GET_VIEWER_TOOL = "get_viewer";
export const SHOW_ARTIFACT_TOOL = "show_artifact";

export type ShownArtifact = { key: string; file: string };

function partToolName(part: {
  type: string;
  toolName?: string;
}): string | null {
  if (typeof part.toolName === "string" && part.toolName) return part.toolName;
  if (part.type === "dynamic-tool") {
    return getToolName(part as DynamicToolUIPart);
  }
  if (part.type.startsWith("tool-")) return part.type.slice(5);
  if (isToolUIPart(part as ToolUIPart)) return getToolName(part as ToolUIPart);
  return null;
}

export function isGetViewerPart(part: {
  type: string;
  toolName?: string;
}): boolean {
  return partToolName(part) === GET_VIEWER_TOOL;
}

export function shownFromPart(
  part: {
    type: string;
    toolName?: string;
    toolCallId?: string;
    data?: { file?: unknown };
    output?: unknown;
    state?: string;
  },
  index: number,
  messageId: string
): ShownArtifact | null {
  if (
    part.type === "data-viewer" &&
    part.data &&
    typeof part.data.file === "string" &&
    part.data.file
  ) {
    return {
      key: `${messageId}:viewer:${index}:${part.data.file}`,
      file: part.data.file,
    };
  }
  if (
    partToolName(part) === SHOW_ARTIFACT_TOOL &&
    part.state === "output-available"
  ) {
    const output = part.output as { shown?: unknown } | undefined;
    if (typeof output?.shown === "string" && output.shown) {
      return {
        key: `${messageId}:tool:${part.toolCallId ?? index}`,
        file: output.shown,
      };
    }
  }
  return null;
}

export function latestShownArtifact(
  messages: Array<{ id?: string; parts?: readonly unknown[] }>
): string | null {
  let file: string | null = null;
  for (const message of messages) {
    (message.parts ?? []).forEach((part, index) => {
      if (!part || typeof part !== "object") return;
      const shown = shownFromPart(
        part as Parameters<typeof shownFromPart>[0],
        index,
        message.id ?? ""
      );
      if (shown) file = shown.file;
    });
  }
  return file;
}

/**
 * The server holds the folder lock until the chat stream finishes, and the
 * tool-call bytes are already on the wire by then. A continuation posted
 * while `streaming` is still true gets 409 "a reply is already in progress".
 */
export function getViewerFillReady(input: {
  pending: boolean;
  streaming: boolean;
}): boolean {
  return input.pending && !input.streaming;
}

export function findPendingGetViewer(
  messages: Array<{ role: string; parts?: readonly unknown[] }>
): { toolCallId: string } | null {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant") return null;
  for (const part of last.parts ?? []) {
    if (!part || typeof part !== "object") continue;
    const row = part as {
      type: string;
      toolName?: string;
      state?: string;
      toolCallId?: string;
    };
    if (!isGetViewerPart(row)) continue;
    if (row.state !== "input-available") continue;
    if (!row.toolCallId) continue;
    return { toolCallId: row.toolCallId };
  }
  return null;
}

export type ViewerReadyState = {
  url: string;
  progress: number | null;
};

/** Settled snapshot: nothing in flight, and a requested show has landed (or failed). */
export function viewerIsReady(
  state: ViewerReadyState,
  target: string | null
): boolean {
  if (state.progress !== null) return false;
  if (target && state.url !== target) return false;
  return true;
}
