import { catalogAncestors } from "@sfab-bench/contract";
import { useState } from "react";
import { loadExpandedDirs, saveExpandedDirs } from "@/lib/files-rail";

export function useFileTreeExpansion(projectPath: string, current: string) {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const stored = loadExpandedDirs(projectPath);
    if (stored) return new Set(stored);
    return new Set(catalogAncestors(current));
  });

  const persist = (next: Set<string>) => {
    saveExpandedDirs(projectPath, [...next]);
  };

  const toggle = (path: string, nextOpen: boolean) => {
    const copy = new Set(expanded);
    if (nextOpen) copy.add(path);
    else copy.delete(path);
    setExpanded(copy);
    persist(copy);
  };

  const collapseAll = () => {
    const empty = new Set<string>();
    setExpanded(empty);
    persist(empty);
  };

  return { expanded, toggle, collapseAll };
}
