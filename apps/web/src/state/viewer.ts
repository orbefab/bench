import { useStore as useZustandStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { applyHighlights, clearHighlights } from "@/cad/highlights";
import { fileLabel, loadCadReview, modelUrl } from "@/cad/loadCadReview";
import { type CadReview, isAncestor } from "@/cad/review";
import { syncOpenDocument } from "@/lib/document-query";
import { projectUrl } from "@/lib/project-query";
import { invalidateSceneNow } from "@/scene/invalidate";
import { prefsStore } from "@/state/prefs";
import { worldStore } from "@/state/world";

export type Tool = "select" | "measure" | "hide";
export type MeasurePoint = { cadRef: string; point: [number, number, number] };

/**
 * Hover never lives in the store: it changes on every pointer move and only
 * drives material tints, so keeping it here avoids a render per frame.
 */
let hoveredId: number | null = null;
/** Guards against a stale `loadModel` resolving after a newer one started. */
let loadToken = 0;

const apply = (state: Pick<ViewerState, "review" | "selectedId">) => {
  if (state.review) applyHighlights(state.review, state.selectedId, hoveredId);
};

export type ViewerState = {
  url: string;
  title: string;
  review: CadReview | null;
  progress: number | null;
  error: string | null;
  selectedId: number | null;
  pickedRef: string | null;
  /** Source of truth for part visibility; the scene is updated from it. */
  hiddenIds: Set<number>;
  tool: Tool;
  measure: { a: MeasurePoint | null; b: MeasurePoint | null };
  /** True once the user has orbited; blocks the one-shot settled auto-fit. */
  cameraMoved: boolean;
  loadModel: (
    url: string,
    opts?: { history?: "push" | "replace" }
  ) => Promise<void>;
  /** Drop the CAD document without writing the URL. A world open uses this. */
  clearForDocument: () => void;
  setCameraMoved: (moved: boolean) => void;
  select: (id: number | null, cadRef?: string) => void;
  selectByRef: (ref: string | null) => void;
  /**
   * Click-on-model selection: a first click selects the leaf; clicking a part
   * whose selection already covers it walks up one assembly, and from the
   * top-level assembly cycles back to the leaf.
   */
  selectFromModel: (leafId: number, cadRef?: string) => void;
  hover: (id: number | null) => void;
  setVisible: (id: number, visible: boolean) => void;
  isolate: (id: number) => void;
  showAll: () => void;
  setTool: (tool: Tool) => void;
  measureClick: (point: MeasurePoint) => void;
  /** Removes the most recent measure point. */
  undoMeasure: () => void;
  clearMeasure: () => void;
};

const url = projectUrl() ? modelUrl() : "";

function freshView() {
  return {
    selectedId: null as number | null,
    pickedRef: null as string | null,
    hiddenIds: new Set<number>(),
    tool: "select" as const,
    measure: { a: null as MeasurePoint | null, b: null as MeasurePoint | null },
    cameraMoved: false,
  };
}

export const viewerStore = createStore<ViewerState>()((set, get) => ({
  url,
  title: fileLabel(url),
  review: null,
  progress: url ? 0 : null,
  error: null,
  ...freshView(),

  clearForDocument: () => {
    loadToken += 1;
    hoveredId = null;
    clearHighlights();
    set({
      url: "",
      title: fileLabel(""),
      progress: null,
      error: null,
      review: null,
      ...freshView(),
    });
  },

  loadModel: async (next, opts) => {
    const token = ++loadToken;
    clearHighlights();
    hoveredId = null;
    worldStore.getState().close();
    syncOpenDocument(
      next ? { kind: "file", path: next } : { kind: "none" },
      opts?.history ?? "replace"
    );
    if (!next) {
      set({
        url: "",
        title: fileLabel(""),
        progress: null,
        error: null,
        review: null,
        ...freshView(),
      });
      return;
    }
    set({
      url: next,
      title: fileLabel(next),
      progress: 0,
      error: null,
      review: null,
      ...freshView(),
    });
    try {
      const review = await loadCadReview(next, (loaded, total) => {
        if (token === loadToken && total) {
          set({
            progress: Math.min(100, Math.round((loaded / total) * 100)),
          });
        }
      });
      if (token !== loadToken) return;
      const recentFiles = [
        next,
        ...prefsStore.getState().recentFiles.filter((p) => p !== next),
      ];
      set({
        review,
        progress: null,
        hiddenIds: new Set<number>(),
      });
      prefsStore.getState().setRecentFiles(recentFiles);
      apply(get());
    } catch (err: unknown) {
      if (token !== loadToken) return;
      set({
        error: err instanceof Error ? err.message : String(err),
        progress: null,
      });
    }
  },
  setCameraMoved: (moved) => {
    if (get().cameraMoved !== moved) set({ cameraMoved: moved });
  },
  select: (id, cadRef) => {
    const { review } = get();
    if (id === null) {
      set({ selectedId: null, pickedRef: null });
    } else {
      set({
        selectedId: id,
        pickedRef:
          cadRef ??
          review?.parts[id]?.cadRef ??
          review?.parts[id]?.name ??
          null,
      });
    }
    apply(get());
  },
  selectByRef: (ref) => {
    if (!ref) {
      get().select(null);
      return;
    }
    const { review } = get();
    /**
     * Refs come back in the form they went out in, and what goes out is a *face*
     * ref: picking yields `#o1.1.f6`, and `viewerSnapshot` reports that rather than
     * the part. Parts answer to `#o1.1`, so matching the whole string found nothing
     * for every ref the viewer has ever produced — the panel showed the ref while
     * the model highlighted nothing.
     *
     * Selection is per part; the face is kept as the ref, because that is what the
     * detail panel shows and what goes back out to the assistant next time.
     */
    const partRef = ref.replace(/\.f\d+$/, "");
    const part = review?.parts.find((p) => p.cadRef === partRef);
    if (part) get().select(part.id, ref);
    else set({ selectedId: null, pickedRef: ref });
  },
  selectFromModel: (leafId, cadRef) => {
    const { review, selectedId, select } = get();
    const leaf = review?.parts[leafId]?.object;
    const sel =
      selectedId !== null ? review?.parts[selectedId]?.object : undefined;
    if (!review || !leaf || !sel || (sel !== leaf && !isAncestor(sel, leaf))) {
      select(leafId, cadRef);
      return;
    }
    let p = sel.parent;
    while (p && p !== review.root) {
      const part = review.partByObject.get(p);
      if (part) {
        select(part.id);
        return;
      }
      p = p.parent;
    }
    select(leafId, cadRef);
  },
  hover: (id) => {
    if (hoveredId === id) return;
    hoveredId = id;
    apply(get());
    invalidateSceneNow();
  },
  setVisible: (id, visible) => {
    const { review, hiddenIds } = get();
    review?.setPartVisible(id, visible);
    const next = new Set(hiddenIds);
    if (visible) next.delete(id);
    else next.add(id);
    set({ hiddenIds: next });
  },
  isolate: (id) => {
    const { review } = get();
    if (!review) return;
    review.isolate(id);
    set({
      selectedId: id,
      pickedRef: review.parts[id]?.cadRef ?? review.parts[id]?.name ?? null,
      hiddenIds: new Set(
        review.parts
          .filter((part) => !part.object.visible)
          .map((part) => part.id)
      ),
    });
    apply(get());
  },
  showAll: () => {
    const { review } = get();
    if (!review) return;
    review.showAll();
    set({ hiddenIds: new Set<number>() });
  },
  setTool: (tool) =>
    set((s) => ({
      tool,
      measure: tool === "measure" ? s.measure : { a: null, b: null },
    })),
  measureClick: (point) =>
    set((s) => ({
      measure:
        !s.measure.a || s.measure.b
          ? { a: point, b: null }
          : { a: s.measure.a, b: point },
    })),
  undoMeasure: () =>
    set((s) => ({
      measure: s.measure.b ? { a: s.measure.a, b: null } : { a: null, b: null },
    })),
  clearMeasure: () => set({ measure: { a: null, b: null } }),
}));

export function useViewer<T>(selector: (state: ViewerState) => T): T {
  return useZustandStore(viewerStore, selector);
}
