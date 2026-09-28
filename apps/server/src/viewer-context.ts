import { AsyncLocalStorage } from "node:async_hooks";
import type { ViewerSnapshot } from "@sfab-bench/contract";
import { tool } from "ai";
import { z } from "zod";
import { resolveArtifact, shownUrl } from "./cad-pkg";

type ViewerStore = {
  root: string;
  file: string;
  snapshot: ViewerSnapshot;
  show: (file: string) => void;
};

const als = new AsyncLocalStorage<ViewerStore>();

export function runViewerContext<T>(store: ViewerStore, fn: () => Promise<T>) {
  return als.run(store, fn);
}

export function viewerProjectRoot(): string | null {
  return als.getStore()?.root ?? null;
}

export function viewerFileUrl(path: string) {
  const root = als.getStore()?.root;
  if (!root) return { error: "no project open" };
  const resolved = resolveArtifact(path, root);
  if ("error" in resolved) return { error: resolved.error };
  return { shown: shownUrl(resolved) };
}

export const viewerTools = {
  // No execute: the asking client snapshots after tessellation and continues
  // the turn. A server execute would freeze the send-time (often empty) view.
  get_viewer: tool({
    description:
      "What this asking client's visualizer is showing right now: project-relative path, empty, tree names, selected # ref. When a world is open, file is that world and the snapshot includes playing, simTime, and selection — this client's instance path, plus a link when the pick is a link inside a robot, or null. Call after show_artifact if you need the loaded tree.",
    inputSchema: z.object({}),
  }),
  show_artifact: tool({
    description:
      "Show a CAD artifact in the visualizer. Pass a STEP or GLB path relative to the open project folder.",
    inputSchema: z.object({ path: z.string() }),
    execute: async ({ path }) => {
      const resolved = viewerFileUrl(path);
      if ("error" in resolved) return resolved;
      als.getStore()?.show(resolved.shown);
      return { shown: resolved.shown };
    },
  }),
};
