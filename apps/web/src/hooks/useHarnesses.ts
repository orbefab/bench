import type { HarnessId, HarnessInfo } from "@sfab-bench/contract";
import { useCallback, useEffect, useState } from "react";
import {
  applyHarnessFetchResult,
  decideHarnessRefetch,
  type HarnessRefreshReason,
  modelShortLabel,
  shouldAcceptHarnessCatalog,
} from "@/chat/model-picker";
import { useProjectSession } from "@/hooks/useProjectSession";
import { apiFetch } from "@/lib/api";
import { projectUrl } from "@/lib/project-query";

export function harnessModelName(
  harnesses: HarnessInfo[],
  harness: HarnessId,
  slug: string
): string {
  const hit = harnesses
    .find((h) => h.id === harness)
    ?.models.find((m) => m.slug === slug);
  return modelShortLabel(slug, hit?.name);
}

let lastGood: { project: string; list: HarnessInfo[] } | null = null;
const inflightByProject = new Map<string, Promise<HarnessInfo[]>>();
let lastStarted: { project: string; at: number } | null = null;

function lastGoodFor(project: string): HarnessInfo[] | undefined {
  return lastGood?.project === project ? lastGood.list : undefined;
}

function parseHarnessList(body: unknown): HarnessInfo[] {
  return Array.isArray((body as { harnesses?: HarnessInfo[] }).harnesses)
    ? (body as { harnesses: HarnessInfo[] }).harnesses
    : [];
}

export function loadHarnesses(): Promise<HarnessInfo[]> {
  const project = projectUrl();
  if (!project) return Promise.resolve([]);
  const pending = inflightByProject.get(project);
  if (pending) return pending;
  lastStarted = { project, at: Date.now() };
  const promise = apiFetch("/api/harnesses", { cache: "no-store" })
    .then((res) =>
      res.ok ? res.json() : Promise.reject(new Error("harnesses"))
    )
    .then((body) => {
      const fetched = parseHarnessList(body);
      const applied = applyHarnessFetchResult({
        ok: true,
        list: fetched,
        lastGood: lastGoodFor(project) ?? null,
      });
      if (shouldAcceptHarnessCatalog(project, projectUrl())) {
        lastGood = { project, list: applied.list };
      }
      return applied.list;
    })
    .catch((err) => {
      const applied = applyHarnessFetchResult({
        ok: false,
        lastGood: lastGoodFor(project) ?? null,
      });
      if (!applied.error && shouldAcceptHarnessCatalog(project, projectUrl())) {
        lastGood = { project, list: applied.list };
      }
      if (shouldAcceptHarnessCatalog(project, projectUrl()) && !applied.error)
        return applied.list;
      throw err;
    })
    .finally(() => {
      if (inflightByProject.get(project) === promise)
        inflightByProject.delete(project);
    });
  inflightByProject.set(project, promise);
  return promise;
}

export function useHarnesses() {
  const project = useProjectSession().project.path;
  const [harnesses, setHarnesses] = useState<HarnessInfo[]>(
    () => lastGoodFor(projectUrl()) ?? []
  );
  const [ready, setReady] = useState(() => Boolean(lastGoodFor(projectUrl())));
  const [error, setError] = useState(false);

  const apply = useCallback((list: HarnessInfo[], failed: boolean) => {
    setHarnesses(list);
    setError(failed);
    setReady(true);
  }, []);

  const refresh = useCallback(
    (reason: HarnessRefreshReason = "retry") => {
      if (!project) {
        setHarnesses([]);
        setReady(true);
        setError(false);
        return;
      }
      const decision = decideHarnessRefetch({
        reason,
        now: Date.now(),
        lastStartedAt: lastStarted?.project === project ? lastStarted.at : null,
        inflight: inflightByProject.has(project),
      });
      if (decision === "skip") return;
      void loadHarnesses()
        .then((list) => {
          if (!shouldAcceptHarnessCatalog(project, projectUrl())) return;
          apply(list, false);
        })
        .catch(() => {
          if (!shouldAcceptHarnessCatalog(project, projectUrl())) return;
          const fallback = lastGoodFor(project) ?? [];
          apply(fallback, fallback.length === 0);
        });
    },
    [apply, project]
  );

  useEffect(() => {
    let cancelled = false;
    const cached = project ? lastGoodFor(project) : undefined;
    if (!project) {
      setHarnesses([]);
      setReady(true);
      setError(false);
    } else if (cached) {
      setHarnesses(cached);
      setError(false);
      setReady(true);
    } else {
      setHarnesses([]);
      setReady(false);
      setError(false);
    }
    refresh("mount");
    const onFocus = () => {
      if (!cancelled) refresh("focus");
    };
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, [project, refresh]);

  return { harnesses, ready, error, refresh };
}
