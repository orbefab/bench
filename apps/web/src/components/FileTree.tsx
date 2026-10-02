import {
  ChevronRight,
  EllipsisVertical,
  FileBox,
  Folder,
  Globe,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import { showToast } from "@/components/ui/toast";
import { useFileTreeExpansion } from "@/hooks/useFileTreeExpansion";
import { type CatalogKindFilter, catalogEmptyReason } from "@/lib/files-rail";
import { displayLoadError } from "@/lib/load-copy";
import { copyText } from "@/lib/settings";
import { cn } from "@/lib/utils";
import {
  type CatalogEntry,
  type CatalogNode,
  catalogDirPaths,
  catalogNodeCount,
  catalogSections,
  catalogTree,
  filterCatalogTree,
} from "@/lib/viewer-snapshot";

function fileName(path: string) {
  return path.split("/").filter(Boolean).pop() ?? path;
}

async function copyRelativePath(path: string) {
  const ok = await copyText(path);
  if (ok) showToast({ type: "success", title: "Copied" });
  else showToast({ type: "error", title: "Couldn't copy path" });
}

function CopyPathItem({ path, onDone }: { path: string; onDone?: () => void }) {
  return (
    <button
      type="button"
      className="flex w-full rounded-md px-2 py-1.5 text-left text-sm text-popover-foreground hover:bg-accent"
      onClick={() => {
        void copyRelativePath(path).then(() => onDone?.());
      }}
    >
      Copy relative path
    </button>
  );
}

function FileRow({
  node,
  current,
  onPick,
  nested,
}: {
  node: Extract<CatalogNode, { type: "file" }>;
  current: string;
  onPick: (path: string) => void;
  nested: boolean;
}) {
  const [actionsOpen, setActionsOpen] = useState(false);
  const active = node.path === current;
  const name = node.name || fileName(node.path);
  const world = node.kind === "world";
  const inner = (
    <>
      {world ? (
        <Globe className="text-sidebar-foreground" />
      ) : (
        <FileBox className="text-sidebar-foreground" />
      )}
      <span className="min-w-0 flex-1 truncate text-sidebar-foreground">
        {name}
      </span>
      {world ? (
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-sidebar-foreground/60">
          World
        </span>
      ) : null}
    </>
  );
  const shared = {
    isActive: active,
    title: world ? `World · ${node.path}` : node.path,
    onClick: () => onPick(node.path),
    className: "pr-8 text-sidebar-foreground [&>svg]:text-sidebar-foreground",
  };
  const Item = nested ? SidebarMenuSubItem : SidebarMenuItem;
  return (
    <Item>
      {nested ? (
        <SidebarMenuSubButton {...shared}>{inner}</SidebarMenuSubButton>
      ) : (
        <SidebarMenuButton {...shared}>{inner}</SidebarMenuButton>
      )}
      <Popover open={actionsOpen} onOpenChange={setActionsOpen}>
        <PopoverTrigger
          render={
            <SidebarMenuAction
              showOnHover
              title="File actions"
              aria-label="File actions"
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
            />
          }
        >
          <EllipsisVertical />
        </PopoverTrigger>
        <PopoverContent align="end" side="bottom" className="w-48 p-1">
          <CopyPathItem path={node.path} onDone={() => setActionsOpen(false)} />
        </PopoverContent>
      </Popover>
    </Item>
  );
}

function Tree({
  node,
  current,
  expanded,
  toggle,
  onPick,
  nested,
}: {
  node: CatalogNode;
  current: string;
  expanded: Set<string>;
  toggle: (path: string, next: boolean) => void;
  onPick: (path: string) => void;
  nested: boolean;
}) {
  if (node.type === "file") {
    return (
      <FileRow node={node} current={current} onPick={onPick} nested={nested} />
    );
  }

  const open = expanded.has(node.path);
  const count = catalogNodeCount(node);
  const Item = nested ? SidebarMenuSubItem : SidebarMenuItem;
  return (
    <Item>
      <Collapsible
        className="group/collapsible w-full min-w-0 [&[data-open]>button>svg:first-child]:rotate-90"
        open={open}
        onOpenChange={(next) => toggle(node.path, next)}
      >
        <CollapsibleTrigger className="flex h-8 w-full min-w-0 items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring [&>svg]:size-4 [&>svg]:shrink-0">
          <ChevronRight className="shrink-0 transition-transform" />
          <Folder className="shrink-0" />
          <span className="min-w-0 flex-1 truncate" title={node.name}>
            {node.name}
          </span>
          <span className="ml-auto shrink-0 tabular-nums text-xs text-sidebar-foreground/70">
            {count}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {node.children.map((child) => (
              <Tree
                key={child.type === "dir" ? `d:${child.path}` : child.path}
                node={child}
                current={current}
                expanded={expanded}
                toggle={toggle}
                onPick={onPick}
                nested
              />
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </Collapsible>
    </Item>
  );
}

function KindChips({
  kind,
  onKind,
}: {
  kind: CatalogKindFilter;
  onKind: (next: CatalogKindFilter) => void;
}) {
  return (
    <div className="flex gap-1 px-2 pb-1">
      {(
        [
          ["all", "All"],
          ["step", "STEP"],
          ["glb", "GLB"],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          className={cn(
            "rounded-md px-1.5 py-0.5 text-[11px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
            kind === id
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "text-sidebar-foreground/60 hover:text-sidebar-foreground"
          )}
          onClick={() => onKind(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function EmptyHint({
  children,
  action,
  onAction,
}: {
  children: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <p className="px-2 py-1 text-xs text-muted-foreground">
      {children}{" "}
      <button
        type="button"
        className="font-medium text-sidebar-foreground hover:underline"
        onClick={onAction}
      >
        {action}
      </button>
    </p>
  );
}

export function FileTree({
  files,
  current,
  filter,
  projectPath,
  recents,
  error,
  ready,
  onPick,
  onClearSearch,
}: {
  files: CatalogEntry[];
  current: string;
  filter: string;
  projectPath: string;
  recents?: string[];
  error?: string | null;
  ready?: boolean;
  onPick: (path: string) => void;
  onClearSearch: () => void;
}) {
  const [kind, setKind] = useState<CatalogKindFilter>("all");
  const listed = useMemo(
    () => (kind === "all" ? files : files.filter((file) => file.kind === kind)),
    [files, kind]
  );
  const tree = useMemo(
    () => filterCatalogTree(catalogTree(listed), filter),
    [listed, filter]
  );
  const recentRows = useMemo(
    () =>
      filter.trim() || kind !== "all"
        ? []
        : catalogSections(files, recents ?? []).recents,
    [files, recents, filter, kind]
  );
  const { expanded, toggle, collapseAll } = useFileTreeExpansion(
    projectPath,
    current
  );

  const dirs = catalogDirPaths(tree);
  const empty = catalogEmptyReason({
    fileCount: files.length,
    listedCount: listed.length,
    treeCount: tree.length,
    kind,
  });

  if (error) {
    return (
      <div className="px-4 py-2 text-xs text-error">
        {displayLoadError(error, projectPath)}
      </div>
    );
  }
  if (!ready) {
    return (
      <div className="px-4 py-2 text-xs text-muted-foreground">
        Loading files…
      </div>
    );
  }
  if (empty.type === "no-cad") {
    return (
      <div className="px-4 py-2 text-xs text-muted-foreground">
        No STEP or GLB in this folder.
      </div>
    );
  }

  return (
    <>
      {recentRows.length > 0 ? (
        <SidebarGroup>
          <SidebarGroupLabel>Recent</SidebarGroupLabel>
          <SidebarGroupContent className="max-h-48 overflow-y-auto">
            <SidebarMenu>
              {recentRows.map((row) => (
                <FileRow
                  key={`recent-${row.path}`}
                  node={{
                    type: "file",
                    name: fileName(row.path),
                    path: row.path,
                    kind: row.kind,
                    entry: row,
                  }}
                  current={current}
                  onPick={onPick}
                  nested={false}
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ) : null}
      <SidebarGroup>
        <SidebarGroupLabel>Files</SidebarGroupLabel>
        <KindChips kind={kind} onKind={setKind} />
        {dirs.length > 0 ? (
          <SidebarGroupAction
            title="Collapse all"
            aria-label="Collapse all"
            onClick={collapseAll}
          >
            <ChevronRight className="rotate-90" />
          </SidebarGroupAction>
        ) : null}
        <SidebarGroupContent>
          {empty.type === "kind" ? (
            <EmptyHint action="Show all" onAction={() => setKind("all")}>
              {empty.kind === "glb"
                ? "No GLB in this folder."
                : "No STEP in this folder."}
            </EmptyHint>
          ) : null}
          {empty.type === "search" ? (
            <EmptyHint action="Clear search" onAction={onClearSearch}>
              No files match.
            </EmptyHint>
          ) : null}
          {empty.type === "ready" ? (
            <SidebarMenu>
              {tree.map((node) => (
                <Tree
                  key={node.type === "dir" ? `d:${node.path}` : node.path}
                  node={node}
                  current={current}
                  expanded={expanded}
                  toggle={toggle}
                  onPick={onPick}
                  nested={false}
                />
              ))}
            </SidebarMenu>
          ) : null}
        </SidebarGroupContent>
      </SidebarGroup>
    </>
  );
}
