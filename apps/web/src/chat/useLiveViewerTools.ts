import type { ChatAddToolOutputFunction } from "ai";
import { useEffect, useRef } from "react";

import { viewerSnapshot } from "@/cad/viewer-snapshot";
import {
  findPendingGetViewer,
  GET_VIEWER_TOOL,
  getViewerFillReady,
  latestShownArtifact,
  shownFromPart,
  viewerIsReady,
} from "@/chat/get-viewer";
import type { GalleryChatMessage } from "@/components/chat/mock-chat-messages";
import { viewerStore } from "@/state/viewer";
import { worldStore } from "@/state/world";

function lastAssistantHasPendingTools(messages: GalleryChatMessage[]) {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant") return false;
  for (const part of last.parts ?? []) {
    if (!part || typeof part !== "object") continue;
    const row = part as { type?: string; state?: string };
    const toolish =
      row.type === "dynamic-tool" ||
      (typeof row.type === "string" && row.type.startsWith("tool-"));
    if (!toolish) continue;
    if (row.state === "input-available" || row.state === "input-streaming")
      return true;
  }
  return false;
}

function documentReady(target: string | null): boolean {
  const world = worldStore.getState();
  if (world.path) return world.connection !== "connecting";
  return viewerIsReady(viewerStore.getState(), target);
}

function waitUntilReady(
  target: string | null,
  isCancelled: () => boolean
): Promise<void> {
  if (isCancelled() || documentReady(target)) return Promise.resolve();
  return new Promise((resolve) => {
    let viewerUnsub = () => {};
    let worldUnsub = () => {};
    const finish = () => {
      if (!isCancelled() && !documentReady(target)) return;
      viewerUnsub();
      worldUnsub();
      resolve();
    };
    viewerUnsub = viewerStore.subscribe(finish);
    worldUnsub = worldStore.subscribe(finish);
    finish();
  });
}

/** Load show_artifact on this client, then fill a pending get_viewer from this tab's scene. */
export function useLiveViewerTools(
  messages: GalleryChatMessage[],
  addToolOutput: ChatAddToolOutputFunction<GalleryChatMessage>,
  streaming: boolean,
  onFilled?: () => void | Promise<void>
) {
  const seen = useRef(new Set<string>());
  const inFlight = useRef<string | null>(null);
  const onFilledRef = useRef(onFilled);
  onFilledRef.current = onFilled;

  useEffect(() => {
    const applyShows = streaming || lastAssistantHasPendingTools(messages);
    if (applyShows) {
      for (const message of messages) {
        (message.parts ?? []).forEach((part, index) => {
          const shown = shownFromPart(
            part as Parameters<typeof shownFromPart>[0],
            index,
            message.id
          );
          if (!shown || seen.current.has(shown.key)) return;
          seen.current.add(shown.key);
          void viewerStore
            .getState()
            .loadModel(shown.file, { history: "push" });
        });
      }
    }

    const pending = findPendingGetViewer(messages);
    // Wait until this turn's stream has released the folder lock. Filling
    // as soon as the tool part arrives posts the continuation too early.
    if (!getViewerFillReady({ pending: pending !== null, streaming })) {
      return;
    }
    if (!pending) return;

    const target = latestShownArtifact(messages);
    if (
      target &&
      viewerStore.getState().url !== target &&
      !worldStore.getState().path
    ) {
      void viewerStore.getState().loadModel(target, { history: "push" });
    }

    if (inFlight.current === pending.toolCallId) return;
    inFlight.current = pending.toolCallId;
    let cancelled = false;

    void (async () => {
      await waitUntilReady(target, () => cancelled);
      if (cancelled) return;
      await addToolOutput({
        tool: GET_VIEWER_TOOL,
        toolCallId: pending.toolCallId,
        output: viewerSnapshot(),
      });
      await onFilledRef.current?.();
    })();

    return () => {
      cancelled = true;
      if (inFlight.current === pending.toolCallId) inFlight.current = null;
    };
  }, [addToolOutput, messages, streaming]);
}
