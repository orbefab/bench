import type { ProjectRow } from "@sfab-bench/contract";
import { Folder, Plus } from "lucide-react";
import { useEffect, useState } from "react";

import type { OpenFolderApi } from "@/components/OpenFolder";
import { homeFolderList, homeOpenFolderCard } from "@/lib/home-projects";
import { fetchProject, folderName } from "@/lib/project";
import { redact } from "@/lib/redact";
import { useStudioNav } from "@/state/studio-nav";

export function HomeProjects({
  path,
  folder,
}: {
  path: string;
  folder: OpenFolderApi;
}) {
  const showStudio = useStudioNav((state) => state.showStudio);
  const [rows, setRows] = useState<ProjectRow[]>([]);
  const [currentName, setCurrentName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchProject()
      .then((info) => {
        if (cancelled) return;
        setRows(info.recents);
        setCurrentName(info.project?.name ?? "");
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          redact(err instanceof Error ? err.message : "Could not load folders")
        );
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const projects = homeFolderList(
    path ? { path, name: currentName || folderName(path) } : null,
    rows
  );
  const openCard = homeOpenFolderCard(folder.canRegister);

  const open = (next: string) => {
    if (next === path) {
      showStudio();
      return;
    }
    folder.pickRecent(next);
  };

  return (
    <div
      data-slot="project-grid"
      className="min-h-0 flex-1 overflow-auto bg-background px-6 py-8"
    >
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        <div className="space-y-1">
          <h1 className="font-medium text-lg">Projects</h1>
          <p className="text-muted-foreground text-sm">
            Open a project, or choose a folder.
          </p>
        </div>
        {error ? <p className="text-error text-xs">{error}</p> : null}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <button
              key={project.path}
              type="button"
              data-slot="project-card"
              className="flex h-28 flex-col items-start justify-between rounded-xl border border-border bg-card p-4 text-left shadow-sm hover:bg-accent"
              title={project.path}
              onClick={() => open(project.path)}
            >
              <Folder className="size-4 text-muted-foreground" />
              <span className="w-full truncate font-medium text-sm">
                {project.name}
              </span>
            </button>
          ))}
          {openCard ? (
            <button
              type="button"
              data-slot="project-card"
              aria-label="Open folder"
              className="flex h-28 flex-col items-start justify-between rounded-xl border border-border border-dashed bg-card p-4 text-left text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => void folder.requestOpen()}
            >
              <Plus className="size-4" />
              <span className="font-medium text-sm">Open folder</span>
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
