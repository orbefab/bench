import type { ProjectRow } from "@sfab-bench/contract";

import { jsonApi } from "@/lib/api";
import { projectUrl, syncProjectQuery } from "@/lib/project-query";

export type ProjectInfo = {
  project: ProjectRow | null;
  recents: ProjectRow[];
  fileRecents?: string[];
  revision: number;
};

export type BrowseInfo = {
  path: string;
  parent: string | null;
  dirs: { name: string; path: string }[];
};

export async function fetchProject(): Promise<ProjectInfo> {
  const res = await jsonApi.project.$get();
  if (!res.ok) throw new Error("Could not load project");
  return (await res.json()) as ProjectInfo;
}

export async function openProjectPath(path: string): Promise<ProjectInfo> {
  const res = await jsonApi.project.$post({ json: { path } });
  const body = (await res.json()) as ProjectInfo & { error?: string };
  if (!res.ok) throw new Error(body.error || "Could not open that folder");
  return body;
}

/** Register on the Mac (loopback) and point this tab at that folder. */
export async function registerAndOpenTab(path: string): Promise<ProjectInfo> {
  const info = await openProjectPath(path);
  const abs = info.project?.path ?? path.trim();
  syncProjectQuery(abs);
  return info;
}

/** Point this tab at a folder already in recents. No POST. */
export function openTabProject(path: string) {
  syncProjectQuery(path);
}

/** Leave the folder. Back to Welcome. */
export function closeTabProject() {
  syncProjectQuery("");
}

export function folderName(path: string) {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/** `/Users/you/src/foo` → `~/src/foo` — the usual Mac recents line. */
export function shortPath(path: string) {
  const home = path.match(/^\/Users\/[^/]+/);
  if (home && path.length > home[0].length)
    return `~${path.slice(home[0].length)}`;
  return path;
}

export async function browsePath(path?: string): Promise<BrowseInfo> {
  const res = await jsonApi.browse.$get(path ? { query: { path } } : {});
  const body = (await res.json()) as BrowseInfo & { error?: string };
  if (!res.ok) throw new Error(body.error || "Could not browse");
  return body;
}
