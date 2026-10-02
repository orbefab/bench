import type { CatalogEntry } from "@sfab-bench/contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { showNetworkErrorToast } from "@/components/ui/toast";
import { useProjectSession } from "@/hooks/useProjectSession";
import { jsonApi } from "@/lib/api";
import {
  INITIAL_FAILURE_STREAK,
  noteFailureStreak,
  suppressNetworkFailureToast,
} from "@/lib/feedback";
import { messageFromHttpBody } from "@/lib/load-copy";
import { LIBRARY_FILES_EVENT, REFRESH_FILES_EVENT } from "@/lib/motion";

export type CatalogState = {
  files: CatalogEntry[];
  revision: number;
  error: string | null;
  ready: boolean;
  refreshing: boolean;
  reload: (opts?: { explicit?: boolean }) => void;
};

export function useCatalog(enabled = true): CatalogState {
  const [files, setFiles] = useState<CatalogEntry[]>([]);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const projectPath = useProjectSession().project.path;
  const streakRef = useRef(INITIAL_FAILURE_STREAK);
  useEffect(() => {
    streakRef.current = INITIAL_FAILURE_STREAK;
  }, [projectPath]);
  const reload = useCallback(
    (opts?: { explicit?: boolean }) => {
      if (!enabled || !projectPath) {
        streakRef.current = INITIAL_FAILURE_STREAK;
        setFiles([]);
        setRevision(0);
        setError(null);
        setReady(true);
        setRefreshing(false);
        return;
      }
      if (opts?.explicit) setRefreshing(true);
      void jsonApi.catalog
        .$get()
        .then(async (res) => {
          if (!res.ok) {
            const text = await res.text();
            throw new Error(
              messageFromHttpBody(
                text,
                res.statusText || "Could not load files"
              )
            );
          }
          return res.json() as Promise<{
            files?: CatalogEntry[];
            revision?: number;
          }>;
        })
        .then((body) => {
          streakRef.current = noteFailureStreak(streakRef.current, true).next;
          setFiles(body.files ?? []);
          setRevision(body.revision ?? 0);
          setError(null);
          setReady(true);
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          const { next, toast } = noteFailureStreak(streakRef.current, false, {
            suppressToast: suppressNetworkFailureToast(),
          });
          streakRef.current = next;
          if (toast) {
            showNetworkErrorToast({
              title: "Couldn't refresh files",
              description: message,
            });
          }
          if (!next.hadSuccess) {
            setError(message);
          }
          setReady(true);
        })
        .finally(() => {
          if (opts?.explicit) setRefreshing(false);
        });
    },
    [enabled, projectPath]
  );
  useEffect(() => {
    if (enabled && projectPath) setReady(false);
  }, [enabled, projectPath]);
  useEffect(() => {
    reload();
    const onProject = () => reload();
    const onRefresh = () => reload({ explicit: true });
    window.addEventListener("sfab-project", onProject);
    window.addEventListener(LIBRARY_FILES_EVENT, onProject);
    window.addEventListener(REFRESH_FILES_EVENT, onRefresh);
    return () => {
      window.removeEventListener("sfab-project", onProject);
      window.removeEventListener(LIBRARY_FILES_EVENT, onProject);
      window.removeEventListener(REFRESH_FILES_EVENT, onRefresh);
    };
  }, [reload]);
  return { files, revision, error, ready, refreshing, reload };
}
