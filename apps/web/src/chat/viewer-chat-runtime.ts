import { DefaultChatTransport } from "ai";

import { viewerSnapshot } from "@/cad/viewer-snapshot";
import { apiFetch, authHeaders } from "@/lib/api";
import { prefsStore } from "@/state/prefs";

export function viewerChatTransport() {
  return new DefaultChatTransport({
    api: "/api/chat",
    fetch: apiFetch,
    headers: () => authHeaders(),
    body: () => {
      const viewer = viewerSnapshot();
      return {
        viewerFile: viewer.file,
        viewer,
        harness: prefsStore.getState().chatHarness,
        model: prefsStore.getState().chatModel,
        effort: prefsStore.getState().chatEffort,
      };
    },
  });
}
